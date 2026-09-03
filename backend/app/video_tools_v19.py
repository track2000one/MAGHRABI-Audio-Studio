from __future__ import annotations

import asyncio
import json
import math
import os
import subprocess
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import _cleanup, _duration, _has_audio, _probe, _run_ffmpeg, _save_upload, _workspace
from .video_tools_v15 import _filters_available
from .video_tools_v16 import _scene_ranges
from .video_tools_v17 import _best_match, _gray_frames, _validate_box, _video_dimensions
from .video_tools_v18 import _stt_capability, _stt_request

router = APIRouter(prefix="/api/video/v19", tags=["video-studio-v19"])
MAX_TRACK_SECONDS = 120.0
MAX_TRACK_POINTS = 700


def _resize_nearest(image: np.ndarray, width: int, height: int) -> np.ndarray:
    height = max(6, int(height))
    width = max(6, int(width))
    src_h, src_w = image.shape
    ys = np.minimum(src_h - 1, (np.arange(height) * src_h / height).astype(np.int32))
    xs = np.minimum(src_w - 1, (np.arange(width) * src_w / width).astype(np.int32))
    return image[ys[:, None], xs[None, :]]


def _adaptive_direction(
    frames: np.ndarray,
    indices: list[int],
    template: np.ndarray,
    x: int,
    y: int,
    radius: int,
) -> dict[int, tuple[int, int, int, int, float, bool]]:
    current = template.astype(np.float32)
    current_w = template.shape[1]
    current_h = template.shape[0]
    result: dict[int, tuple[int, int, int, int, float, bool]] = {}
    low_streak = 0

    for index in indices:
        frame = frames[index]
        frame_h, frame_w = frame.shape
        search_radius = radius if low_streak < 2 else min(96, int(radius * (1.7 if low_streak < 5 else 2.5)))
        best: tuple[int, int, int, int, float, np.ndarray] | None = None
        for scale in (.90, .96, 1.0, 1.04, 1.10):
            test_w = max(8, min(frame_w - 2, int(round(current_w * scale))))
            test_h = max(8, min(frame_h - 2, int(round(current_h * scale))))
            candidate_template = _resize_nearest(current.astype(np.uint8), test_w, test_h)
            px = max(0, min(frame_w - test_w, int(round(x + (current_w - test_w) / 2))))
            py = max(0, min(frame_h - test_h, int(round(y + (current_h - test_h) / 2))))
            mx, my, confidence = _best_match(frame, candidate_template, px, py, search_radius)
            if best is None or confidence > best[4]:
                best = (mx, my, test_w, test_h, confidence, candidate_template)

        if best is None:
            result[index] = (x, y, current_w, current_h, 0.0, True)
            low_streak += 1
            continue

        bx, by, bw, bh, confidence, candidate_template = best
        occluded = confidence < .30
        if occluded:
            low_streak += 1
            # Freeze the last reliable pose for brief occlusions; broaden search next frame.
            result[index] = (x, y, current_w, current_h, confidence, True)
            continue

        low_streak = 0 if confidence >= .46 else low_streak + 1
        x, y, current_w, current_h = bx, by, bw, bh
        patch = frame[y:y + current_h, x:x + current_w]
        if patch.shape == (current_h, current_w) and confidence >= .38:
            normalized_patch = _resize_nearest(patch, template.shape[1], template.shape[0]).astype(np.float32)
            normalized_current = _resize_nearest(current.astype(np.uint8), template.shape[1], template.shape[0]).astype(np.float32)
            alpha = .07 if confidence >= .58 else .025
            current = normalized_current * (1 - alpha) + normalized_patch * alpha
            current_w = bw
            current_h = bh
        result[index] = (x, y, current_w, current_h, confidence, False)
    return result


def _smooth_track(points: list[dict]) -> list[dict]:
    if len(points) < 3:
        return points
    output: list[dict] = []
    for index, item in enumerate(points):
        lo = max(0, index - 1)
        hi = min(len(points), index + 2)
        window = points[lo:hi]
        clone = dict(item)
        if not item.get("occluded"):
            for key in ("x", "y", "width", "height"):
                clone[key] = float(np.median([float(point[key]) for point in window]))
        output.append(clone)
    return output


def _adaptive_track(path: Path, box: dict, start: float, end: float, anchor: float, fps: float, search: float) -> dict:
    probe = _probe(path)
    duration = _duration(probe)
    source_w, source_h = _video_dimensions(probe)
    start = max(0.0, min(max(0.0, duration - .02), start))
    end = max(start + .08, min(duration, end))
    if end - start > MAX_TRACK_SECONDS:
        end = start + MAX_TRACK_SECONDS
    fps = max(2.0, min(8.0, fps))
    anchor = max(start, min(end, anchor))

    frames, frame_w, frame_h = _gray_frames(path, start, end, fps, source_w, source_h)
    frames = frames[:MAX_TRACK_POINTS]
    count = len(frames)
    anchor_index = max(0, min(count - 1, int(round((anchor - start) * fps))))
    x = int(round(box["x"] * frame_w))
    y = int(round(box["y"] * frame_h))
    w = max(10, min(frame_w - x, int(round(box["width"] * frame_w))))
    h = max(10, min(frame_h - y, int(round(box["height"] * frame_h))))
    template = frames[anchor_index][y:y + h, x:x + w].copy()
    if template.size < 64:
        raise HTTPException(status_code=400, detail="منطقة الهدف صغيرة جدًا للتتبع المتكيف.")
    radius = max(8, min(62, int(round(max(.03, min(.20, search)) * frame_w))))

    poses: dict[int, tuple[int, int, int, int, float, bool]] = {anchor_index: (x, y, w, h, 1.0, False)}
    poses.update(_adaptive_direction(frames, list(range(anchor_index + 1, count)), template, x, y, radius))
    poses.update(_adaptive_direction(frames, list(range(anchor_index - 1, -1, -1)), template, x, y, radius))

    points: list[dict] = []
    for index in range(count):
        px, py, pw, ph, confidence, occluded = poses.get(index, (x, y, w, h, 0.0, True))
        points.append({
            "time": min(end, start + index / fps),
            "x": max(0.0, min(1.0, px / frame_w)),
            "y": max(0.0, min(1.0, py / frame_h)),
            "width": max(.02, min(1.0, pw / frame_w)),
            "height": max(.02, min(1.0, ph / frame_h)),
            "confidence": confidence,
            "occluded": occluded,
        })
    points = _smooth_track(points)
    confidence_values = [float(point["confidence"]) for point in points]
    scale_values = [float(point["width"] * point["height"]) for point in points]
    return {
        "duration": duration,
        "range": {"start": start, "end": end, "anchor": anchor},
        "fps": fps,
        "source": {"width": source_w, "height": source_h},
        "points": points,
        "averageConfidence": float(np.mean(confidence_values)) if confidence_values else 0.0,
        "lowConfidencePoints": sum(1 for value in confidence_values if value < .38),
        "occlusionPoints": sum(1 for point in points if point["occluded"]),
        "scaleChange": (max(scale_values) / max(1e-6, min(scale_values))) if scale_values else 1.0,
        "method": "scale-adaptive-template-tracking-with-occlusion-recovery",
    }


def _camera_motion(path: Path) -> dict:
    probe = _probe(path)
    duration = _duration(probe)
    source_w, source_h = _video_dimensions(probe)
    scale_w = 256
    scale_h = max(2, int(round(source_h * scale_w / source_w)))
    if scale_h % 2:
        scale_h += 1
    sample_fps = 2.0
    process = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vf", f"fps={sample_fps},scale={scale_w}:{scale_h}:flags=area,format=gray", "-frames:v", "180", "-an", "-f", "rawvideo", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    raw = np.frombuffer(process.stdout or b"", dtype=np.uint8)
    frame_size = scale_w * scale_h
    count = len(raw) // frame_size
    if count < 2:
        return {"duration": duration, "samples": [], "classification": "unknown", "stability": 0.0}
    frames = raw[:count * frame_size].reshape((count, scale_h, scale_w)).astype(np.float32)
    shifts: list[dict] = []
    for index in range(1, len(frames)):
        a = frames[index - 1] - np.mean(frames[index - 1])
        b = frames[index] - np.mean(frames[index])
        fa = np.fft.fft2(a)
        fb = np.fft.fft2(b)
        cross = fa * np.conj(fb)
        cross /= np.maximum(np.abs(cross), 1e-9)
        corr = np.abs(np.fft.ifft2(cross))
        py, px = np.unravel_index(int(np.argmax(corr)), corr.shape)
        dx = float(px if px <= scale_w // 2 else px - scale_w)
        dy = float(py if py <= scale_h // 2 else py - scale_h)
        # phase correlation direction is inverse of apparent camera movement.
        dx, dy = -dx, -dy
        shifts.append({"time": index / sample_fps, "dx": dx / scale_w, "dy": dy / scale_h, "magnitude": math.hypot(dx / scale_w, dy / scale_h)})
    magnitudes = [item["magnitude"] for item in shifts]
    mean_mag = float(np.mean(magnitudes)) if magnitudes else 0.0
    std_mag = float(np.std(magnitudes)) if magnitudes else 0.0
    mean_dx = float(np.mean([item["dx"] for item in shifts])) if shifts else 0.0
    mean_dy = float(np.mean([item["dy"] for item in shifts])) if shifts else 0.0
    if mean_mag < .003:
        classification = "locked/static"
    elif abs(mean_dx) > abs(mean_dy) * 1.6 and abs(mean_dx) > .004:
        classification = "pan-horizontal"
    elif abs(mean_dy) > abs(mean_dx) * 1.6 and abs(mean_dy) > .004:
        classification = "tilt-vertical"
    elif std_mag > mean_mag * .75:
        classification = "handheld/shaky"
    else:
        classification = "mixed-motion"
    stability = max(0.0, min(1.0, 1.0 - mean_mag * 24 - std_mag * 10))
    return {"duration": duration, "samples": shifts[:180], "meanDx": mean_dx, "meanDy": mean_dy, "meanMagnitude": mean_mag, "jitter": std_mag, "classification": classification, "stability": stability}


def _stabilize(path: Path, output: Path, strength: float) -> str:
    available = _filters_available()
    strength = max(.1, min(1.0, strength))
    probe = _probe(path)
    if "vidstabdetect" in available and "vidstabtransform" in available:
        transforms = output.parent / "transforms.trf"
        shakiness = max(2, min(10, int(round(3 + strength * 7))))
        accuracy = max(8, min(15, int(round(8 + strength * 7))))
        _run_ffmpeg(["ffmpeg", "-hide_banner", "-y", "-i", str(path), "-vf", f"vidstabdetect=shakiness={shakiness}:accuracy={accuracy}:result={transforms}", "-f", "null", "-"])
        command = ["ffmpeg", "-hide_banner", "-y", "-i", str(path), "-vf", f"vidstabtransform=input={transforms}:smoothing={max(5,int(8+strength*22))}:zoom={int(2+strength*5)},unsharp=5:5:0.4:3:3:0.2", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
        engine = "vidstab"
    elif "deshake" in available:
        edge = int(round(8 + strength * 24))
        command = ["ffmpeg", "-hide_banner", "-y", "-i", str(path), "-vf", f"deshake=x={edge}:y={edge}:edge=mirror", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
        engine = "deshake"
    else:
        raise HTTPException(status_code=501, detail="FFmpeg في هذه البيئة لا يحتوي vidstab أو deshake المطلوب للتثبيت.")
    if _has_audio(probe):
        command += ["-c:a", "aac", "-b:a", "192k"]
    else:
        command += ["-an"]
    command += ["-movflags", "+faststart", str(output)]
    _run_ffmpeg(command)
    return engine


def _scene_motion_score(path: Path, start: float, end: float) -> float:
    length = max(.2, end - start)
    sample = min(2.0, length)
    midpoint = start + length / 2
    sample_start = max(start, midpoint - sample / 2)
    process = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{sample_start:.4f}", "-i", str(path), "-t", f"{sample:.4f}", "-vf", "fps=4,scale=160:-2:flags=area,format=gray", "-an", "-f", "rawvideo", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    # infer height from 160 width and source dimensions instead of parsing raw shape externally.
    probe = _probe(path)
    w, h = _video_dimensions(probe)
    sh = max(2, int(round(h * 160 / w)))
    if sh % 2:
        sh += 1
    raw = np.frombuffer(process.stdout or b"", dtype=np.uint8)
    size = 160 * sh
    count = len(raw) // size
    if count < 2:
        return 0.0
    frames = raw[:count * size].reshape((count, sh, 160)).astype(np.float32)
    return float(np.mean(np.abs(np.diff(frames, axis=0))) / 32.0)


def _audio_peak_score(path: Path, start: float, end: float) -> float:
    process = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start:.4f}", "-i", str(path), "-t", f"{max(.2,end-start):.4f}", "-af", "volumedetect", "-vn", "-f", "null", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False,
    )
    import re
    match = re.search(r"max_volume:\s*(-?[\d.]+) dB", process.stdout or "")
    if not match:
        return .35
    db = float(match.group(1))
    return max(0.0, min(1.0, (db + 36.0) / 36.0))


def _production_analysis(path: Path, threshold: float) -> dict:
    probe = _probe(path)
    duration, scenes = _scene_ranges(path, threshold)
    has_audio = _has_audio(probe)
    analyzed: list[dict] = []
    for scene in scenes[:30]:
        motion = _scene_motion_score(path, scene["start"], scene["end"])
        audio = _audio_peak_score(path, scene["start"], scene["end"]) if has_audio else .35
        length = scene["duration"]
        duration_score = 1.0 if 2 <= length <= 12 else max(.2, 1 - abs(length - 7) / 20)
        score = max(0.0, min(1.0, motion * .48 + audio * .34 + duration_score * .18))
        analyzed.append({**scene, "motionScore": motion, "audioScore": audio, "highlightScore": score})
    highlights = sorted(analyzed, key=lambda item: item["highlightScore"], reverse=True)[:8]
    cut_list = [{"start": item["start"], "end": item["end"], "duration": item["duration"], "label": f"SHOT {index+1}"} for index, item in enumerate(analyzed)]
    return {"duration": duration, "sceneCount": len(scenes), "analyzedCount": len(analyzed), "cutList": cut_list, "highlights": highlights, "hasAudio": has_audio}


@router.post("/adaptive-track")
async def adaptive_track_v19(file: UploadFile = File(...), box: str = Form(...), start: float = Form(0), end: float = Form(30), anchor: float = Form(0), fps: float = Form(5), search: float = Form(.09), _username: str = Depends(require_auth)) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        settings = _validate_box(box)
        return await asyncio.to_thread(_adaptive_track, source, settings, start, end, anchor, fps, search)
    finally:
        _cleanup(folder)


@router.post("/camera-motion")
async def camera_motion_v19(file: UploadFile = File(...), _username: str = Depends(require_auth)) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        return await asyncio.to_thread(_camera_motion, source)
    finally:
        _cleanup(folder)


@router.post("/stabilize")
async def stabilize_v19(file: UploadFile = File(...), strength: float = Form(.65), _username: str = Depends(require_auth)) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        output = folder / "MAGHRABI-v19-stabilized.mp4"
        engine = await asyncio.to_thread(_stabilize, source, output, strength)
        return FileResponse(output, media_type="video/mp4", filename=output.name, background=BackgroundTask(_cleanup, folder), headers={"X-MAGHRABI-Engine": f"Creator-V19-{engine}"})
    except Exception:
        _cleanup(folder)
        raise


@router.post("/production-analysis")
async def production_analysis_v19(file: UploadFile = File(...), threshold: float = Form(.35), _username: str = Depends(require_auth)) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        return await asyncio.to_thread(_production_analysis, source, max(.08, min(.85, threshold)))
    finally:
        _cleanup(folder)


@router.get("/whisper-capability")
async def whisper_capability_v19(_username: str = Depends(require_auth)) -> dict:
    base = _stt_capability()
    return {**base, "recommendedProvider": "faster-whisper-worker", "languageDefault": "ar", "contract": {"method": "POST", "body": "raw media bytes", "headers": ["Content-Type", "X-Language", "Authorization optional"], "response": "{text, segments:[{start,end,text}]}"}}


@router.post("/transcribe")
async def transcribe_v19(file: UploadFile = File(...), language: str = Form("ar"), _username: str = Depends(require_auth)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="الملف فارغ.")
    if len(data) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="الملف أكبر من حد V19 STT وهو 100MB.")
    return await asyncio.to_thread(_stt_request, data, file.content_type or "application/octet-stream", language[:12])
