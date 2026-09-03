from __future__ import annotations

import re
import subprocess
from pathlib import Path

from fastapi import HTTPException

from . import video_tools_v15 as base
from .video_tools import _duration, _has_audio, _probe

router = base.router


def _safe_color_management_filters(source_info: dict, mode: str) -> list[str]:
    if mode not in base.COLOR_MODES:
        mode = "auto"
    is_hdr = bool(source_info.get("isHdr"))

    if is_hdr and mode == "auto":
        mode = "hdr_to_sdr"

    if mode == "hdr_to_sdr":
        required = {"zscale", "tonemap"}
        missing = required - base._filters_available()
        if missing:
            raise HTTPException(
                status_code=501,
                detail=(
                    "تم اكتشاف مصدر HDR، لكن HDR→SDR الآمن يحتاج فلاتر FFmpeg غير المتاحة حاليًا: "
                    + ", ".join(sorted(missing))
                    + ". لن يتم إخراج ملف Rec.709 بوسوم لونية خاطئة."
                ),
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

    return ["setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"]


def _safe_run_qc(path: Path) -> dict:
    probe = _probe(path)
    color = base._source_color_info(path)
    duration = _duration(probe)
    has_audio = _has_audio(probe)

    command = [
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-vf", "blackdetect=d=0.5:pic_th=0.98,freezedetect=n=-50dB:d=1.5",
    ]
    if has_audio:
        command += ["-af", "silencedetect=n=-42dB:d=1.0"]
    command += ["-f", "null", "-"]

    process = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    text = process.stdout or ""
    black = re.findall(r"black_start:([\d.]+).*?black_end:([\d.]+)", text)
    freeze_starts = [float(x) for x in re.findall(r"freeze_start:\s*([\d.]+)", text)]
    freeze_ends = [float(x) for x in re.findall(r"freeze_end:\s*([\d.]+)", text)]
    silences = re.findall(r"silence_start:\s*([\d.]+).*?silence_end:\s*([\d.]+)", text, flags=re.S) if has_audio else []

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
        "hasAudio": has_audio,
        "color": color,
        "issues": sorted(issues, key=lambda item: item["start"]),
        "summary": {
            "black": sum(1 for item in issues if item["type"] == "black"),
            "freeze": sum(1 for item in issues if item["type"] == "freeze"),
            "silence": sum(1 for item in issues if item["type"] == "silence"),
        },
    }


base._color_management_filters = _safe_color_management_filters
base._run_qc = _safe_run_qc
