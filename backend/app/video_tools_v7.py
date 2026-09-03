from __future__ import annotations

import asyncio
import copy
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import MAX_UPLOAD_MB, require_auth
from .video_tools import OUTPUT_SIZES, _cleanup, _has_audio, _probe, _run_ffmpeg, _workspace
from .video_tools_v2 import MAX_AUDIO_FILES, MAX_IMAGE_FILES, MAX_VIDEO_FILES, _save_media, _validate_project
from .video_tools_v3 import _safe_clip, _validate_v3
from .video_tools_v4 import _build_v4_filters, _validate_v4
from .video_tools_v5 import _append_music_and_ducking, _append_pip_layers, _render_advanced_clip, _validate_v5
from .video_tools_v6 import _append_pip_audio, _validate_v6

router = APIRouter(prefix="/api/video/v7", tags=["video-studio-v7"])
MAX_KEYFRAMES_PER_CLIP = 16
MAX_LUT_MB = 8


def _video_dimensions(probe: dict) -> tuple[int, int]:
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            try:
                width = max(64, int(stream.get("width", 1280)))
                height = max(64, int(stream.get("height", 720)))
                return width - (width % 2), height - (height % 2)
            except (TypeError, ValueError):
                break
    return 1280, 720


def _normalize_keyframes(clip: dict) -> list[dict]:
    raw = clip.get("transformKeyframes", [])
    if raw is None:
        raw = []
    if not isinstance(raw, list) or len(raw) > MAX_KEYFRAMES_PER_CLIP:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_KEYFRAMES_PER_CLIP} Keyframes لكل Clip.")

    points: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="إحدى نقاط Keyframe غير صالحة.")
        point = {
            "time": _safe_clip(item.get("time", 0), 0, 1, 0),
            "zoom": _safe_clip(item.get("zoom", 1), 1, 4, 1),
            "panX": _safe_clip(item.get("panX", 0), -1, 1, 0),
            "panY": _safe_clip(item.get("panY", 0), -1, 1, 0),
        }
        points.append(point)

    if not points:
        clip["transformKeyframes"] = []
        return []

    points.sort(key=lambda item: item["time"])
    deduped: list[dict] = []
    for point in points:
        if deduped and abs(point["time"] - deduped[-1]["time"]) < .0005:
            deduped[-1] = point
        else:
            deduped.append(point)

    if deduped[0]["time"] > .0005:
        deduped.insert(0, {
            "time": 0.0,
            "zoom": _safe_clip(clip.get("zoomStart", 1), 1, 4, 1),
            "panX": _safe_clip(clip.get("panXStart", 0), -1, 1, 0),
            "panY": _safe_clip(clip.get("panYStart", 0), -1, 1, 0),
        })
    if deduped[-1]["time"] < .9995:
        deduped.append({
            "time": 1.0,
            "zoom": _safe_clip(clip.get("zoomEnd", 1), 1, 4, 1),
            "panX": _safe_clip(clip.get("panXEnd", 0), -1, 1, 0),
            "panY": _safe_clip(clip.get("panYEnd", 0), -1, 1, 0),
        })

    if len(deduped) > MAX_KEYFRAMES_PER_CLIP:
        raise HTTPException(status_code=400, detail=f"بعد إضافة نقطتي البداية والنهاية تجاوز Clip حد {MAX_KEYFRAMES_PER_CLIP} Keyframes.")
    clip["transformKeyframes"] = deduped
    return deduped


def _validate_v7(project: dict) -> dict:
    for clip in project.get("clips", []):
        _normalize_keyframes(clip)
    project["magneticSnap"] = bool(project.get("magneticSnap", True))
    return project


def _neutral_segment(clip: dict, source_start: float, source_end: float, p0: dict, p1: dict) -> dict:
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


def _render_keyframed_clip(source: Path, probe: dict, clip: dict, folder: Path, index: int) -> Path:
    points = clip.get("transformKeyframes", [])
    if len(points) < 2:
        return source

    source_start = float(clip["start"])
    source_end = float(clip["end"])
    source_duration = max(.001, source_end - source_start)
    segments: list[dict] = []
    for i in range(len(points) - 1):
        p0, p1 = points[i], points[i + 1]
        if p1["time"] <= p0["time"] + .0005:
            continue
        seg_start = source_start + source_duration * float(p0["time"])
        seg_end = source_start + source_duration * float(p1["time"])
        if seg_end <= seg_start + .005:
            continue
        segments.append(_neutral_segment(clip, seg_start, seg_end, p0, p1))

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
    filters, video_out, audio_out, duration = _build_v4_filters(
        mini_project, [source], [], [], [probe], width, height, folder
    )
    output = folder / f"v7-keyframed-{index}.mp4"
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


async def _save_lut(upload: UploadFile | None, folder: Path) -> Path | None:
    if upload is None or not upload.filename:
        return None
    if Path(upload.filename).suffix.lower() != ".cube":
        raise HTTPException(status_code=415, detail="ملف LUT يجب أن يكون بصيغة .cube")
    target = folder / "master-lut.cube"
    size = 0
    with target.open("wb") as output:
        while chunk := await upload.read(512 * 1024):
            size += len(chunk)
            if size > MAX_LUT_MB * 1024 * 1024:
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"الحد الأعلى لملف LUT هو {MAX_LUT_MB} MB.")
            output.write(chunk)
    await upload.close()
    return target


def _apply_master_lut(filters: list[str], video_out: str, lut: Path | None) -> str:
    if lut is None:
        return video_out
    safe_path = str(lut).replace("\\", "/").replace("'", "\\'")
    label = "v7lut"
    filters.append(f"[{video_out}]lut3d=file='{safe_path}':interp=tetrahedral[{label}]")
    return label


@router.post("/render")
async def render_video_v7(
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
        project = _validate_v7(project)

        # First resolve heavy clip-local effects (reverse, freeze, privacy).
        for index, clip in enumerate(project["clips"]):
            if not (clip.get("reverse") or clip.get("freezeFrame") or clip.get("privacyEffect") != "none"):
                continue
            src = int(clip["fileIndex"])
            advanced = await asyncio.to_thread(
                _render_advanced_clip, videos[src], clip, folder, index, _has_audio(probes[src])
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

        # Then bake arbitrary transform keyframes into each affected clip.
        for index, clip in enumerate(project["clips"]):
            points = clip.get("transformKeyframes", [])
            if len(points) < 2:
                continue
            src = int(clip["fileIndex"])
            keyframed = await asyncio.to_thread(_render_keyframed_clip, videos[src], probes[src], clip, folder, index)
            if keyframed == videos[src]:
                continue
            key_probe = await asyncio.to_thread(_probe, keyframed)
            try:
                key_duration = max(.05, float(key_probe.get("format", {}).get("duration", clip["end"] - clip["start"])))
            except (TypeError, ValueError):
                key_duration = max(.05, float(clip["end"] - clip["start"]))
            videos.append(keyframed)
            probes.append(key_probe)
            clip.update(
                fileIndex=len(videos) - 1,
                start=0.0,
                end=key_duration,
                zoomStart=1.0,
                zoomEnd=1.0,
                panXStart=0.0,
                panXEnd=0.0,
                panYStart=0.0,
                panYEnd=0.0,
                transformKeyframes=[],
            )

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
        video_out = _apply_master_lut(filters, video_out, lut)

        project["audioTracks"] = music_tracks
        audio_out = _append_music_and_ducking(filters, audio_out, project, len(videos))
        audio_out = _append_pip_audio(filters, audio_out, project, probes)

        output = folder / "MAGHRABI-video-v7.mp4"
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
            filename="MAGHRABI-video-v7.mp4",
            background=BackgroundTask(_cleanup, folder),
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v7] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render مشروع V7. راجع Railway Logs للتفاصيل.") from exc


@router.post("/proxy")
async def create_proxy(
    file: UploadFile = File(...),
    _username: str = Depends(require_auth),
) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_media(file, folder, 0, "video")
        probe = await asyncio.to_thread(_probe, source)
        has_audio = _has_audio(probe)
        output = folder / "MAGHRABI-proxy.mp4"
        command = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(source),
            "-vf", "scale=w='min(960,iw)':h=-2:force_original_aspect_ratio=decrease,fps=24",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "31", "-pix_fmt", "yuv420p",
        ]
        if has_audio:
            command.extend(["-c:a", "aac", "-b:a", "96k"])
        else:
            command.append("-an")
        command.extend(["-movflags", "+faststart", str(output)])
        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(
            output,
            media_type="video/mp4",
            filename="MAGHRABI-proxy.mp4",
            background=BackgroundTask(_cleanup, folder),
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v7] proxy error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر إنشاء Proxy للفيديو.") from exc
