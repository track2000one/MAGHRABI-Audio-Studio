from __future__ import annotations

import asyncio
import json
import math
import re
import shutil
import subprocess
import tempfile
import zipfile
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import _cleanup, _duration, _has_audio, _probe, _run_ffmpeg, _save_upload, _workspace
from .video_tools_v14 import PRESETS, _audio_filters, _validate_audio, _validate_grade, _video_filters

router = APIRouter(prefix="/api/video/v15", tags=["video-studio-v15"])

COLOR_MODES = {"auto", "rec709", "hdr_to_sdr"}
SELECTIVE_FAMILIES = {"reds", "yellows", "greens", "cyans", "blues", "magentas", "neutrals"}


@lru_cache(maxsize=1)
def _filters_available() -> set[str]:
    process = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    found: set[str] = set()
    for line in (process.stdout or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] and set(parts[0]).issubset(set("TSC.AV|.")):
            found.add(parts[1])
    return found


def _source_color_info(path: Path) -> dict:
    process = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=color_space,color_transfer,color_primaries,pix_fmt,r_frame_rate,width,height",
            "-of", "json", str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        return {}
    try:
        stream = (json.loads(process.stdout).get("streams") or [{}])[0]
    except Exception:
        return {}
    transfer = str(stream.get("color_transfer") or "")
    primaries = str(stream.get("color_primaries") or "")
    is_hdr = transfer in {"smpte2084", "arib-std-b67"} or primaries == "bt2020"
    return {
        "colorSpace": stream.get("color_space"),
        "transfer": transfer or None,
        "primaries": primaries or None,
        "pixelFormat": stream.get("pix_fmt"),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "frameRate": stream.get("r_frame_rate"),
        "isHdr": is_hdr,
    }


def _safe_json(raw: str, detail: str) -> dict:
    try:
        value = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=detail) from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail=detail)
    return value


def _num(value: object, minimum: float, maximum: float, default: float) -> float:
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return default


def _validate_secondary(raw: str) -> dict:
    item = _safe_json(raw, "إعدادات Secondary Color غير صالحة.")
    family = str(item.get("family", "reds"))
    if family not in SELECTIVE_FAMILIES:
        family = "reds"
    return {
        "enabled": bool(item.get("enabled", False)),
        "family": family,
        "cyan": _num(item.get("cyan"), -1, 1, 0),
        "magenta": _num(item.get("magenta"), -1, 1, 0),
        "yellow": _num(item.get("yellow"), -1, 1, 0),
        "black": _num(item.get("black"), -1, 1, 0),
    }


def _validate_window(raw: str) -> dict:
    item = _safe_json(raw, "إعدادات Power Window غير صالحة.")
    return {
        "enabled": bool(item.get("enabled", False)),
        "x": _num(item.get("x"), 0, .95, .2),
        "y": _num(item.get("y"), 0, .95, .2),
        "width": _num(item.get("width"), .05, 1, .5),
        "height": _num(item.get("height"), .05, 1, .5),
        "brightness": _num(item.get("brightness"), -.5, .5, 0),
        "contrast": _num(item.get("contrast"), .5, 2, 1),
        "saturation": _num(item.get("saturation"), 0, 3, 1),
    }


def _validate_repair(raw: str) -> dict:
    item = _safe_json(raw, "إعدادات Audio Repair غير صالحة.")
    return {
        "noiseReduction": bool(item.get("noiseReduction", False)),
        "noiseStrength": _num(item.get("noiseStrength"), 0.01, .95, .35),
        "deesser": bool(item.get("deesser", False)),
        "deesserIntensity": _num(item.get("deesserIntensity"), 0, 1, .35),
        "stereoWidth": _num(item.get("stereoWidth"), 0, 2.5, 1),
    }


def _secondary_filter(settings: dict) -> str | None:
    if not settings["enabled"]:
        return None
    family = settings["family"]
    values = f"{settings['cyan']:.4f} {settings['magenta']:.4f} {settings['yellow']:.4f} {settings['black']:.4f}"
    return f"selectivecolor=correction_method=relative:{family}='{values}'"


def _color_management_filters(source_info: dict, mode: str) -> list[str]:
    if mode not in COLOR_MODES:
        mode = "auto"
    is_hdr = bool(source_info.get("isHdr"))
    if mode == "hdr_to_sdr":
        required = {"zscale", "tonemap"}
        missing = required - _filters_available()
        if missing:
            raise HTTPException(
                status_code=501,
                detail=f"HDR→SDR يحتاج فلاتر FFmpeg غير متاحة حاليًا: {', '.join(sorted(missing))}.",
            )
        if not is_hdr:
            return ["setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"]
        return [
            "zscale=t=linear:npl=100",
            "format=gbrpf32le",
            "zscale=p=bt709",
            "tonemap=tonemap=hable:desat=0",
            "zscale=t=bt709:m=bt709:r=tv",
            "format=yuv420p",
        ]
    if mode == "rec709" or (mode == "auto" and not is_hdr):
        return ["setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"]
    # Auto on HDR deliberately preserves the source look unless HDR→SDR is explicitly requested.
    return []


def _power_window_filter(settings: dict) -> str | None:
    if not settings["enabled"]:
        return None
    # A rectangular power window is rendered by cropping a corrected copy and overlaying it back.
    # This is intentionally deterministic and avoids pretending that an unsupported soft mask exists.
    x = settings["x"]
    y = settings["y"]
    w = min(settings["width"], 1 - x)
    h = min(settings["height"], 1 - y)
    return (
        f"crop=w=iw*{w:.6f}:h=ih*{h:.6f}:x=iw*{x:.6f}:y=ih*{y:.6f},"
        f"eq=brightness={settings['brightness']:.5f}:contrast={settings['contrast']:.5f}:saturation={settings['saturation']:.5f}"
    )


def _audio_repair_filters(settings: dict) -> list[str]:
    filters: list[str] = []
    available = _filters_available()
    if settings["noiseReduction"]:
        if "afftdn" not in available:
            raise HTTPException(status_code=501, detail="Noise Reduction يحتاج فلتر afftdn غير المتاح في FFmpeg الحالي.")
        # nr is reduction in dB. Map UI strength to a conservative 6..30 dB range.
        reduction = 6 + settings["noiseStrength"] * 24
        filters.append(f"afftdn=nr={reduction:.2f}:nf=-50")
    if settings["deesser"]:
        if "deesser" not in available:
            raise HTTPException(status_code=501, detail="De-esser غير متاح في FFmpeg الحالي.")
        filters.append(f"deesser=i={settings['deesserIntensity']:.4f}:m=0.5:f=0.5")
    if abs(settings["stereoWidth"] - 1) > .01:
        if "extrastereo" not in available:
            raise HTTPException(status_code=501, detail="Stereo Width يحتاج فلتر extrastereo غير المتاح في FFmpeg الحالي.")
        filters.append(f"extrastereo=m={settings['stereoWidth']:.4f}:c=1")
    return filters


def _build_video_filter_complex(source_info: dict, grade: dict, secondary: dict, window: dict, preset: dict, color_mode: str) -> str:
    base = _color_management_filters(source_info, color_mode)
    base += _video_filters(grade, preset)
    selective = _secondary_filter(secondary)
    if selective:
        base.insert(max(0, len(base) - 5), selective)
    window_filter = _power_window_filter(window)
    if not window_filter:
        return ",".join(base)

    # Apply the global grade, split, then locally correct one rectangular region and overlay it back.
    # Keep scale/pad/fps at the end so window coordinates are relative to the pre-delivery frame.
    delivery_tail = base[-5:] if len(base) >= 5 else []
    pre = base[:-5] if len(base) >= 5 else base
    prefix = ",".join(pre) if pre else "null"
    x = window["x"]
    y = window["y"]
    return (
        f"{prefix},split=2[base][win];"
        f"[win]{window_filter}[patch];"
        f"[base][patch]overlay=x=main_w*{x:.6f}:y=main_h*{y:.6f}[merged];"
        f"[merged]{','.join(delivery_tail)}"
    )


def _run_master(
    source: Path,
    output: Path,
    preset_name: str,
    grade: dict,
    audio: dict,
    secondary: dict,
    window: dict,
    repair: dict,
    color_mode: str,
) -> None:
    preset = PRESETS[preset_name]
    probe = _probe(source)
    source_info = _source_color_info(source)
    vf = _build_video_filter_complex(source_info, grade, secondary, window, preset, color_mode)
    command = ["ffmpeg", "-hide_banner", "-y", "-i", str(source)]
    if ";" in vf or "[" in vf:
        command += ["-filter_complex", f"[0:v]{vf}[vout]", "-map", "[vout]"]
        if _has_audio(probe):
            command += ["-map", "0:a:0?"]
    else:
        command += ["-vf", vf]

    if _has_audio(probe):
        af = _audio_repair_filters(repair) + _audio_filters(audio)
        if af:
            command += ["-af", ",".join(af)]

    command += [
        "-c:v", "libx264", "-preset", "medium", "-crf", str(preset["crf"]),
        "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    ]
    if _has_audio(probe):
        command += ["-c:a", "aac", "-b:a", str(preset["audio"]), "-ar", "48000", "-ac", "2"]
    else:
        command += ["-an"]
    command += [str(output)]
    _run_ffmpeg(command)


def _frame_rgb(path: Path, at: float) -> tuple[int, int, int]:
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0, at):.4f}", "-i", str(path),
            "-frames:v", "1", "-vf", "scale=1:1:flags=area,format=rgb24", "-f", "rawvideo", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0 or len(process.stdout) < 3:
        raise RuntimeError("تعذر أخذ عينة لونية من الفيديو.")
    return process.stdout[0], process.stdout[1], process.stdout[2]


def _run_qc(path: Path) -> dict:
    probe = _probe(path)
    color = _source_color_info(path)
    duration = _duration(probe)
    process = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
            "-vf", "blackdetect=d=0.5:pic_th=0.98,freezedetect=n=-50dB:d=1.5",
            "-af", "silencedetect=n=-42dB:d=1.0" if _has_audio(probe) else "anull",
            "-f", "null", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    text = process.stdout or ""
    black = re.findall(r"black_start:([\d.]+).*?black_end:([\d.]+)", text)
    freeze_starts = [float(x) for x in re.findall(r"freeze_start:\s*([\d.]+)", text)]
    freeze_ends = [float(x) for x in re.findall(r"freeze_end:\s*([\d.]+)", text)]
    silences = re.findall(r"silence_start:\s*([\d.]+).*?silence_end:\s*([\d.]+)", text, flags=re.S)
    issues: list[dict] = []
    for start, end in black[:30]:
        issues.append({"type": "black", "start": float(start), "end": float(end), "severity": "warning"})
    for index, start in enumerate(freeze_starts[:30]):
        end = freeze_ends[index] if index < len(freeze_ends) else min(duration, start + 1.5)
        issues.append({"type": "freeze", "start": start, "end": end, "severity": "warning"})
    for start, end in silences[:30]:
        issues.append({"type": "silence", "start": float(start), "end": float(end), "severity": "info"})
    return {
        "duration": duration,
        "hasAudio": _has_audio(probe),
        "color": color,
        "issues": sorted(issues, key=lambda item: item["start"]),
        "summary": {
            "black": sum(1 for item in issues if item["type"] == "black"),
            "freeze": sum(1 for item in issues if item["type"] == "freeze"),
            "silence": sum(1 for item in issues if item["type"] == "silence"),
        },
    }


@router.post("/inspect-source")
async def inspect_source_v15(file: UploadFile = File(...), _username: str = Depends(require_auth)) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        probe = await asyncio.to_thread(_probe, source)
        return {
            "duration": _duration(probe),
            "hasAudio": _has_audio(probe),
            "color": await asyncio.to_thread(_source_color_info, source),
            "filters": {name: name in _filters_available() for name in ["zscale", "tonemap", "selectivecolor", "afftdn", "deesser", "extrastereo"]},
        }
    finally:
        _cleanup(folder)


@router.post("/qc")
async def qc_v15(file: UploadFile = File(...), _username: str = Depends(require_auth)) -> dict:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        return await asyncio.to_thread(_run_qc, source)
    finally:
        _cleanup(folder)


@router.post("/shot-match")
async def shot_match_v15(
    target_file: UploadFile = File(...),
    reference_file: UploadFile = File(...),
    target_time: float = Form(0),
    reference_time: float = Form(0),
    _username: str = Depends(require_auth),
) -> dict:
    folder = _workspace()
    try:
        target = await _save_upload(target_file, folder, 0)
        reference = await _save_upload(reference_file, folder, 1)
        t_rgb, r_rgb = await asyncio.gather(
            asyncio.to_thread(_frame_rgb, target, target_time),
            asyncio.to_thread(_frame_rgb, reference, reference_time),
        )
        t_luma = .2126 * t_rgb[0] + .7152 * t_rgb[1] + .0722 * t_rgb[2]
        r_luma = .2126 * r_rgb[0] + .7152 * r_rgb[1] + .0722 * r_rgb[2]
        brightness = max(-.25, min(.25, (r_luma - t_luma) / 255))
        balance = {
            "r": max(-1, min(1, (r_rgb[0] - t_rgb[0]) / 128)),
            "g": max(-1, min(1, (r_rgb[1] - t_rgb[1]) / 128)),
            "b": max(-1, min(1, (r_rgb[2] - t_rgb[2]) / 128)),
        }
        t_range = max(t_rgb) - min(t_rgb)
        r_range = max(r_rgb) - min(r_rgb)
        saturation = max(.7, min(1.4, (r_range + 20) / (t_range + 20)))
        return {
            "targetRgb": {"r": t_rgb[0], "g": t_rgb[1], "b": t_rgb[2]},
            "referenceRgb": {"r": r_rgb[0], "g": r_rgb[1], "b": r_rgb[2]},
            "suggestion": {"brightness": brightness, "saturation": saturation, "gammaWheel": balance},
            "note": "Shot Match هو اقتراح إحصائي من متوسط اللون للفريم؛ راجعه بصريًا قبل الاعتماد.",
        }
    finally:
        _cleanup(folder)


@router.post("/master")
async def master_v15(
    file: UploadFile = File(...),
    grade: str = Form("{}"),
    audio: str = Form("{}"),
    secondary: str = Form("{}"),
    window: str = Form("{}"),
    repair: str = Form("{}"),
    color_mode: Literal["auto", "rec709", "hdr_to_sdr"] = Form("auto"),
    preset: Literal["youtube_1080", "tiktok", "instagram_reel", "instagram_square", "broadcast_1080p25", "master_1080"] = Form("youtube_1080"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        config = PRESETS[preset]
        output = folder / f"MAGHRABI-v15-{preset}.mp4"
        settings_grade = _validate_grade(grade)
        settings_audio = _validate_audio(audio, config)
        settings_secondary = _validate_secondary(secondary)
        settings_window = _validate_window(window)
        settings_repair = _validate_repair(repair)
        await asyncio.to_thread(
            _run_master, source, output, preset, settings_grade, settings_audio,
            settings_secondary, settings_window, settings_repair, color_mode,
        )
        return FileResponse(
            output,
            media_type="video/mp4",
            filename=output.name,
            background=BackgroundTask(_cleanup, folder),
            headers={"X-MAGHRABI-Engine": "Creator-V15-Advanced-Finishing"},
        )
    except Exception:
        _cleanup(folder)
        raise


@router.post("/batch-master")
async def batch_master_v15(
    file: UploadFile = File(...),
    grade: str = Form("{}"),
    audio: str = Form("{}"),
    secondary: str = Form("{}"),
    window: str = Form("{}"),
    repair: str = Form("{}"),
    color_mode: Literal["auto", "rec709", "hdr_to_sdr"] = Form("auto"),
    presets: str = Form('["youtube_1080"]'),
    _username: str = Depends(require_auth),
) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        try:
            requested = json.loads(presets)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="قائمة Batch Presets غير صالحة.") from exc
        if not isinstance(requested, list):
            raise HTTPException(status_code=400, detail="قائمة Batch Presets غير صالحة.")
        unique = []
        for item in requested:
            value = str(item)
            if value in PRESETS and value not in unique:
                unique.append(value)
        if not unique or len(unique) > 6:
            raise HTTPException(status_code=400, detail="اختر من 1 إلى 6 Presets للتصدير المجمع.")

        grade_settings = _validate_grade(grade)
        secondary_settings = _validate_secondary(secondary)
        window_settings = _validate_window(window)
        repair_settings = _validate_repair(repair)
        outputs: list[Path] = []
        for preset_name in unique:
            audio_settings = _validate_audio(audio, PRESETS[preset_name])
            output = folder / f"MAGHRABI-v15-{preset_name}.mp4"
            await asyncio.to_thread(
                _run_master, source, output, preset_name, grade_settings, audio_settings,
                secondary_settings, window_settings, repair_settings, color_mode,
            )
            outputs.append(output)

        archive = folder / "MAGHRABI-v15-batch-delivery.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for output in outputs:
                zf.write(output, arcname=output.name)
        return FileResponse(
            archive,
            media_type="application/zip",
            filename=archive.name,
            background=BackgroundTask(_cleanup, folder),
            headers={"X-MAGHRABI-Engine": "Creator-V15-Batch"},
        )
    except Exception:
        _cleanup(folder)
        raise
