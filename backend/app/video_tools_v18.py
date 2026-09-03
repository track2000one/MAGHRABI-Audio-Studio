from __future__ import annotations

import asyncio
import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import _cleanup, _duration, _has_audio, _probe, _run_ffmpeg, _save_upload, _workspace
from .video_tools_v17 import (
    _compact_points,
    _piecewise_expression,
    _render_dynamic_reframe,
    _track_region,
    _validate_box,
    _validate_track,
    _video_dimensions,
)

router = APIRouter(prefix="/api/video/v18", tags=["video-studio-v18"])
MAX_TARGETS = 4


def _motion_candidates(path: Path, at: float, window: float = 1.2) -> dict:
    probe = _probe(path)
    duration = _duration(probe)
    width, height = _video_dimensions(probe)
    at = max(0.0, min(duration, at))
    start = max(0.0, at - window / 2)
    end = min(duration, at + window / 2)
    if end - start < .2:
        start, end = 0.0, min(duration, 1.2)

    scale_w = 320
    scale_h = max(2, int(round(height * scale_w / width)))
    if scale_h % 2:
        scale_h += 1
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.4f}", "-i", str(path),
            "-t", f"{max(.2, end-start):.4f}", "-vf", f"fps=5,scale={scale_w}:{scale_h}:flags=area,format=gray",
            "-an", "-f", "rawvideo", "pipe:1",
        ],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    frame_size = scale_w * scale_h
    raw = np.frombuffer(process.stdout or b"", dtype=np.uint8)
    count = len(raw) // frame_size
    if count < 2:
        return {"duration": duration, "candidates": [], "method": "motion-grid"}
    frames = raw[: count * frame_size].reshape((count, scale_h, scale_w)).astype(np.float32)
    diffs = np.abs(np.diff(frames, axis=0))
    energy = np.mean(diffs, axis=0)

    grid_x, grid_y = 6, 4
    scores: list[tuple[float, int, int]] = []
    for gy in range(grid_y):
        y0 = int(gy * scale_h / grid_y)
        y1 = int((gy + 1) * scale_h / grid_y)
        for gx in range(grid_x):
            x0 = int(gx * scale_w / grid_x)
            x1 = int((gx + 1) * scale_w / grid_x)
            score = float(np.mean(energy[y0:y1, x0:x1]))
            scores.append((score, gx, gy))
    scores.sort(reverse=True)
    global_mean = float(np.mean(energy))
    global_std = float(np.std(energy))
    threshold = max(2.0, global_mean + .35 * global_std)

    candidates: list[dict] = []
    for score, gx, gy in scores:
        if score < threshold and candidates:
            break
        cx = (gx + .5) / grid_x
        cy = (gy + .5) / grid_y
        box_w = .26
        box_h = .38
        x = max(0.0, min(1 - box_w, cx - box_w / 2))
        y = max(0.0, min(1 - box_h, cy - box_h / 2))
        if any(abs((item["x"] + item["width"]/2) - cx) < .18 and abs((item["y"] + item["height"]/2) - cy) < .22 for item in candidates):
            continue
        confidence = max(.15, min(.95, score / max(4.0, threshold * 2.2)))
        candidates.append({"x": x, "y": y, "width": box_w, "height": box_h, "confidence": confidence, "kind": "motion"})
        if len(candidates) >= 6:
            break
    return {"duration": duration, "at": at, "candidates": candidates, "method": "motion-grid-temporal-energy"}


def _parse_boxes(raw: str) -> list[dict]:
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="قائمة الأهداف غير صالحة.") from exc
    if not isinstance(values, list) or not values:
        raise HTTPException(status_code=400, detail="اختر هدفًا واحدًا على الأقل.")
    output: list[dict] = []
    for item in values[:MAX_TARGETS]:
        output.append(_validate_box(json.dumps(item)))
    return output


def _multi_track(path: Path, boxes: list[dict], start: float, end: float, anchor: float, fps: float, search: float) -> dict:
    tracks = []
    for index, box in enumerate(boxes):
        result = _track_region(path, box, start, end, anchor, fps, search)
        result["targetId"] = index + 1
        tracks.append(result)
    confidence = float(np.mean([track["averageConfidence"] for track in tracks])) if tracks else 0.0
    return {"tracks": tracks, "averageConfidence": confidence, "targetCount": len(tracks)}


def _render_multi_blur(path: Path, output: Path, tracks: list[list[dict]], intensity: float) -> None:
    probe = _probe(path)
    width, height = _video_dimensions(probe)
    sigma = 4 + max(0.0, min(1.0, intensity)) * 28
    graph: list[str] = []
    previous = "0:v"
    for index, raw_points in enumerate(tracks[:MAX_TARGETS]):
        points = _compact_points(raw_points, 90)
        if not points:
            continue
        box_w = max(4, int(round(points[0]["width"] * width)))
        box_h = max(4, int(round(points[0]["height"] * height)))
        box_w -= box_w % 2
        box_h -= box_h % 2
        x_expr = _piecewise_expression(points, "x", width, max(0, width - box_w))
        y_expr = _piecewise_expression(points, "y", height, max(0, height - box_h))
        base = f"b{index}"
        region = f"r{index}"
        patch = f"p{index}"
        out = f"o{index}"
        graph.append(f"[{previous}]split=2[{base}][{region}]")
        graph.append(f"[{region}]crop={box_w}:{box_h}:x='{x_expr}':y='{y_expr}',gblur=sigma={sigma:.3f}[{patch}]")
        graph.append(f"[{base}][{patch}]overlay=x='{x_expr}':y='{y_expr}'[{out}]")
        previous = out
    if previous == "0:v":
        raise HTTPException(status_code=400, detail="لا توجد مسارات Tracking صالحة للتطبيق.")
    command = ["ffmpeg", "-hide_banner", "-y", "-i", str(path), "-filter_complex", ";".join(graph), "-map", f"[{previous}]"]
    if _has_audio(probe):
        command += ["-map", "0:a:0?", "-c:a", "copy"]
    command += ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    _run_ffmpeg(command)


def _merge_tracks_for_reframe(tracks: list[list[dict]]) -> list[dict]:
    valid = [track for track in tracks if track]
    if not valid:
        raise HTTPException(status_code=400, detail="لا توجد Tracking Data صالحة.")
    base = max(valid, key=len)
    merged: list[dict] = []
    for point in base:
        t = point["time"]
        active: list[dict] = []
        for track in valid:
            nearest = min(track, key=lambda item: abs(float(item["time"]) - t))
            if abs(float(nearest["time"]) - t) <= .35:
                active.append(nearest)
        if not active:
            active = [point]
        left = min(item["x"] for item in active)
        top = min(item["y"] for item in active)
        right = max(item["x"] + item["width"] for item in active)
        bottom = max(item["y"] + item["height"] for item in active)
        pad_x, pad_y = .06, .08
        left = max(0.0, left - pad_x)
        top = max(0.0, top - pad_y)
        right = min(1.0, right + pad_x)
        bottom = min(1.0, bottom + pad_y)
        merged.append({
            "time": t, "x": left, "y": top, "width": max(.03, right-left), "height": max(.03, bottom-top),
            "confidence": float(np.mean([item.get("confidence", 1.0) for item in active])),
        })
    return merged


def _stt_capability() -> dict:
    url = os.getenv("STT_WORKER_URL", "").strip()
    return {"configured": bool(url), "provider": "external-worker" if url else None}


def _stt_request(data: bytes, content_type: str, language: str) -> dict[str, Any]:
    url = os.getenv("STT_WORKER_URL", "").strip()
    if not url:
        raise HTTPException(status_code=501, detail="Speech-to-Text Worker غير مهيأ. أضف STT_WORKER_URL في Railway عند تجهيز Worker منفصل.")
    headers = {"Content-Type": content_type or "application/octet-stream", "X-Language": language}
    token = os.getenv("STT_WORKER_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="تعذر الحصول على نتيجة من Speech-to-Text Worker.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="صيغة استجابة Speech-to-Text Worker غير صالحة.")
    return payload


@router.post("/motion-candidates")
async def motion_candidates_v18(file: UploadFile = File(...), at: float = Form(0), _username: str = Depends(require_auth)) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        return await asyncio.to_thread(_motion_candidates, source, at)
    finally:
        _cleanup(folder)


@router.post("/multi-track")
async def multi_track_v18(
    file: UploadFile = File(...), boxes: str = Form(...), start: float = Form(0), end: float = Form(30),
    anchor: float = Form(0), fps: float = Form(5), search: float = Form(.09), _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        targets = _parse_boxes(boxes)
        return await asyncio.to_thread(_multi_track, source, targets, start, end, anchor, fps, search)
    finally:
        _cleanup(folder)


@router.post("/multi-blur")
async def multi_blur_v18(file: UploadFile = File(...), tracks: str = Form(...), intensity: float = Form(.7), _username: str = Depends(require_auth)) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        try:
            raw = json.loads(tracks)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Tracking Data غير صالحة.") from exc
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="Tracking Data غير صالحة.")
        cleaned = [_validate_track(json.dumps(item)) for item in raw[:MAX_TARGETS]]
        output = folder / "MAGHRABI-v18-auto-multi-blur.mp4"
        await asyncio.to_thread(_render_multi_blur, source, output, cleaned, intensity)
        return FileResponse(output, media_type="video/mp4", filename=output.name, background=BackgroundTask(_cleanup, folder), headers={"X-MAGHRABI-Engine": "Creator-V18-MultiBlur"})
    except Exception:
        _cleanup(folder)
        raise


@router.post("/multi-reframe")
async def multi_reframe_v18(file: UploadFile = File(...), tracks: str = Form(...), target: str = Form("portrait"), _username: str = Depends(require_auth)) -> FileResponse:
    if target not in {"portrait", "square"}:
        raise HTTPException(status_code=400, detail="Multi Subject Reframe يدعم Portrait أو Square.")
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        try:
            raw = json.loads(tracks)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Tracking Data غير صالحة.") from exc
        cleaned = [_validate_track(json.dumps(item)) for item in raw[:MAX_TARGETS]] if isinstance(raw, list) else []
        merged = _merge_tracks_for_reframe(cleaned)
        output = folder / f"MAGHRABI-v18-multi-reframe-{target}.mp4"
        await asyncio.to_thread(_render_dynamic_reframe, source, output, merged, target)
        return FileResponse(output, media_type="video/mp4", filename=output.name, background=BackgroundTask(_cleanup, folder), headers={"X-MAGHRABI-Engine": "Creator-V18-MultiReframe"})
    except Exception:
        _cleanup(folder)
        raise


@router.get("/stt-capability")
async def stt_capability_v18(_username: str = Depends(require_auth)) -> dict:
    return _stt_capability()


@router.post("/transcribe")
async def transcribe_v18(file: UploadFile = File(...), language: str = Form("ar"), _username: str = Depends(require_auth)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="ملف الصوت/الفيديو فارغ.")
    if len(data) > 80 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="الملف أكبر من الحد المسموح لخدمة STT وهو 80MB.")
    return await asyncio.to_thread(_stt_request, data, file.content_type or "application/octet-stream", language[:12])
