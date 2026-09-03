from __future__ import annotations

import asyncio
import copy
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import OUTPUT_SIZES, _atempo_chain, _cleanup, _has_audio, _probe, _run_ffmpeg, _workspace
from .video_tools_v2 import MAX_AUDIO_FILES, MAX_IMAGE_FILES, MAX_VIDEO_FILES, _save_media, _validate_project
from .video_tools_v3 import _safe_clip, _validate_v3
from .video_tools_v4 import _build_v4_filters, _validate_v4

router = APIRouter(prefix="/api/video/v5", tags=["video-studio-v5"])
MAX_PIP_TRACKS = 12
PRIVACY_EFFECTS = {"none", "blur", "mosaic"}


def _validate_v5(project: dict, video_count: int) -> dict:
    project["audioDuckingEnabled"] = bool(project.get("audioDuckingEnabled", False))
    project["duckingStrength"] = _safe_clip(project.get("duckingStrength", .65), 0, 1, .65)

    for clip in project.get("clips", []):
        clip["reverse"] = bool(clip.get("reverse", False))
        clip["freezeFrame"] = bool(clip.get("freezeFrame", False))
        clip["freezeDuration"] = _safe_clip(clip.get("freezeDuration", 2), .2, 12, 2)
        mode = str(clip.get("privacyEffect", "none"))
        clip["privacyEffect"] = mode if mode in PRIVACY_EFFECTS else "none"
        clip["privacyX"] = _safe_clip(clip.get("privacyX", .35), 0, .95, .35)
        clip["privacyY"] = _safe_clip(clip.get("privacyY", .30), 0, .95, .30)
        clip["privacyWidth"] = _safe_clip(clip.get("privacyWidth", .30), .05, 1, .30)
        clip["privacyHeight"] = _safe_clip(clip.get("privacyHeight", .22), .05, 1, .22)
        clip["privacyIntensity"] = _safe_clip(clip.get("privacyIntensity", .55), .05, 1, .55)
        clip["privacyWidth"] = min(clip["privacyWidth"], 1 - clip["privacyX"])
        clip["privacyHeight"] = min(clip["privacyHeight"], 1 - clip["privacyY"])

    overlays = project.get("videoOverlays", [])
    if not isinstance(overlays, list) or len(overlays) > MAX_PIP_TRACKS:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_PIP_TRACKS} طبقات Picture-in-Picture.")
    for track in overlays:
        try:
            file_index = int(track.get("fileIndex"))
            if not 0 <= file_index < video_count:
                raise ValueError
            start_at = max(0.0, float(track.get("startAt", 0)))
            end_at = float(track.get("endAt", start_at + 3))
            source_start = max(0.0, float(track.get("sourceStart", 0)))
            source_end = float(track.get("sourceEnd", source_start + max(.1, end_at - start_at)))
            if end_at <= start_at or source_end <= source_start:
                raise ValueError
            track.update(
                fileIndex=file_index,
                startAt=start_at,
                endAt=end_at,
                sourceStart=source_start,
                sourceEnd=source_end,
                scale=_safe_clip(track.get("scale", .30), .08, .85, .30),
                opacity=_safe_clip(track.get("opacity", 1), 0, 1, 1),
                x=_safe_clip(track.get("x", .66), 0, 1, .66),
                y=_safe_clip(track.get("y", .62), 0, 1, .62),
                borderRadius=_safe_clip(track.get("borderRadius", .08), 0, .5, .08),
            )
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="إحدى طبقات Picture-in-Picture غير صالحة.")
    return project


def _privacy_filter(clip: dict) -> str | None:
    mode = str(clip.get("privacyEffect", "none"))
    if mode == "none":
        return None
    x = float(clip["privacyX"])
    y = float(clip["privacyY"])
    width = float(clip["privacyWidth"])
    height = float(clip["privacyHeight"])
    intensity = float(clip["privacyIntensity"])
    crop = f"crop=w=iw*{width:.6f}:h=ih*{height:.6f}:x=iw*{x:.6f}:y=ih*{y:.6f}"
    if mode == "blur":
        radius = max(2, round(3 + intensity * 24))
        effect = f"boxblur=luma_radius={radius}:luma_power=2"
    else:
        divisor = max(5, round(6 + intensity * 24))
        effect = f"scale=iw/{divisor}:ih/{divisor}:flags=neighbor,scale=iw*{divisor}:ih*{divisor}:flags=neighbor"
    return (
        f"split=2[base][privacy];[privacy]{crop},{effect}[fx];"
        f"[base][fx]overlay=x=main_w*{x:.6f}:y=main_h*{y:.6f}"
    )


def _render_advanced_clip(source: Path, clip: dict, folder: Path, index: int, has_audio: bool) -> Path:
    output = folder / f"v5-pre-{index}.mp4"
    start = float(clip["start"])
    end = float(clip["end"])
    freeze = bool(clip.get("freezeFrame"))
    reverse = bool(clip.get("reverse"))
    privacy = _privacy_filter(clip)

    command = ["ffmpeg", "-hide_banner", "-y", "-i", str(source)]
    if freeze:
        duration = float(clip.get("freezeDuration", 2))
        vf = [
            f"trim=start={start:.6f}:end={min(end, start + .08):.6f}",
            "setpts=PTS-STARTPTS",
            f"tpad=stop_mode=clone:stop_duration={duration:.6f}",
            "fps=30",
        ]
        command.extend([
            "-vf", ",".join(vf), "-an", "-t", f"{duration:.6f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(output),
        ])
        _run_ffmpeg(command)
        return output

    video_chain = [f"trim=start={start:.6f}:end={end:.6f}", "setpts=PTS-STARTPTS"]
    if privacy:
        # Privacy needs a filter graph because the selected region is split and composited back.
        first = f"[0:v]{','.join(video_chain)},{privacy}[pv]"
        if reverse:
            first += ";[pv]reverse[vout]"
            video_map = "[vout]"
        else:
            video_map = "[pv]"
        graph = first
        if has_audio:
            audio_filters = [f"atrim=start={start:.6f}:end={end:.6f}", "asetpts=PTS-STARTPTS"]
            if reverse:
                audio_filters.append("areverse")
            graph += f";[0:a]{','.join(audio_filters)}[aout]"
            command.extend(["-filter_complex", graph, "-map", video_map, "-map", "[aout]"])
        else:
            command.extend(["-filter_complex", graph, "-map", video_map])
    else:
        if reverse:
            video_chain.append("reverse")
        command.extend(["-vf", ",".join(video_chain)])
        if has_audio:
            af = [f"atrim=start={start:.6f}:end={end:.6f}", "asetpts=PTS-STARTPTS"]
            if reverse:
                af.append("areverse")
            command.extend(["-af", ",".join(af)])
        else:
            command.append("-an")

    command.extend([
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output),
    ])
    _run_ffmpeg(command)
    return output


def _append_pip_layers(filters: list[str], video_out: str, project: dict, width: int, timeline_duration: float) -> str:
    for i, track in enumerate(project.get("videoOverlays", [])):
        start_at = max(0.0, float(track["startAt"]))
        end_at = min(timeline_duration, float(track["endAt"]))
        if end_at <= start_at:
            continue
        source_start = float(track["sourceStart"])
        source_end = float(track["sourceEnd"])
        duration = min(end_at - start_at, source_end - source_start)
        if duration <= .01:
            continue
        input_index = int(track["fileIndex"])
        scale_px = max(48, round(width * float(track["scale"])))
        opacity = float(track["opacity"])
        x = min(1.0, max(0.0, float(track["x"])))
        y = min(1.0, max(0.0, float(track["y"])))
        pip_label = f"pip{i}"
        label = f"vpip{i}"
        filters.append(
            f"[{input_index}:v]trim=start={source_start:.6f}:end={source_start + duration:.6f},"
            f"setpts=PTS-STARTPTS+{start_at:.6f}/TB,scale={scale_px}:-1,format=rgba,"
            f"colorchannelmixer=aa={opacity:.4f}[{pip_label}]"
        )
        filters.append(
            f"[{video_out}][{pip_label}]overlay=x='(W-w)*{x:.6f}':y='(H-h)*{y:.6f}':"
            f"enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]"
        )
        video_out = label
    return video_out


def _append_music_and_ducking(
    filters: list[str], audio_out: str, project: dict, audio_base: int
) -> str:
    music_labels: list[str] = []
    for i, track in enumerate(project.get("audioTracks", [])):
        input_index = audio_base + int(track["fileIndex"])
        source_start = float(track["sourceStart"])
        source_end = float(track["sourceEnd"])
        duration = max(.001, source_end - source_start)
        delay_ms = max(0, round(float(track.get("startAt", 0)) * 1000))
        af = [
            f"atrim=start={source_start:.6f}:end={source_end:.6f}",
            "asetpts=PTS-STARTPTS",
            "aresample=48000",
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
            f"volume={_safe_clip(track.get('volume', .65), 0, 2, .65):.4f}",
        ]
        fade_in = _safe_clip(track.get("fadeIn", 0), 0, 10, 0)
        fade_out = _safe_clip(track.get("fadeOut", 0), 0, 10, 0)
        if fade_in > 0:
            af.append(f"afade=t=in:st=0:d={min(fade_in, duration):.4f}")
        if fade_out > 0:
            fade_d = min(fade_out, duration)
            af.append(f"afade=t=out:st={max(0, duration - fade_d):.4f}:d={fade_d:.4f}")
        af.append(f"adelay={delay_ms}|{delay_ms}")
        label = f"v5music{i}"
        filters.append(f"[{input_index}:a]{','.join(af)}[{label}]")
        music_labels.append(label)

    if not music_labels:
        return audio_out

    if len(music_labels) == 1:
        music_bus = music_labels[0]
    else:
        music_bus = "v5musicbus"
        filters.append(
            f"{''.join(f'[{label}]' for label in music_labels)}amix=inputs={len(music_labels)}:"
            f"duration=longest:dropout_transition=2[{music_bus}]"
        )

    if project.get("audioDuckingEnabled"):
        strength = float(project.get("duckingStrength", .65))
        ratio = 2.0 + strength * 16.0
        threshold = .06 - strength * .035
        filters.append(f"[{audio_out}]asplit=2[v5voice][v5key]")
        filters.append(
            f"[{music_bus}][v5key]sidechaincompress=threshold={threshold:.5f}:ratio={ratio:.3f}:"
            "attack=20:release=320:makeup=1[v5ducked]"
        )
        filters.append("[v5voice][v5ducked]amix=inputs=2:duration=longest:dropout_transition=2,alimiter=limit=.98[v5audio]")
    else:
        filters.append(f"[{audio_out}][{music_bus}]amix=inputs=2:duration=longest:dropout_transition=2,alimiter=limit=.98[v5audio]")
    return "v5audio"


@router.post("/render")
async def render_video_v5(
    video_files: list[UploadFile] = File(...),
    audio_files: list[UploadFile] | None = File(None),
    image_files: list[UploadFile] | None = File(None),
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
        probes = await asyncio.gather(*[asyncio.to_thread(_probe, item) for item in videos])

        project = _validate_project(manifest, len(videos), len(audios), len(images), probes)
        project = _validate_v3(project)
        project = _validate_v4(project)
        project = _validate_v5(project, len(videos))

        # Convert advanced per-clip effects to temporary clean source clips, then
        # reuse the stable V4 timeline/transition engine.
        for index, clip in enumerate(project["clips"]):
            if not (clip.get("reverse") or clip.get("freezeFrame") or clip.get("privacyEffect") != "none"):
                continue
            source_index = int(clip["fileIndex"])
            advanced = await asyncio.to_thread(
                _render_advanced_clip,
                videos[source_index], clip, folder, index, _has_audio(probes[source_index]),
            )
            advanced_probe = await asyncio.to_thread(_probe, advanced)
            try:
                advanced_duration = max(.05, float(advanced_probe.get("format", {}).get("duration", clip.get("freezeDuration", 2))))
            except (TypeError, ValueError):
                advanced_duration = float(clip.get("freezeDuration", 2))
            videos.append(advanced)
            probes.append(advanced_probe)
            clip.update(
                fileIndex=len(videos) - 1,
                start=0.0,
                end=advanced_duration,
                reverse=False,
                freezeFrame=False,
                privacyEffect="none",
            )
            if clip.get("speedRamp") and advanced_duration <= .25:
                clip["speedRamp"] = "off"

        width, height = OUTPUT_SIZES[output_size]
        music_tracks = copy.deepcopy(project.get("audioTracks", []))
        base_project = copy.deepcopy(project)
        base_project["audioTracks"] = []
        base_project["videoOverlays"] = []

        command = ["ffmpeg", "-hide_banner", "-y"]
        for item in videos:
            command.extend(["-i", str(item)])
        for item in audios:
            command.extend(["-i", str(item)])
        for item in images:
            command.extend(["-loop", "1", "-framerate", "30", "-i", str(item)])

        filters, video_out, audio_out, timeline_duration = _build_v4_filters(
            base_project, videos, audios, images, probes, width, height, folder
        )
        video_out = _append_pip_layers(filters, video_out, project, width, timeline_duration)
        project["audioTracks"] = music_tracks
        audio_out = _append_music_and_ducking(filters, audio_out, project, len(videos))

        output = folder / "MAGHRABI-video-v5.mp4"
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
        return FileResponse(
            output,
            media_type="video/mp4",
            filename="MAGHRABI-video-v5.mp4",
            background=BackgroundTask(_cleanup, folder),
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v5] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render مشروع V5. راجع Railway Logs للتفاصيل.") from exc
