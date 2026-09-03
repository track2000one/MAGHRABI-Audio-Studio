from __future__ import annotations

import asyncio
import copy
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import OUTPUT_SIZES, _atempo_chain, _cleanup, _duration, _has_audio, _probe, _run_ffmpeg, _workspace
from .video_tools_v2 import MAX_AUDIO_FILES, MAX_IMAGE_FILES, MAX_VIDEO_FILES, _save_media, _validate_project
from .video_tools_v3 import _safe_clip, _validate_v3
from .video_tools_v4 import _build_v4_filters, _ramp_speeds, _validate_v4
from .video_tools_v5 import _append_pip_layers, _render_advanced_clip, _validate_v5
from .video_tools_v6 import _append_pip_audio, _validate_v6
from .video_tools_v7 import _apply_master_lut, _save_lut
from .video_tools_v8 import _clip_timeline_starts, _render_eased_keyframed_clip, _validate_v8

router = APIRouter(prefix="/api/video/v9", tags=["video-studio-v9"])
MAX_AUDIO_AUTOMATION_POINTS = 24


def _normalize_automation(raw: object, default_gain: float = 1.0) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_AUDIO_AUTOMATION_POINTS:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى {MAX_AUDIO_AUTOMATION_POINTS} نقاط Audio Automation.")
    points: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="إحدى نقاط Audio Automation غير صالحة.")
        points.append({
            "time": _safe_clip(item.get("time", 0), 0, 1, 0),
            "gain": _safe_clip(item.get("gain", default_gain), 0, 2, default_gain),
        })
    points.sort(key=lambda item: item["time"])
    deduped: list[dict] = []
    for point in points:
        if deduped and abs(point["time"] - deduped[-1]["time"]) < .0005:
            deduped[-1] = point
        else:
            deduped.append(point)
    if deduped and deduped[0]["time"] > .0005:
        deduped.insert(0, {"time": 0.0, "gain": deduped[0]["gain"]})
    if deduped and deduped[-1]["time"] < .9995:
        deduped.append({"time": 1.0, "gain": deduped[-1]["gain"]})
    return deduped


def _validate_v9(project: dict) -> dict:
    for clip in project.get("clips", []):
        clip["audioFadeIn"] = _safe_clip(clip.get("audioFadeIn", 0), 0, 10, 0)
        clip["audioFadeOut"] = _safe_clip(clip.get("audioFadeOut", 0), 0, 10, 0)
        clip["audioAutomation"] = _normalize_automation(clip.get("audioAutomation", []), 1.0)
        if clip.get("reverse") or clip.get("freezeFrame") or str(clip.get("speedRamp", "off")) != "off":
            clip["audioAutomation"] = []
            clip["audioFadeIn"] = 0.0
            clip["audioFadeOut"] = 0.0
    for track in project.get("audioTracks", []):
        track["automation"] = _normalize_automation(track.get("automation", []), 1.0)
    return project


def _gain_expression(points: list[dict], duration: float, base_gain: float) -> str:
    if not points:
        return f"{base_gain:.6f}"
    duration = max(.001, duration)
    expr = f"{base_gain * float(points[-1]['gain']):.6f}"
    for index in range(len(points) - 2, -1, -1):
        a, b = points[index], points[index + 1]
        ta = float(a["time"]) * duration
        tb = float(b["time"]) * duration
        ga = base_gain * float(a["gain"])
        gb = base_gain * float(b["gain"])
        span = max(.0001, tb - ta)
        segment = f"{ga:.6f}+({gb-ga:.6f})*(t-{ta:.6f})/{span:.6f}"
        expr = f"if(lt(t,{tb:.6f}),if(lt(t,{ta:.6f}),{ga:.6f},{segment}),{expr})"
    return expr


def _append_clip_audio_automation(
    filters: list[str],
    audio_out: str,
    specs: list[dict],
    starts: list[float],
    probes: list[dict],
) -> str:
    labels: list[str] = []
    for index, spec in enumerate(specs):
        automation = spec.get("automation", [])
        lead = float(spec.get("lead", 0))
        tail = float(spec.get("tail", 0))
        fade_in = float(spec.get("fadeIn", 0))
        fade_out = float(spec.get("fadeOut", 0))
        if not automation and lead <= .001 and tail <= .001 and fade_in <= .001 and fade_out <= .001:
            continue
        src = int(spec["src"])
        if not 0 <= src < len(probes) or not _has_audio(probes[src]):
            continue
        speed = max(.25, min(4.0, float(spec.get("speed", 1))))
        source_duration = _duration(probes[src])
        original_start = float(spec["start"])
        original_end = float(spec["end"])
        source_start = max(0.0, original_start - lead)
        source_end = min(source_duration, original_end + tail)
        if source_end <= source_start + .01:
            continue
        pre_output = (original_start - source_start) / speed
        main_output = max(.001, (original_end - original_start) / speed)
        total_output = max(.001, (source_end - source_start) / speed)
        start_at = starts[index] - pre_output
        if start_at < 0:
            source_shift = (-start_at) * speed
            source_start = min(source_end - .01, source_start + source_shift)
            pre_output = max(0.0, pre_output + start_at)
            total_output = max(.001, (source_end - source_start) / speed)
            start_at = 0.0

        delay_ms = max(0, round(start_at * 1000))
        label = f"v9clipa{index}"
        chain = [
            f"atrim=start={source_start:.6f}:end={source_end:.6f}",
            "asetpts=PTS-STARTPTS",
            *_atempo_chain(speed),
            "aresample=48000",
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
        ]
        if automation:
            main_expr = _gain_expression(automation, main_output, max(0.0, min(2.0, float(spec.get("volume", 1)))))
            first_gain = max(0.0, min(2.0, float(spec.get("volume", 1)))) * float(automation[0]["gain"])
            last_gain = max(0.0, min(2.0, float(spec.get("volume", 1)))) * float(automation[-1]["gain"])
            main_start = pre_output
            main_end = pre_output + main_output
            shifted_expr = main_expr.replace("t-", f"t-{main_start:.6f}-") if main_start > .0001 else main_expr
            expr = f"if(lt(t,{main_start:.6f}),{first_gain:.6f},if(lt(t,{main_end:.6f}),{shifted_expr},{last_gain:.6f}))"
            chain.append(f"volume='{expr}':eval=frame")
        else:
            chain.append(f"volume={max(0.0, min(2.0, float(spec.get('volume', 1)))):.6f}")
        if fade_in > .001:
            d = min(fade_in, total_output)
            chain.append(f"afade=t=in:st=0:d={d:.6f}")
        if fade_out > .001:
            d = min(fade_out, total_output)
            chain.append(f"afade=t=out:st={max(0.0,total_output-d):.6f}:d={d:.6f}")
        chain.append(f"adelay={delay_ms}|{delay_ms}")
        filters.append(f"[{src}:a]{','.join(chain)}[{label}]")
        labels.append(label)

    if not labels:
        return audio_out
    final = "v9clipaudio"
    inputs = f"[{audio_out}]" + "".join(f"[{label}]" for label in labels)
    filters.append(f"{inputs}amix=inputs={len(labels)+1}:duration=longest:dropout_transition=2,alimiter=limit=.98[{final}]")
    return final


def _append_automated_music(
    filters: list[str],
    audio_out: str,
    project: dict,
    audio_base: int,
) -> str:
    labels: list[str] = []
    for index, track in enumerate(project.get("audioTracks", [])):
        input_index = audio_base + int(track["fileIndex"])
        source_start = float(track["sourceStart"])
        source_end = float(track["sourceEnd"])
        duration = max(.001, source_end - source_start)
        delay_ms = max(0, round(float(track.get("startAt", 0)) * 1000))
        base_volume = _safe_clip(track.get("volume", .65), 0, 2, .65)
        automation = track.get("automation", [])
        chain = [
            f"atrim=start={source_start:.6f}:end={source_end:.6f}",
            "asetpts=PTS-STARTPTS",
            "aresample=48000",
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
        ]
        if automation:
            chain.append(f"volume='{_gain_expression(automation, duration, base_volume)}':eval=frame")
        else:
            chain.append(f"volume={base_volume:.6f}")
        fade_in = _safe_clip(track.get("fadeIn", 0), 0, 10, 0)
        fade_out = _safe_clip(track.get("fadeOut", 0), 0, 10, 0)
        if fade_in > 0:
            chain.append(f"afade=t=in:st=0:d={min(fade_in,duration):.6f}")
        if fade_out > 0:
            d = min(fade_out, duration)
            chain.append(f"afade=t=out:st={max(0.0,duration-d):.6f}:d={d:.6f}")
        chain.append(f"adelay={delay_ms}|{delay_ms}")
        label = f"v9music{index}"
        filters.append(f"[{input_index}:a]{','.join(chain)}[{label}]")
        labels.append(label)

    if not labels:
        return audio_out
    if len(labels) == 1:
        music_bus = labels[0]
    else:
        music_bus = "v9musicbus"
        filters.append(f"{''.join(f'[{label}]' for label in labels)}amix=inputs={len(labels)}:duration=longest:dropout_transition=2[{music_bus}]")
    if project.get("audioDuckingEnabled"):
        strength = float(project.get("duckingStrength", .65))
        ratio = 2.0 + strength * 16.0
        threshold = .06 - strength * .035
        filters.append(f"[{audio_out}]asplit=2[v9voice][v9key]")
        filters.append(f"[{music_bus}][v9key]sidechaincompress=threshold={threshold:.5f}:ratio={ratio:.3f}:attack=20:release=320:makeup=1[v9ducked]")
        filters.append("[v9voice][v9ducked]amix=inputs=2:duration=longest:dropout_transition=2,alimiter=limit=.98[v9audio]")
    else:
        filters.append(f"[{audio_out}][{music_bus}]amix=inputs=2:duration=longest:dropout_transition=2,alimiter=limit=.98[v9audio]")
    return "v9audio"


@router.post("/render")
async def render_video_v9(
    video_files: list[UploadFile] = File(...),
    audio_files: list[UploadFile] | None = File(None),
    image_files: list[UploadFile] | None = File(None),
    lut_file: UploadFile | None = File(None),
    manifest: str = Form(...),
    output_size: Literal["720p", "1080p", "portrait", "square"] = Form("720p"),
    quality: Literal["draft", "standard", "high"] = Form("standard"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    audio_files = audio_files or []
    image_files = image_files or []
    if not video_files or len(video_files) > MAX_VIDEO_FILES:
        raise HTTPException(status_code=400, detail=f"ارفع من 1 إلى {MAX_VIDEO_FILES} ملفات فيديو.")
    if len(audio_files) > MAX_AUDIO_FILES or len(image_files) > MAX_IMAGE_FILES:
        raise HTTPException(status_code=400, detail="عدد ملفات الصوت أو الصور أكبر من الحد المسموح.")

    folder = _workspace()
    try:
        videos = [await _save_media(item, folder, i, "video") for i, item in enumerate(video_files)]
        audios = [await _save_media(item, folder, i, "audio") for i, item in enumerate(audio_files)]
        images = [await _save_media(item, folder, i, "image") for i, item in enumerate(image_files)]
        lut = await _save_lut(lut_file, folder)
        probes = await asyncio.gather(*[asyncio.to_thread(_probe, item) for item in videos])

        project = _validate_project(manifest, len(videos), len(audios), len(images), probes)
        project = _validate_v3(project)
        project = _validate_v4(project)
        project = _validate_v5(project, len(videos))
        project = _validate_v6(project)
        project = _validate_v8(project)
        project = _validate_v9(project)

        audio_specs: list[dict] = []
        for clip in project["clips"]:
            audio_specs.append({
                "src": int(clip["fileIndex"]),
                "start": float(clip["start"]),
                "end": float(clip["end"]),
                "speed": float(clip.get("speed", 1)),
                "volume": float(clip.get("volume", 1)),
                "lead": float(clip.get("audioLead", 0)),
                "tail": float(clip.get("audioTail", 0)),
                "fadeIn": float(clip.get("audioFadeIn", 0)),
                "fadeOut": float(clip.get("audioFadeOut", 0)),
                "automation": copy.deepcopy(clip.get("audioAutomation", [])),
            })

        for index, clip in enumerate(project["clips"]):
            if not (clip.get("reverse") or clip.get("freezeFrame") or clip.get("privacyEffect") != "none"):
                continue
            src = int(clip["fileIndex"])
            advanced = await asyncio.to_thread(_render_advanced_clip, videos[src], clip, folder, index, _has_audio(probes[src]))
            advanced_probe = await asyncio.to_thread(_probe, advanced)
            try:
                advanced_duration = max(.05, float(advanced_probe.get("format", {}).get("duration", clip.get("freezeDuration", 2))))
            except (TypeError, ValueError):
                advanced_duration = float(clip.get("freezeDuration", 2))
            videos.append(advanced)
            probes.append(advanced_probe)
            clip.update(fileIndex=len(videos)-1, start=0.0, end=advanced_duration, reverse=False, freezeFrame=False, privacyEffect="none")

        for index, clip in enumerate(project["clips"]):
            if len(clip.get("transformKeyframes", [])) < 2:
                continue
            src = int(clip["fileIndex"])
            rendered = await asyncio.to_thread(_render_eased_keyframed_clip, videos[src], probes[src], clip, folder, index)
            if rendered == videos[src]:
                continue
            rendered_probe = await asyncio.to_thread(_probe, rendered)
            try:
                rendered_duration = max(.05, float(rendered_probe.get("format", {}).get("duration", clip["end"]-clip["start"])))
            except (TypeError, ValueError):
                rendered_duration = max(.05, float(clip["end"]-clip["start"]))
            videos.append(rendered)
            probes.append(rendered_probe)
            clip.update(
                fileIndex=len(videos)-1, start=0.0, end=rendered_duration,
                zoomStart=1.0, zoomEnd=1.0, panXStart=0.0, panXEnd=0.0,
                panYStart=0.0, panYEnd=0.0, transformKeyframes=[],
            )

        width, height = OUTPUT_SIZES[output_size]
        music_tracks = copy.deepcopy(project.get("audioTracks", []))
        base_project = copy.deepcopy(project)
        base_project["audioTracks"] = []
        base_project["videoOverlays"] = []
        starts, _ = _clip_timeline_starts(base_project)

        for index, spec in enumerate(audio_specs):
            if (spec["lead"] > .001 or spec["tail"] > .001 or spec["fadeIn"] > .001 or spec["fadeOut"] > .001 or spec["automation"]):
                if _has_audio(probes[spec["src"]]):
                    base_project["clips"][index]["volume"] = 0.0

        command = ["ffmpeg", "-hide_banner", "-y"]
        for item in videos:
            command.extend(["-i", str(item)])
        for item in audios:
            command.extend(["-i", str(item)])
        for item in images:
            command.extend(["-loop", "1", "-framerate", "30", "-i", str(item)])

        filters, video_out, audio_out, timeline_duration = _build_v4_filters(base_project, videos, audios, images, probes, width, height, folder)
        video_out = _append_pip_layers(filters, video_out, project, width, timeline_duration)
        video_out = _apply_master_lut(filters, video_out, lut)
        audio_out = _append_clip_audio_automation(filters, audio_out, audio_specs, starts, probes)
        project["audioTracks"] = music_tracks
        audio_out = _append_automated_music(filters, audio_out, project, len(videos))
        audio_out = _append_pip_audio(filters, audio_out, project, probes)

        output = folder / "MAGHRABI-video-v9.mp4"
        crf = {"draft": "28", "standard": "23", "high": "19"}[quality]
        preset = {"draft": "ultrafast", "standard": "veryfast", "high": "fast"}[quality]
        command.extend([
            "-filter_complex", ";".join(filters),
            "-map", f"[{video_out}]", "-map", f"[{audio_out}]",
            "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-t", f"{timeline_duration:.6f}",
            "-movflags", "+faststart", str(output),
        ])
        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(output, media_type="video/mp4", filename="MAGHRABI-video-v9.mp4", background=BackgroundTask(_cleanup, folder))
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v9] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render مشروع V9. راجع Railway Logs للتفاصيل.") from exc
