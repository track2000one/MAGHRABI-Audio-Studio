from __future__ import annotations

import asyncio
import json
import math
import re
import subprocess
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import _cleanup, _duration, _has_audio, _probe, _run_ffmpeg, _save_upload, _workspace

router = APIRouter(prefix="/api/video/v14", tags=["video-studio-v14"])

PRESETS: dict[str, dict] = {
    "youtube_1080": {"size": (1920, 1080), "fps": 30, "crf": 18, "audio": "192k", "lufs": -14.0, "label": "YouTube 1080p"},
    "tiktok": {"size": (1080, 1920), "fps": 30, "crf": 20, "audio": "192k", "lufs": -14.0, "label": "TikTok 9:16"},
    "instagram_reel": {"size": (1080, 1920), "fps": 30, "crf": 20, "audio": "192k", "lufs": -14.0, "label": "Instagram Reels"},
    "instagram_square": {"size": (1080, 1080), "fps": 30, "crf": 20, "audio": "192k", "lufs": -14.0, "label": "Instagram Square"},
    "broadcast_1080p25": {"size": (1920, 1080), "fps": 25, "crf": 16, "audio": "320k", "lufs": -23.0, "label": "Broadcast 1080p25"},
    "master_1080": {"size": (1920, 1080), "fps": 30, "crf": 15, "audio": "320k", "lufs": -14.0, "label": "Master 1080p"},
}


def _num(value: object, minimum: float, maximum: float, default: float) -> float:
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return default


def _rgb(raw: object) -> dict[str, float]:
    item = raw if isinstance(raw, dict) else {}
    return {
        "r": _num(item.get("r"), -1, 1, 0),
        "g": _num(item.get("g"), -1, 1, 0),
        "b": _num(item.get("b"), -1, 1, 0),
    }


def _curve_channel(raw: object) -> dict[str, float]:
    item = raw if isinstance(raw, dict) else {}
    return {
        "shadows": _num(item.get("shadows"), -.25, .25, 0),
        "mids": _num(item.get("mids"), -.25, .25, 0),
        "highlights": _num(item.get("highlights"), -.25, .25, 0),
    }


def _validate_grade(raw: str) -> dict:
    try:
        item = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="إعدادات Color Grade غير صالحة.") from exc
    if not isinstance(item, dict):
        raise HTTPException(status_code=400, detail="إعدادات Color Grade غير صالحة.")
    curves = item.get("curves") if isinstance(item.get("curves"), dict) else {}
    return {
        "brightness": _num(item.get("brightness"), -.5, .5, 0),
        "contrast": _num(item.get("contrast"), .5, 2.0, 1),
        "saturation": _num(item.get("saturation"), 0, 3.0, 1),
        "gamma": _num(item.get("gamma"), -1, 1, 0),
        "lift": _rgb(item.get("lift")),
        "gammaWheel": _rgb(item.get("gammaWheel")),
        "gain": _rgb(item.get("gain")),
        "curves": {
            "r": _curve_channel(curves.get("r")),
            "g": _curve_channel(curves.get("g")),
            "b": _curve_channel(curves.get("b")),
        },
    }


def _validate_audio(raw: str, preset: dict) -> dict:
    try:
        item = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="إعدادات Audio Master غير صالحة.") from exc
    if not isinstance(item, dict):
        raise HTTPException(status_code=400, detail="إعدادات Audio Master غير صالحة.")
    return {
        "low": _num(item.get("low"), -12, 12, 0),
        "mid": _num(item.get("mid"), -12, 12, 0),
        "high": _num(item.get("high"), -12, 12, 0),
        "compressor": bool(item.get("compressor", True)),
        "thresholdDb": _num(item.get("thresholdDb"), -48, -2, -18),
        "ratio": _num(item.get("ratio"), 1, 20, 3),
        "attack": _num(item.get("attack"), 1, 200, 20),
        "release": _num(item.get("release"), 20, 2000, 250),
        "limiter": bool(item.get("limiter", True)),
        "ceilingDb": _num(item.get("ceilingDb"), -6, -.1, -1),
        "normalize": bool(item.get("normalize", True)),
        "targetLufs": _num(item.get("targetLufs"), -24, -9, float(preset["lufs"])),
    }


def _curve_points(values: dict[str, float]) -> str:
    points = [
        (0.0, 0.0),
        (.25, max(0.0, min(1.0, .25 + values["shadows"]))),
        (.50, max(0.0, min(1.0, .50 + values["mids"]))),
        (.75, max(0.0, min(1.0, .75 + values["highlights"]))),
        (1.0, 1.0),
    ]
    return " ".join(f"{x:.3f}/{y:.3f}" for x, y in points)


def _video_filters(grade: dict, preset: dict) -> list[str]:
    gamma_value = 2 ** (grade["gamma"] * .5)
    filters = [
        f"eq=brightness={grade['brightness']:.5f}:contrast={grade['contrast']:.5f}:saturation={grade['saturation']:.5f}:gamma={gamma_value:.5f}",
    ]
    lift, mids, gain = grade["lift"], grade["gammaWheel"], grade["gain"]
    if any(abs(value) > .0005 for group in (lift, mids, gain) for value in group.values()):
        filters.append(
            "colorbalance="
            f"rs={lift['r']*.22:.5f}:gs={lift['g']*.22:.5f}:bs={lift['b']*.22:.5f}:"
            f"rm={mids['r']*.22:.5f}:gm={mids['g']*.22:.5f}:bm={mids['b']*.22:.5f}:"
            f"rh={gain['r']*.22:.5f}:gh={gain['g']*.22:.5f}:bh={gain['b']*.22:.5f}"
        )
    curves = grade["curves"]
    if any(abs(value) > .0005 for channel in curves.values() for value in channel.values()):
        filters.append(
            "curves="
            f"r='{_curve_points(curves['r'])}':"
            f"g='{_curve_points(curves['g'])}':"
            f"b='{_curve_points(curves['b'])}'"
        )
    width, height = preset["size"]
    filters.extend([
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black",
        f"fps={preset['fps']}",
        "setsar=1",
        "format=yuv420p",
    ])
    return filters


def _audio_filters(settings: dict) -> list[str]:
    filters = ["highpass=f=28"]
    if abs(settings["low"]) > .01:
        filters.append(f"equalizer=f=110:t=q:w=1.0:g={settings['low']:.3f}")
    if abs(settings["mid"]) > .01:
        filters.append(f"equalizer=f=1200:t=q:w=1.0:g={settings['mid']:.3f}")
    if abs(settings["high"]) > .01:
        filters.append(f"equalizer=f=8500:t=q:w=1.0:g={settings['high']:.3f}")
    if settings["compressor"]:
        threshold = max(.001, min(1.0, 10 ** (settings["thresholdDb"] / 20)))
        filters.append(
            f"acompressor=threshold={threshold:.6f}:ratio={settings['ratio']:.3f}:"
            f"attack={settings['attack']:.3f}:release={settings['release']:.3f}:makeup=1"
        )
    if settings["normalize"]:
        filters.append(f"loudnorm=I={settings['targetLufs']:.2f}:TP=-1.0:LRA=11")
    if settings["limiter"]:
        limit = max(.1, min(1.0, 10 ** (settings["ceilingDb"] / 20)))
        filters.append(f"alimiter=limit={limit:.6f}:attack=5:release=50")
    return filters


def _run_loudness(path: Path) -> dict:
    process = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    output = process.stdout or ""
    if process.returncode != 0:
        raise RuntimeError("تعذر تحليل Loudness للملف.")
    integrated = re.findall(r"I:\s*(-?\d+(?:\.\d+)?)\s+LUFS", output)
    lra = re.findall(r"LRA:\s*(-?\d+(?:\.\d+)?)\s+LU", output)
    peaks = re.findall(r"Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS", output)
    return {
        "integratedLufs": float(integrated[-1]) if integrated else None,
        "lra": float(lra[-1]) if lra else None,
        "truePeakDbfs": float(peaks[-1]) if peaks else None,
    }


@router.post("/analyze-audio")
async def analyze_audio_v14(
    file: UploadFile = File(...),
    _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        probe = await asyncio.to_thread(_probe, source)
        if not _has_audio(probe):
            raise HTTPException(status_code=400, detail="الفيديو لا يحتوي على مسار صوت لتحليل LUFS.")
        result = await asyncio.to_thread(_run_loudness, source)
        result["duration"] = _duration(probe)
        return result
    finally:
        _cleanup(folder)


@router.post("/master")
async def master_video_v14(
    file: UploadFile = File(...),
    grade: str = Form("{}"),
    audio: str = Form("{}"),
    preset: Literal["youtube_1080", "tiktok", "instagram_reel", "instagram_square", "broadcast_1080p25", "master_1080"] = Form("youtube_1080"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        probe = await asyncio.to_thread(_probe, source)
        config = PRESETS[preset]
        grade_settings = _validate_grade(grade)
        audio_settings = _validate_audio(audio, config)
        output = folder / f"MAGHRABI-v14-{preset}.mp4"

        command = ["ffmpeg", "-hide_banner", "-y", "-i", str(source)]
        command += ["-vf", ",".join(_video_filters(grade_settings, config))]
        if _has_audio(probe):
            command += ["-af", ",".join(_audio_filters(audio_settings))]
        command += [
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", str(config["crf"]),
            "-profile:v", "high",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
        ]
        if _has_audio(probe):
            command += ["-c:a", "aac", "-b:a", str(config["audio"]), "-ar", "48000", "-ac", "2"]
        else:
            command += ["-an"]
        command += [str(output)]
        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(
            output,
            media_type="video/mp4",
            filename=f"MAGHRABI-v14-{preset}.mp4",
            background=BackgroundTask(_cleanup, folder),
            headers={"X-MAGHRABI-Engine": "Creator-V14-Finishing"},
        )
    except Exception:
        _cleanup(folder)
        raise
