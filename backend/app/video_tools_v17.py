from __future__ import annotations

import asyncio
import json
import math
import re
import subprocess
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import _cleanup, _duration, _has_audio, _probe, _run_ffmpeg, _save_upload, _workspace
from .video_tools_v15 import _filters_available, _source_color_info

router = APIRouter(prefix="/api/video/v17", tags=["video-studio-v17"])

MAX_TRACK_SECONDS = 120.0
MAX_TRACK_POINTS = 650


def _video_dimensions(probe: dict) -> tuple[int, int]:
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            try:
                width = int(stream.get("width") or 0)
                height = int(stream.get("height") or 0)
                if width > 1 and height > 1:
                    return width, height
            except (TypeError, ValueError):
                pass
    raise RuntimeError("تعذر قراءة أبعاد الفيديو.")


def _num(value: object, minimum: float, maximum: float, default: float) -> float:
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return default


def _validate_box(raw: str) -> dict[str, float]:
    try:
        item = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="منطقة Tracking غير صالحة.") from exc
    if not isinstance(item, dict):
        raise HTTPException(status_code=400, detail="منطقة Tracking غير صالحة.")
    x = _num(item.get("x"), 0, .97, .25)
    y = _num(item.get("y"), 0, .97, .2)
    width = _num(item.get("width"), .03, 1, .25)
    height = _num(item.get("height"), .03, 1, .3)
    width = min(width, 1 - x)
    height = min(height, 1 - y)
    if width < .03 or height < .03:
        raise HTTPException(status_code=400, detail="منطقة Tracking صغيرة جدًا أو خارج حدود الفيديو.")
    return {"x": x, "y": y, "width": width, "height": height}


def _gray_frames(path: Path, start: float, end: float, fps: float, source_w: int, source_h: int) -> tuple[np.ndarray, int, int]:
    scale_w = 320
    scale_h = max(2, int(round(source_h * scale_w / source_w)))
    if scale_h % 2:
        scale_h += 1
    duration = max(.05, end - start)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.6f}", "-i", str(path),
        "-t", f"{duration:.6f}", "-vf", f"fps={fps:.6f},scale={scale_w}:{scale_h}:flags=area,format=gray",
        "-an", "-f", "rawvideo", "pipe:1",
    ]
    process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if process.returncode != 0:
        raise RuntimeError("تعذر استخراج إطارات Tracking من الفيديو.")
    frame_size = scale_w * scale_h
    raw = np.frombuffer(process.stdout, dtype=np.uint8)
    count = len(raw) // frame_size
    if count < 1:
        raise RuntimeError("لم يتم العثور على إطارات كافية للتتبع.")
    count = min(count, MAX_TRACK_POINTS)
    frames = raw[: count * frame_size].reshape((count, scale_h, scale_w))
    return frames, scale_w, scale_h


def _best_match(frame: np.ndarray, template: np.ndarray, prev_x: int, prev_y: int, radius: int) -> tuple[int, int, float]:
    frame_h, frame_w = frame.shape
    patch_h, patch_w = template.shape
    max_x = max(0, frame_w - patch_w)
    max_y = max(0, frame_h - patch_h)
    x0 = max(0, prev_x - radius)
    x1 = min(max_x, prev_x + radius)
    y0 = max(0, prev_y - radius)
    y1 = min(max_y, prev_y + radius)

    sy = max(1, patch_h // 18)
    sx = max(1, patch_w // 18)
    signature = template[::sy, ::sx].astype(np.int16)
    sig_h, sig_w = signature.shape

    best_x, best_y = prev_x, prev_y
    best_error = float("inf")
    coarse_step = 3 if radius >= 14 else 2
    for y in range(y0, y1 + 1, coarse_step):
        for x in range(x0, x1 + 1, coarse_step):
            candidate = frame[y : y + patch_h : sy, x : x + patch_w : sx]
            candidate = candidate[:sig_h, :sig_w]
            if candidate.shape != signature.shape:
                continue
            error = float(np.mean(np.abs(candidate.astype(np.int16) - signature)))
            if error < best_error:
                best_error = error
                best_x, best_y = x, y

    refine = 3
    rx0, rx1 = max(0, best_x - refine), min(max_x, best_x + refine)
    ry0, ry1 = max(0, best_y - refine), min(max_y, best_y + refine)
    for y in range(ry0, ry1 + 1):
        for x in range(rx0, rx1 + 1):
            candidate = frame[y : y + patch_h : sy, x : x + patch_w : sx]
            candidate = candidate[:sig_h, :sig_w]
            if candidate.shape != signature.shape:
                continue
            error = float(np.mean(np.abs(candidate.astype(np.int16) - signature)))
            if error < best_error:
                best_error = error
                best_x, best_y = x, y

    confidence = max(0.0, min(1.0, 1.0 - best_error / 62.0))
    return best_x, best_y, confidence


def _track_direction(
    frames: np.ndarray,
    indices: list[int],
    anchor_template: np.ndarray,
    anchor_x: int,
    anchor_y: int,
    radius: int,
) -> dict[int, tuple[int, int, float]]:
    template = anchor_template.astype(np.float32)
    x, y = anchor_x, anchor_y
    result: dict[int, tuple[int, int, float]] = {}
    for index in indices:
        x, y, confidence = _best_match(frames[index], template.astype(np.uint8), x, y, radius)
        patch_h, patch_w = anchor_template.shape
        patch = frames[index][y : y + patch_h, x : x + patch_w]
        if patch.shape == anchor_template.shape and confidence >= .35:
            alpha = .08 if confidence >= .58 else .03
            template = template * (1 - alpha) + patch.astype(np.float32) * alpha
        result[index] = (x, y, confidence)
    return result


def _smooth_positions(points: list[dict]) -> list[dict]:
    if len(points) < 3:
        return points
    output: list[dict] = []
    for index, point in enumerate(points):
        lo = max(0, index - 1)
        hi = min(len(points), index + 2)
        xs = [points[i]["x"] for i in range(lo, hi)]
        ys = [points[i]["y"] for i in range(lo, hi)]
        item = dict(point)
        item["x"] = float(statistics_median(xs))
        item["y"] = float(statistics_median(ys))
        output.append(item)
    return output


def statistics_median(values: list[float]) -> float:
    ordered = sorted(values)
    size = len(ordered)
    if not size:
        return 0.0
    mid = size // 2
    if size % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def _track_region(path: Path, box: dict, start: float, end: float, anchor: float, fps: float, search: float) -> dict:
    probe = _probe(path)
    duration = _duration(probe)
    source_w, source_h = _video_dimensions(probe)
    start = max(0.0, min(duration - .02, start))
    end = max(start + .05, min(duration, end))
    if end - start > MAX_TRACK_SECONDS:
        end = start + MAX_TRACK_SECONDS
    anchor = max(start, min(end, anchor))
    fps = max(2.0, min(8.0, fps))

    frames, frame_w, frame_h = _gray_frames(path, start, end, fps, source_w, source_h)
    count = len(frames)
    anchor_index = max(0, min(count - 1, int(round((anchor - start) * fps))))

    patch_x = int(round(box["x"] * frame_w))
    patch_y = int(round(box["y"] * frame_h))
    patch_w = max(10, int(round(box["width"] * frame_w)))
    patch_h = max(10, int(round(box["height"] * frame_h)))
    patch_w = min(patch_w, frame_w - patch_x)
    patch_h = min(patch_h, frame_h - patch_y)
    if patch_w < 8 or patch_h < 8:
        raise HTTPException(status_code=400, detail="منطقة Tracking صغيرة جدًا بعد معاينة الفيديو.")

    anchor_template = frames[anchor_index][patch_y : patch_y + patch_h, patch_x : patch_x + patch_w].copy()
    radius = max(8, min(58, int(round(search * frame_w))))

    positions: dict[int, tuple[int, int, float]] = {anchor_index: (patch_x, patch_y, 1.0)}
    positions.update(_track_direction(frames, list(range(anchor_index + 1, count)), anchor_template, patch_x, patch_y, radius))
    positions.update(_track_direction(frames, list(range(anchor_index - 1, -1, -1)), anchor_template, patch_x, patch_y, radius))

    points: list[dict] = []
    for index in range(count):
        x, y, confidence = positions.get(index, (patch_x, patch_y, 0.0))
        points.append({
            "time": min(end, start + index / fps),
            "x": max(0.0, min(1.0 - box["width"], x / frame_w)),
            "y": max(0.0, min(1.0 - box["height"], y / frame_h)),
            "width": box["width"],
            "height": box["height"],
            "confidence": confidence,
        })
    points = _smooth_positions(points)
    average_confidence = float(np.mean([point["confidence"] for point in points])) if points else 0.0
    low_confidence = sum(1 for point in points if point["confidence"] < .38)
    return {
        "duration": duration,
        "range": {"start": start, "end": end, "anchor": anchor},
        "fps": fps,
        "source": {"width": source_w, "height": source_h},
        "box": box,
        "points": points,
        "averageConfidence": average_confidence,
        "lowConfidencePoints": low_confidence,
        "method": "numpy-template-block-tracking",
        "note": "يتتبع V17 انتقال المنطقة المحددة عبر Block Matching. راجع النقاط منخفضة الثقة بصريًا قبل التصدير النهائي.",
    }


def _validate_track(raw: str) -> list[dict]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="بيانات Tracking غير صالحة.") from exc
    points = payload.get("points") if isinstance(payload, dict) else payload
    if not isinstance(points, list) or len(points) < 1:
        raise HTTPException(status_code=400, detail="لا توجد نقاط Tracking صالحة.")
    cleaned: list[dict] = []
    for item in points[:MAX_TRACK_POINTS]:
        if not isinstance(item, dict):
            continue
        cleaned.append({
            "time": max(0.0, float(item.get("time", 0))),
            "x": _num(item.get("x"), 0, 1, 0),
            "y": _num(item.get("y"), 0, 1, 0),
            "width": _num(item.get("width"), .01, 1, .2),
            "height": _num(item.get("height"), .01, 1, .2),
            "confidence": _num(item.get("confidence"), 0, 1, 1),
        })
    cleaned.sort(key=lambda item: item["time"])
    if not cleaned:
        raise HTTPException(status_code=400, detail="لا توجد نقاط Tracking صالحة.")
    return cleaned


def _compact_points(points: list[dict], maximum: int = 100) -> list[dict]:
    if len(points) <= maximum:
        return points
    indices = np.linspace(0, len(points) - 1, maximum, dtype=int)
    return [points[int(index)] for index in indices]


def _piecewise_expression(points: list[dict], key: str, scale: float = 1.0, clamp_max: float | None = None) -> str:
    compact = _compact_points(points)
    values: list[tuple[float, float]] = []
    for item in compact:
        value = float(item[key]) * scale
        if clamp_max is not None:
            value = max(0.0, min(clamp_max, value))
        values.append((float(item["time"]), value))
    expression = f"{values[-1][1]:.4f}"
    for index in range(len(values) - 2, -1, -1):
        t0, v0 = values[index]
        t1, v1 = values[index + 1]
        delta = max(.001, t1 - t0)
        segment = f"({v0:.4f}+({v1 - v0:.4f})*(t-{t0:.4f})/{delta:.4f})"
        expression = f"if(lte(t,{t1:.4f}),{segment},{expression})"
    first_t, first_v = values[0]
    return f"if(lt(t,{first_t:.4f}),{first_v:.4f},{expression})"


def _render_tracked_effect(path: Path, output: Path, points: list[dict], effect: str, intensity: float) -> None:
    probe = _probe(path)
    width, height = _video_dimensions(probe)
    box_w = max(4, int(round(points[0]["width"] * width)))
    box_h = max(4, int(round(points[0]["height"] * height)))
    box_w = min(width, box_w - box_w % 2)
    box_h = min(height, box_h - box_h % 2)
    x_expr = _piecewise_expression(points, "x", width, max(0, width - box_w))
    y_expr = _piecewise_expression(points, "y", height, max(0, height - box_h))

    if effect == "blur":
        sigma = 3 + _num(intensity, 0, 1, .6) * 25
        patch_filter = f"gblur=sigma={sigma:.3f}"
    elif effect == "mosaic":
        divisor = max(4, int(round(5 + _num(intensity, 0, 1, .6) * 19)))
        small_w = max(2, (box_w // divisor) // 2 * 2)
        small_h = max(2, (box_h // divisor) // 2 * 2)
        patch_filter = f"scale={small_w}:{small_h}:flags=neighbor,scale={box_w}:{box_h}:flags=neighbor"
    elif effect == "spotlight":
        strength = _num(intensity, 0, 1, .6)
        patch_filter = f"eq=brightness={.04 + strength * .18:.4f}:contrast={1.02 + strength * .20:.4f}:saturation={1.0 + strength * .18:.4f}"
    else:
        raise HTTPException(status_code=400, detail="نوع Tracking Effect غير مدعوم.")

    graph = (
        f"[0:v]split=2[base][region];"
        f"[region]crop={box_w}:{box_h}:x='{x_expr}':y='{y_expr}',{patch_filter}[patch];"
        f"[base][patch]overlay=x='{x_expr}':y='{y_expr}'[vout]"
    )
    command = [
        "ffmpeg", "-hide_banner", "-y", "-i", str(path),
        "-filter_complex", graph, "-map", "[vout]",
    ]
    if _has_audio(probe):
        command += ["-map", "0:a:0?", "-c:a", "copy"]
    command += ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    _run_ffmpeg(command)


def _render_dynamic_reframe(path: Path, output: Path, points: list[dict], target: str) -> None:
    probe = _probe(path)
    width, height = _video_dimensions(probe)
    out_w, out_h = (1080, 1920) if target == "portrait" else (1080, 1080)
    ratio = out_w / out_h
    source_ratio = width / height
    if source_ratio > ratio:
        crop_h = height
        crop_w = max(2, int(round(crop_h * ratio)))
    else:
        crop_w = width
        crop_h = max(2, int(round(crop_w / ratio)))
    crop_w -= crop_w % 2
    crop_h -= crop_h % 2

    reframed: list[dict] = []
    for point in points:
        center_x = (point["x"] + point["width"] / 2) * width
        center_y = (point["y"] + point["height"] / 2) * height
        x = max(0.0, min(width - crop_w, center_x - crop_w / 2))
        y = max(0.0, min(height - crop_h, center_y - crop_h / 2))
        reframed.append({"time": point["time"], "xPx": x, "yPx": y})

    x_expr = _piecewise_expression(reframed, "xPx", 1.0, width - crop_w)
    y_expr = _piecewise_expression(reframed, "yPx", 1.0, height - crop_h)
    vf = f"crop={crop_w}:{crop_h}:x='{x_expr}':y='{y_expr}',scale={out_w}:{out_h}:flags=lanczos,setsar=1,format=yuv420p"
    command = [
        "ffmpeg", "-hide_banner", "-y", "-i", str(path), "-vf", vf,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
    ]
    if _has_audio(probe):
        command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    else:
        command += ["-an"]
    command += ["-movflags", "+faststart", str(output)]
    _run_ffmpeg(command)


def _speech_segments(path: Path, threshold_db: float, min_silence: float) -> dict:
    probe = _probe(path)
    if not _has_audio(probe):
        raise HTTPException(status_code=400, detail="المصدر لا يحتوي على صوت لتحليل Caption Assist.")
    duration = _duration(probe)
    threshold_db = max(-60.0, min(-18.0, threshold_db))
    min_silence = max(.2, min(3.0, min_silence))
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
            "-af", f"silencedetect=n={threshold_db:.2f}dB:d={min_silence:.3f}", "-f", "null", "-",
        ],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False,
    )
    text = process.stdout or ""
    starts = [float(value) for value in re.findall(r"silence_start:\s*([\d.]+)", text)]
    ends = [float(value) for value in re.findall(r"silence_end:\s*([\d.]+)", text)]
    silences: list[tuple[float, float]] = []
    for index, start in enumerate(starts):
        end = ends[index] if index < len(ends) else duration
        silences.append((max(0, start), min(duration, end)))

    speech: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in silences:
        if start - cursor >= .28:
            speech.append((cursor, start))
        cursor = max(cursor, end)
    if duration - cursor >= .28:
        speech.append((cursor, duration))

    segments: list[dict] = []
    for start, end in speech:
        length = end - start
        chunks = max(1, int(math.ceil(length / 4.2)))
        chunk = length / chunks
        for index in range(chunks):
            seg_start = start + index * chunk
            seg_end = end if index == chunks - 1 else start + (index + 1) * chunk
            if seg_end - seg_start >= .22:
                segments.append({"start": seg_start, "end": seg_end, "text": ""})
        if len(segments) >= 120:
            break
    return {"duration": duration, "thresholdDb": threshold_db, "minSilence": min_silence, "segments": segments}


def _ass_time(seconds: float) -> str:
    safe = max(0.0, seconds)
    hours = int(safe // 3600)
    minutes = int((safe % 3600) // 60)
    secs = safe % 60
    return f"{hours}:{minutes:02d}:{secs:05.2f}"


def _ass_escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\n", r"\N")


def _write_ass(path: Path, captions: list[dict], width: int, height: int) -> None:
    font_size = max(30, min(72, int(round(height * .045))))
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
        f"Style: Caption,DejaVu Sans,{font_size},&H00FFFFFF,&H000000FF,&H00111111,&H70000000,-1,0,0,0,100,100,0,0,1,3,1,2,70,70,{max(42, int(height*.055))},1",
        "",
        "[Events]",
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ]
    for caption in captions:
        text = _ass_escape(str(caption["text"]).strip())
        if not text:
            continue
        lines.append(f"Dialogue: 0,{_ass_time(caption['start'])},{_ass_time(caption['end'])},Caption,,0,0,0,,{text}")
    path.write_text("\n".join(lines), encoding="utf-8")


def _validate_captions(raw: str, duration: float) -> list[dict]:
    try:
        items = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="بيانات Captions غير صالحة.") from exc
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="بيانات Captions غير صالحة.")
    output: list[dict] = []
    for item in items[:120]:
        if not isinstance(item, dict):
            continue
        start = max(0.0, min(duration, float(item.get("start", 0))))
        end = max(start + .05, min(duration, float(item.get("end", start + 1))))
        text = str(item.get("text", "")).strip()[:240]
        if text:
            output.append({"start": start, "end": end, "text": text})
    if not output:
        raise HTTPException(status_code=400, detail="أدخل نص Caption واحدًا على الأقل.")
    return output


@router.post("/track")
async def track_v17(
    file: UploadFile = File(...),
    box: str = Form(...),
    start: float = Form(0),
    end: float = Form(30),
    anchor: float = Form(0),
    fps: float = Form(5),
    search: float = Form(.09),
    _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        settings = _validate_box(box)
        return await asyncio.to_thread(_track_region, source, settings, start, end, anchor, fps, _num(search, .02, .2, .09))
    finally:
        _cleanup(folder)


@router.post("/tracked-effect")
async def tracked_effect_v17(
    file: UploadFile = File(...),
    track: str = Form(...),
    effect: Literal["blur", "mosaic", "spotlight"] = Form("blur"),
    intensity: float = Form(.65),
    _username: str = Depends(require_auth),
) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        if _source_color_info(source).get("isHdr"):
            raise HTTPException(status_code=400, detail="حوّل مصدر HDR إلى SDR في V15 قبل تطبيق Tracking Effect لتجنب تغيير الألوان.")
        points = _validate_track(track)
        output = folder / f"MAGHRABI-v17-tracked-{effect}.mp4"
        await asyncio.to_thread(_render_tracked_effect, source, output, points, effect, intensity)
        return FileResponse(output, media_type="video/mp4", filename=output.name, background=BackgroundTask(_cleanup, folder), headers={"X-MAGHRABI-Engine": "Creator-V17-Tracking"})
    except Exception:
        _cleanup(folder)
        raise


@router.post("/dynamic-reframe")
async def dynamic_reframe_v17(
    file: UploadFile = File(...),
    track: str = Form(...),
    target: Literal["portrait", "square"] = Form("portrait"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        if _source_color_info(source).get("isHdr"):
            raise HTTPException(status_code=400, detail="حوّل مصدر HDR إلى SDR في V15 قبل Dynamic Reframe.")
        points = _validate_track(track)
        output = folder / f"MAGHRABI-v17-dynamic-{target}.mp4"
        await asyncio.to_thread(_render_dynamic_reframe, source, output, points, target)
        return FileResponse(output, media_type="video/mp4", filename=output.name, background=BackgroundTask(_cleanup, folder), headers={"X-MAGHRABI-Engine": "Creator-V17-Dynamic-Reframe"})
    except Exception:
        _cleanup(folder)
        raise


@router.post("/caption-segments")
async def caption_segments_v17(
    file: UploadFile = File(...),
    threshold_db: float = Form(-35),
    min_silence: float = Form(.45),
    _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        return await asyncio.to_thread(_speech_segments, source, threshold_db, min_silence)
    finally:
        _cleanup(folder)


@router.post("/burn-captions")
async def burn_captions_v17(
    file: UploadFile = File(...),
    captions: str = Form(...),
    _username: str = Depends(require_auth),
) -> FileResponse:
    if "subtitles" not in _filters_available():
        raise HTTPException(status_code=501, detail="Burn Captions يحتاج فلتر FFmpeg subtitles/libass غير المتاح في الخدمة الحالية.")
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        if _source_color_info(source).get("isHdr"):
            raise HTTPException(status_code=400, detail="حوّل مصدر HDR إلى SDR في V15 قبل Burn Captions.")
        probe = await asyncio.to_thread(_probe, source)
        duration = _duration(probe)
        width, height = _video_dimensions(probe)
        items = _validate_captions(captions, duration)
        ass_file = folder / "captions.ass"
        _write_ass(ass_file, items, width, height)
        output = folder / "MAGHRABI-v17-captioned.mp4"
        vf = f"subtitles='{ass_file}':fontsdir='/usr/share/fonts/truetype/dejavu'"
        command = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(source), "-vf", vf,
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        ]
        if _has_audio(probe):
            command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
        else:
            command += ["-an"]
        command += ["-movflags", "+faststart", str(output)]
        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(output, media_type="video/mp4", filename=output.name, background=BackgroundTask(_cleanup, folder), headers={"X-MAGHRABI-Engine": "Creator-V17-Captions"})
    except Exception:
        _cleanup(folder)
        raise
