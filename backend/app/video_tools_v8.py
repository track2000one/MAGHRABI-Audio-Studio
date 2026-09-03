from __future__ import annotations

import asyncio
import copy
import subprocess
from array import array
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
from .video_tools_v5 import _append_music_and_ducking, _append_pip_layers, _render_advanced_clip, _validate_v5
from .video_tools_v6 import _append_pip_audio, _validate_v6
from .video_tools_v7 import _apply_master_lut, _save_lut, _video_dimensions

router = APIRouter(prefix="/api/video/v8", tags=["video-studio-v8"])
MAX_KEYFRAMES_PER_CLIP = 20
EASINGS = {"linear", "ease-in", "ease-out", "ease-in-out", "hold"}


def _ease(kind: str, value: float) -> float:
    t = min(1.0, max(0.0, value))
    if kind == "ease-in":
        return t * t
    if kind == "ease-out":
        return 1 - (1 - t) * (1 - t)
    if kind == "ease-in-out":
        return 2 * t * t if t < .5 else 1 - ((-2 * t + 2) ** 2) / 2
    if kind == "hold":
        return 0.0
    return t


def _normalize_keyframes(clip: dict) -> list[dict]:
    raw = clip.get("transformKeyframes", []) or []
    if not isinstance(raw, list) or len(raw) > MAX_KEYFRAMES_PER_CLIP:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_KEYFRAMES_PER_CLIP} Keyframes لكل Clip.")
    points: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="إحدى نقاط Keyframe غير صالحة.")
        easing = str(item.get("easing", "linear"))
        points.append({
            "time": _safe_clip(item.get("time", 0), 0, 1, 0),
            "zoom": _safe_clip(item.get("zoom", 1), 1, 4, 1),
            "panX": _safe_clip(item.get("panX", 0), -1, 1, 0),
            "panY": _safe_clip(item.get("panY", 0), -1, 1, 0),
            "easing": easing if easing in EASINGS else "linear",
        })
    points.sort(key=lambda item: item["time"])
    deduped: list[dict] = []
    for point in points:
        if deduped and abs(point["time"] - deduped[-1]["time"]) < .0005:
            deduped[-1] = point
        else:
            deduped.append(point)
    if deduped and deduped[0]["time"] > .0005:
        deduped.insert(0, {
            "time": 0.0,
            "zoom": _safe_clip(clip.get("zoomStart", 1), 1, 4, 1),
            "panX": _safe_clip(clip.get("panXStart", 0), -1, 1, 0),
            "panY": _safe_clip(clip.get("panYStart", 0), -1, 1, 0),
            "easing": "linear",
        })
    if deduped and deduped[-1]["time"] < .9995:
        deduped.append({
            "time": 1.0,
            "zoom": _safe_clip(clip.get("zoomEnd", 1), 1, 4, 1),
            "panX": _safe_clip(clip.get("panXEnd", 0), -1, 1, 0),
            "panY": _safe_clip(clip.get("panYEnd", 0), -1, 1, 0),
            "easing": "linear",
        })
    if len(deduped) > MAX_KEYFRAMES_PER_CLIP:
        raise HTTPException(status_code=400, detail=f"تجاوز Clip حد {MAX_KEYFRAMES_PER_CLIP} Keyframes.")
    clip["transformKeyframes"] = deduped
    return deduped


def _validate_v8(project: dict) -> dict:
    project["magneticSnap"] = bool(project.get("magneticSnap", True))
    for clip in project.get("clips", []):
        _normalize_keyframes(clip)
        clip["audioLead"] = _safe_clip(clip.get("audioLead", 0), 0, 4, 0)
        clip["audioTail"] = _safe_clip(clip.get("audioTail", 0), 0, 4, 0)
        if clip.get("reverse") or clip.get("freezeFrame") or str(clip.get("speedRamp", "off")) != "off":
            clip["audioLead"] = 0.0
            clip["audioTail"] = 0.0
    return project


def _neutral_segment(source_start: float, source_end: float, p0: dict, p1: dict) -> dict:
    return {
        "fileIndex": 0,
        "start": source_start,
        "end": source_end,
        "speed": 1.0,
        "volume": 1.0,
        "filter": "none",
        "text": "",
        "textSize": 48,
        "textPosition": "bottom",
        "rotation": 0,
        "fit": "contain",
        "zoomStart": p0["zoom"],
        "zoomEnd": p1["zoom"],
        "panXStart": p0["panX"],
        "panXEnd": p1["panX"],
        "panYStart": p0["panY"],
        "panYEnd": p1["panY"],
        "chromaEnabled": False,
        "brightness": 0,
        "contrast": 1,
        "saturation": 1,
        "temperature": 0,
        "vignette": 0,
        "speedRamp": "off",
    }


def _interp(a: dict, b: dict, t: float) -> dict:
    return {
        "zoom": a["zoom"] + (b["zoom"] - a["zoom"]) * t,
        "panX": a["panX"] + (b["panX"] - a["panX"]) * t,
        "panY": a["panY"] + (b["panY"] - a["panY"]) * t,
    }


def _render_eased_keyframed_clip(source: Path, probe: dict, clip: dict, folder: Path, index: int) -> Path:
    points = clip.get("transformKeyframes", [])
    if len(points) < 2:
        return source
    source_start = float(clip["start"])
    source_end = float(clip["end"])
    source_duration = max(.001, source_end - source_start)
    segments: list[dict] = []
    for pair_index in range(len(points) - 1):
        a, b = points[pair_index], points[pair_index + 1]
        span = float(b["time"]) - float(a["time"])
        if span <= .0005:
            continue
        easing = str(a.get("easing", "linear"))
        steps = 1 if easing in {"linear", "hold"} else 6
        for step in range(steps):
            t0 = step / steps
            t1 = (step + 1) / steps
            source_a = source_start + source_duration * (float(a["time"]) + span * t0)
            source_b = source_start + source_duration * (float(a["time"]) + span * t1)
            if source_b <= source_a + .004:
                continue
            if easing == "hold":
                p0 = p1 = {"zoom": a["zoom"], "panX": a["panX"], "panY": a["panY"]}
            else:
                p0 = _interp(a, b, _ease(easing, t0))
                p1 = _interp(a, b, _ease(easing, t1))
            segments.append(_neutral_segment(source_a, source_b, p0, p1))
    if not segments:
        return source
    width, height = _video_dimensions(probe)
    mini_project = {
        "clips": segments,
        "transition": "none",
        "transitionDuration": .1,
        "textTracks": [],
        "subtitleTracks": [],
        "audioTracks": [],
        "imageTracks": [],
    }
    filters, video_out, audio_out, duration = _build_v4_filters(mini_project, [source], [], [], [probe], width, height, folder)
    output = folder / f"v8-keyframed-{index}.mp4"
    command = [
        "ffmpeg", "-hide_banner", "-y", "-i", str(source),
        "-filter_complex", ";".join(filters),
        "-map", f"[{video_out}]", "-map", f"[{audio_out}]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-t", f"{duration:.6f}",
        "-movflags", "+faststart", str(output),
    ]
    _run_ffmpeg(command)
    return output


def _clip_output_duration(clip: dict) -> float:
    source_duration = max(.001, float(clip["end"]) - float(clip["start"]))
    speeds = _ramp_speeds(str(clip.get("speedRamp", "off")), float(clip.get("speed", 1)))
    part = source_duration / len(speeds)
    return sum(part / speed for speed in speeds)


def _clip_timeline_starts(project: dict) -> tuple[list[float], float]:
    clips = project.get("clips", [])
    if not clips:
        return [], 0.0
    durations = [_clip_output_duration(clip) for clip in clips]
    transition = str(project.get("transition", "none"))
    transition_duration = min(1.5, max(.1, float(project.get("transitionDuration", .45))))
    starts = [0.0]
    timeline = durations[0]
    for index in range(1, len(clips)):
        if transition != "none":
            fade = min(transition_duration, max(.05, durations[index] / 3), max(.05, timeline / 3))
            starts.append(max(0.0, timeline - fade))
            timeline += durations[index] - fade
        else:
            starts.append(timeline)
            timeline += durations[index]
    return starts, timeline


def _append_jl_audio(filters: list[str], audio_out: str, specs: list[dict], starts: list[float], probes: list[dict]) -> str:
    labels: list[str] = []
    for index, spec in enumerate(specs):
        lead = float(spec["lead"])
        tail = float(spec["tail"])
        if lead <= .001 and tail <= .001:
            continue
        src = int(spec["src"])
        if not 0 <= src < len(probes) or not _has_audio(probes[src]):
            continue
        speed = max(.25, min(4.0, float(spec["speed"])))
        source_duration = _duration(probes[src])
        source_start = max(0.0, float(spec["start"]) - lead)
        source_end = min(source_duration, float(spec["end"]) + tail)
        if source_end <= source_start + .01:
            continue
        start_at = starts[index] - (float(spec["start"]) - source_start) / speed
        if start_at < 0:
            source_start = min(source_end - .01, source_start + (-start_at) * speed)
            start_at = 0.0
        delay_ms = max(0, round(start_at * 1000))
        label = f"v8jl{index}"
        chain = [
            f"atrim=start={source_start:.6f}:end={source_end:.6f}",
            "asetpts=PTS-STARTPTS",
            *_atempo_chain(speed),
            "aresample=48000",
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
            f"volume={max(0.0, min(2.0, float(spec['volume']))):.4f}",
            f"adelay={delay_ms}|{delay_ms}",
        ]
        filters.append(f"[{src}:a]{','.join(chain)}[{label}]")
        labels.append(label)
    if not labels:
        return audio_out
    final = "v8jlaudio"
    inputs = f"[{audio_out}]" + "".join(f"[{label}]" for label in labels)
    filters.append(f"{inputs}amix=inputs={len(labels)+1}:duration=longest:dropout_transition=2,alimiter=limit=.98[{final}]")
    return final


@router.post("/render")
async def render_video_v8(
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

        jl_specs: list[dict] = []
        for clip in project["clips"]:
            jl_specs.append({
                "src": int(clip["fileIndex"]),
                "start": float(clip["start"]),
                "end": float(clip["end"]),
                "speed": float(clip.get("speed", 1)),
                "volume": float(clip.get("volume", 1)),
                "lead": float(clip.get("audioLead", 0)),
                "tail": float(clip.get("audioTail", 0)),
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
        for index, spec in enumerate(jl_specs):
            if (spec["lead"] > .001 or spec["tail"] > .001) and _has_audio(probes[spec["src"]]):
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
        project["audioTracks"] = music_tracks
        audio_out = _append_music_and_ducking(filters, audio_out, project, len(videos))
        audio_out = _append_pip_audio(filters, audio_out, project, probes)
        audio_out = _append_jl_audio(filters, audio_out, jl_specs, starts, probes)

        output = folder / "MAGHRABI-video-v8.mp4"
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
        return FileResponse(output, media_type="video/mp4", filename="MAGHRABI-video-v8.mp4", background=BackgroundTask(_cleanup, folder))
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v8] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render مشروع V8. راجع Railway Logs للتفاصيل.") from exc


@router.post("/waveform")
async def video_waveform(
    file: UploadFile = File(...),
    bars: int = Form(180),
    _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        source = await _save_media(file, folder, 0, "video")
        probe = await asyncio.to_thread(_probe, source)
        duration = _duration(probe)
        bars = max(40, min(400, int(bars)))
        if not _has_audio(probe):
            return {"duration": duration, "peaks": []}
        process = await asyncio.to_thread(
            subprocess.run,
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(source), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
        if process.returncode != 0 or not process.stdout:
            return {"duration": duration, "peaks": []}
        samples = array("h")
        samples.frombytes(process.stdout)
        if not samples:
            return {"duration": duration, "peaks": []}
        chunk = max(1, len(samples) // bars)
        peaks: list[float] = []
        for index in range(bars):
            start = index * chunk
            end = len(samples) if index == bars - 1 else min(len(samples), start + chunk)
            if start >= len(samples):
                peaks.append(0.0)
                continue
            step = max(1, (end - start) // 120)
            peak = max((abs(samples[pos]) for pos in range(start, end, step)), default=0)
            peaks.append(float(peak))
        maximum = max(1.0, max(peaks, default=1.0))
        return {"duration": duration, "peaks": [value / maximum for value in peaks]}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[video-studio-v8] waveform error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر تحليل Waveform لصوت الفيديو.") from exc
    finally:
        _cleanup(folder)
