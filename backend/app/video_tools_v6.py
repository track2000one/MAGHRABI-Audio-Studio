from __future__ import annotations

import asyncio
import copy
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import OUTPUT_SIZES, _cleanup, _has_audio, _probe, _run_ffmpeg, _workspace
from .video_tools_v2 import MAX_AUDIO_FILES, MAX_IMAGE_FILES, MAX_VIDEO_FILES, _save_media, _validate_project
from .video_tools_v3 import _safe_clip, _validate_v3
from .video_tools_v4 import _build_v4_filters, _validate_v4
from .video_tools_v5 import (
    _append_music_and_ducking,
    _append_pip_layers,
    _render_advanced_clip,
    _validate_v5,
)

router = APIRouter(prefix="/api/video/v6", tags=["video-studio-v6"])


def _validate_v6(project: dict) -> dict:
    for track in project.get("videoOverlays", []):
        track["audioEnabled"] = bool(track.get("audioEnabled", False))
        track["audioVolume"] = _safe_clip(track.get("audioVolume", .85), 0, 2, .85)
    return project


def _append_pip_audio(filters: list[str], audio_out: str, project: dict, probes: list[dict]) -> str:
    labels: list[str] = []
    for i, track in enumerate(project.get("videoOverlays", [])):
        if not track.get("audioEnabled"):
            continue
        src = int(track["fileIndex"])
        if not 0 <= src < len(probes) or not _has_audio(probes[src]):
            continue
        source_start = float(track["sourceStart"])
        source_end = float(track["sourceEnd"])
        timeline_duration = max(.01, float(track["endAt"]) - float(track["startAt"]))
        source_duration = max(.01, source_end - source_start)
        duration = min(timeline_duration, source_duration)
        delay_ms = max(0, round(float(track["startAt"]) * 1000))
        label = f"v6pipa{i}"
        filters.append(
            f"[{src}:a]atrim=start={source_start:.6f}:end={source_start + duration:.6f},"
            "asetpts=PTS-STARTPTS,aresample=48000,"
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
            f"volume={float(track['audioVolume']):.4f},adelay={delay_ms}|{delay_ms}[{label}]"
        )
        labels.append(label)

    if not labels:
        return audio_out

    if len(labels) == 1:
        pip_bus = labels[0]
    else:
        pip_bus = "v6pipbus"
        filters.append(
            f"{''.join(f'[{label}]' for label in labels)}"
            f"amix=inputs={len(labels)}:duration=longest:dropout_transition=2[{pip_bus}]"
        )

    filters.append(
        f"[{audio_out}][{pip_bus}]amix=inputs=2:duration=longest:dropout_transition=2,"
        "alimiter=limit=.98[v6audio]"
    )
    return "v6audio"


@router.post("/render")
async def render_video_v6(
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
        project = _validate_v6(project)

        # Pre-render clip-local heavy effects, then reuse the proven V4 timeline engine.
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
        audio_out = _append_pip_audio(filters, audio_out, project, probes)

        output = folder / "MAGHRABI-video-v6.mp4"
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
            filename="MAGHRABI-video-v6.mp4",
            background=BackgroundTask(_cleanup, folder),
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v6] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render مشروع V6. راجع Railway Logs للتفاصيل.") from exc
