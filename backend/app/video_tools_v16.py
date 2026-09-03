from __future__ import annotations

import asyncio
import math
import re
import statistics
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import _cleanup, _duration, _has_audio, _probe, _run_ffmpeg, _save_upload, _workspace
from .video_tools_v15 import _filters_available, _frame_rgb, _source_color_info

router = APIRouter(prefix="/api/video/v16", tags=["video-studio-v16"])


def _video_dimensions(probe: dict) -> tuple[int, int]:
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            try:
                return max(2, int(stream.get("width") or 0)), max(2, int(stream.get("height") or 0))
            except (TypeError, ValueError):
                break
    raise RuntimeError("تعذر قراءة أبعاد الفيديو.")


def _scene_cuts(path: Path, threshold: float) -> list[float]:
    threshold = max(.08, min(.85, threshold))
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
            "-filter:v", f"select='gt(scene,{threshold:.5f})',showinfo",
            "-an", "-f", "null", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    text = process.stdout or ""
    values = [float(value) for value in re.findall(r"pts_time:([\d.]+)", text)]
    cleaned: list[float] = []
    for value in sorted(values):
        if not cleaned or value - cleaned[-1] >= .28:
            cleaned.append(value)
        if len(cleaned) >= 79:
            break
    return cleaned


def _scene_ranges(path: Path, threshold: float) -> tuple[float, list[dict]]:
    probe = _probe(path)
    duration = _duration(probe)
    cuts = [value for value in _scene_cuts(path, threshold) if .05 < value < duration - .05]
    boundaries = [0.0, *cuts, duration]
    scenes: list[dict] = []
    for index in range(len(boundaries) - 1):
        start = boundaries[index]
        end = boundaries[index + 1]
        if end - start < .04:
            continue
        scenes.append({
            "index": len(scenes) + 1,
            "start": start,
            "end": end,
            "duration": end - start,
            "midpoint": start + (end - start) / 2,
        })
    return duration, scenes


def _sample_rgb_series(path: Path, max_frames: int = 24) -> list[tuple[int, int, int]]:
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-vf", "fps=1/2,scale=1:1:flags=area,format=rgb24",
            "-frames:v", str(max(3, min(60, max_frames))),
            "-f", "rawvideo", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    raw = process.stdout or b""
    samples = [(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, len(raw) - 2, 3)]
    if samples:
        return samples
    return [_frame_rgb(path, 0)]


def _auto_color_suggestion(path: Path) -> dict:
    samples = _sample_rgb_series(path)
    rs = [item[0] for item in samples]
    gs = [item[1] for item in samples]
    bs = [item[2] for item in samples]
    avg_r, avg_g, avg_b = statistics.fmean(rs), statistics.fmean(gs), statistics.fmean(bs)
    lumas = [.2126 * r + .7152 * g + .0722 * b for r, g, b in samples]
    avg_luma = statistics.fmean(lumas)
    luma_std = statistics.pstdev(lumas) if len(lumas) > 1 else 0
    neutral = (avg_r + avg_g + avg_b) / 3

    brightness = max(-.16, min(.16, (128 - avg_luma) / 255))
    contrast = 1.0
    if luma_std < 13:
        contrast = 1.08
    elif luma_std > 58:
        contrast = .96

    channel_spread = max(avg_r, avg_g, avg_b) - min(avg_r, avg_g, avg_b)
    saturation = max(.88, min(1.14, 1 + (36 - channel_spread) / 320))
    balance = {
        "r": max(-.28, min(.28, (neutral - avg_r) / 150)),
        "g": max(-.28, min(.28, (neutral - avg_g) / 150)),
        "b": max(-.28, min(.28, (neutral - avg_b) / 150)),
    }
    confidence = max(.25, min(.95, .72 - abs(128 - avg_luma) / 400 + min(len(samples), 20) / 100))
    return {
        "sampleCount": len(samples),
        "averageRgb": {"r": avg_r, "g": avg_g, "b": avg_b},
        "averageLuma": avg_luma,
        "lumaStd": luma_std,
        "suggestion": {
            "brightness": brightness,
            "contrast": contrast,
            "saturation": saturation,
            "gammaWheel": balance,
        },
        "confidence": confidence,
        "note": "الاقتراح مبني على متوسطات لونية وإضاءة لعينات زمنية؛ راجعه بصريًا قبل Master النهائي.",
    }


def _shot_color_analysis(path: Path, threshold: float) -> dict:
    duration, scenes = _scene_ranges(path, threshold)
    limited = scenes[:24]
    colors: list[dict] = []
    for scene in limited:
        r, g, b = _frame_rgb(path, scene["midpoint"])
        luma = .2126 * r + .7152 * g + .0722 * b
        colors.append({**scene, "rgb": {"r": r, "g": g, "b": b}, "luma": luma})
    median_luma = statistics.median([item["luma"] for item in colors]) if colors else 128.0
    for item in colors:
        item["brightnessOffset"] = max(-.18, min(.18, (median_luma - item["luma"]) / 255))
    return {
        "duration": duration,
        "sceneCount": len(scenes),
        "analyzedCount": len(colors),
        "medianLuma": median_luma,
        "shots": colors,
    }


def _dialogue_filters() -> tuple[list[str], list[str]]:
    available = _filters_available()
    filters = ["highpass=f=70", "lowpass=f=16000"]
    used = ["highpass", "lowpass"]
    if "afftdn" in available:
        filters.append("afftdn=nr=12:nf=-50")
        used.append("afftdn")
    if "deesser" in available:
        filters.append("deesser=i=0.28:m=0.5:f=0.5")
        used.append("deesser")
    filters += [
        "acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1",
        "loudnorm=I=-16:TP=-1.5:LRA=9",
        "alimiter=limit=0.891251:attack=5:release=50",
    ]
    used += ["acompressor", "loudnorm", "alimiter"]
    return filters, used


def _cropdetect_focus(path: Path, duration: float, width: int, height: int) -> dict:
    sample_duration = max(.5, min(18.0, duration))
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
            "-t", f"{sample_duration:.3f}", "-vf", "cropdetect=24:16:0", "-an", "-f", "null", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    matches = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", process.stdout or "")
    if not matches:
        return {"active": {"x": 0, "y": 0, "width": width, "height": height}, "focusX": .5, "focusY": .5}
    # Prefer the most frequently reported active-picture rectangle.
    counts: dict[tuple[int, int, int, int], int] = {}
    for raw in matches:
        item = tuple(int(value) for value in raw)
        counts[item] = counts.get(item, 0) + 1
    crop_w, crop_h, crop_x, crop_y = max(counts, key=counts.get)
    focus_x = max(0.0, min(1.0, (crop_x + crop_w / 2) / max(1, width)))
    focus_y = max(0.0, min(1.0, (crop_y + crop_h / 2) / max(1, height)))
    return {
        "active": {"x": crop_x, "y": crop_y, "width": crop_w, "height": crop_h},
        "focusX": focus_x,
        "focusY": focus_y,
    }


def _reframe_crop(width: int, height: int, focus_x: float, focus_y: float, ratio: float) -> tuple[int, int, int, int]:
    source_ratio = width / height
    if source_ratio > ratio:
        crop_h = height
        crop_w = max(2, int(round(crop_h * ratio)))
    else:
        crop_w = width
        crop_h = max(2, int(round(crop_w / ratio)))
    cx = focus_x * width
    cy = focus_y * height
    x = int(round(cx - crop_w / 2))
    y = int(round(cy - crop_h / 2))
    x = max(0, min(width - crop_w, x))
    y = max(0, min(height - crop_h, y))
    # H.264/yuv420p is happier with even crop dimensions and offsets.
    crop_w -= crop_w % 2
    crop_h -= crop_h % 2
    x -= x % 2
    y -= y % 2
    return crop_w, crop_h, x, y


@router.post("/scenes")
async def scenes_v16(
    file: UploadFile = File(...),
    threshold: float = Form(.35),
    _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        duration, scenes = await asyncio.to_thread(_scene_ranges, source, threshold)
        return {"duration": duration, "threshold": max(.08, min(.85, threshold)), "scenes": scenes}
    finally:
        _cleanup(folder)


@router.post("/auto-color")
async def auto_color_v16(file: UploadFile = File(...), _username: str = Depends(require_auth)) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        result = await asyncio.to_thread(_auto_color_suggestion, source)
        result["color"] = await asyncio.to_thread(_source_color_info, source)
        return result
    finally:
        _cleanup(folder)


@router.post("/shot-analysis")
async def shot_analysis_v16(
    file: UploadFile = File(...),
    threshold: float = Form(.35),
    _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        return await asyncio.to_thread(_shot_color_analysis, source, threshold)
    finally:
        _cleanup(folder)


@router.post("/dialogue-clean")
async def dialogue_clean_v16(file: UploadFile = File(...), _username: str = Depends(require_auth)) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        probe = await asyncio.to_thread(_probe, source)
        if not _has_audio(probe):
            raise HTTPException(status_code=400, detail="المصدر لا يحتوي على صوت لتنظيف الحوار.")
        filters, used = _dialogue_filters()
        output = folder / "MAGHRABI-v16-dialogue-clean.mp4"
        command = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
            "-af", ",".join(filters), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", str(output),
        ]
        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(
            output,
            media_type="video/mp4",
            filename=output.name,
            background=BackgroundTask(_cleanup, folder),
            headers={"X-MAGHRABI-Engine": "Creator-V16-Dialogue", "X-MAGHRABI-Filters": ",".join(used)},
        )
    except Exception:
        _cleanup(folder)
        raise


@router.post("/smart-reframe")
async def smart_reframe_v16(
    file: UploadFile = File(...),
    target: str = Form("portrait"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    if target not in {"portrait", "square"}:
        raise HTTPException(status_code=400, detail="Smart Reframe يدعم Portrait أو Square حاليًا.")
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        probe = await asyncio.to_thread(_probe, source)
        duration = _duration(probe)
        width, height = _video_dimensions(probe)
        focus = await asyncio.to_thread(_cropdetect_focus, source, duration, width, height)
        out_w, out_h = (1080, 1920) if target == "portrait" else (1080, 1080)
        ratio = out_w / out_h
        crop_w, crop_h, crop_x, crop_y = _reframe_crop(width, height, focus["focusX"], focus["focusY"], ratio)
        output = folder / f"MAGHRABI-v16-reframe-{target}.mp4"
        command = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(source),
            "-vf", f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y},scale={out_w}:{out_h}:flags=lanczos,setsar=1,format=yuv420p",
            "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-profile:v", "high", "-pix_fmt", "yuv420p",
        ]
        if _has_audio(probe):
            command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
        else:
            command += ["-an"]
        command += ["-movflags", "+faststart", str(output)]
        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(
            output,
            media_type="video/mp4",
            filename=output.name,
            background=BackgroundTask(_cleanup, folder),
            headers={
                "X-MAGHRABI-Engine": "Creator-V16-Reframe",
                "X-MAGHRABI-Focus": f"{focus['focusX']:.4f},{focus['focusY']:.4f}",
            },
        )
    except Exception:
        _cleanup(folder)
        raise
