from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from .video_tools_v3 import _safe_clip

_CONTEXT = threading.local()


def _normalize_color_grade(project: dict) -> dict:
    raw = project.get("colorGrade") or {}
    if not isinstance(raw, dict):
        raw = {}
    grade = {
        "enabled": bool(raw.get("enabled", False)),
        "exposure": _safe_clip(raw.get("exposure", 0), -3, 3, 0),
        "contrast": _safe_clip(raw.get("contrast", 1), .5, 2, 1),
        "highlights": _safe_clip(raw.get("highlights", 0), -1, 1, 0),
        "shadows": _safe_clip(raw.get("shadows", 0), -1, 1, 0),
        "whites": _safe_clip(raw.get("whites", 0), -1, 1, 0),
        "blacks": _safe_clip(raw.get("blacks", 0), -1, 1, 0),
        "temperature": _safe_clip(raw.get("temperature", 0), -1, 1, 0),
        "tint": _safe_clip(raw.get("tint", 0), -1, 1, 0),
        "saturation": _safe_clip(raw.get("saturation", 1), 0, 2, 1),
        "vibrance": _safe_clip(raw.get("vibrance", 0), -1, 1, 0),
        "hue": _safe_clip(raw.get("hue", 0), -180, 180, 0),
        "gamma": _safe_clip(raw.get("gamma", 1), .5, 2, 1),
        "curveShadows": _safe_clip(raw.get("curveShadows", 0), -1, 1, 0),
        "curveMidtones": _safe_clip(raw.get("curveMidtones", 0), -1, 1, 0),
        "curveHighlights": _safe_clip(raw.get("curveHighlights", 0), -1, 1, 0),
        "vignette": _safe_clip(raw.get("vignette", 0), 0, 1, 0),
        "sharpen": _safe_clip(raw.get("sharpen", 0), 0, 1, 0),
    }
    project["colorGrade"] = grade
    return grade


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _curve_filter(grade: dict) -> str | None:
    shadows = float(grade["shadows"])
    highlights = float(grade["highlights"])
    whites = float(grade["whites"])
    blacks = float(grade["blacks"])
    curve_s = float(grade["curveShadows"])
    curve_m = float(grade["curveMidtones"])
    curve_h = float(grade["curveHighlights"])
    if max(abs(shadows), abs(highlights), abs(whites), abs(blacks), abs(curve_s), abs(curve_m), abs(curve_h)) <= .001:
        return None

    p0 = _clamp(max(0.0, blacks * .075), 0.0, .18)
    p1 = _clamp(.22 + shadows * .135 + blacks * .040 + curve_s * .105, .03, .43)
    p2 = _clamp(.50 + curve_m * .105, .31, .69)
    p3 = _clamp(.78 + highlights * .135 + whites * .040 + curve_h * .105, .57, .97)
    p4 = _clamp(1.0 + min(0.0, whites) * .075, .82, 1.0)
    return f"curves=master='0/{p0:.5f} .22/{p1:.5f} .50/{p2:.5f} .78/{p3:.5f} 1/{p4:.5f}'"


def _grading_filters(grade: dict) -> list[str]:
    if not grade.get("enabled"):
        return []

    exposure = float(grade["exposure"])
    contrast = float(grade["contrast"])
    saturation = float(grade["saturation"])
    vibrance = float(grade["vibrance"])
    gamma = float(grade["gamma"])
    temperature = float(grade["temperature"])
    tint = float(grade["tint"])
    hue = float(grade["hue"])
    vignette = float(grade["vignette"])
    sharpen = float(grade["sharpen"])

    # Keep the renderer portable by composing filters already present in the
    # production FFmpeg build. Exposure is represented in EV and converted to
    # an additive luma offset; contrast/saturation/gamma remain independent.
    brightness = _clamp(exposure * .085, -.25, .25)
    vib_sat = _clamp(saturation * (1 + vibrance * .24), 0, 2.4)
    result = [f"eq=brightness={brightness:.5f}:contrast={contrast:.5f}:saturation={vib_sat:.5f}:gamma={gamma:.5f}"]

    curve = _curve_filter(grade)
    if curve:
        result.append(curve)

    if abs(temperature) > .001 or abs(tint) > .001:
        warm = temperature * .105
        magenta = tint * .070
        result.append(
            "colorbalance="
            f"rs={_clamp(warm + magenta * .45, -.25, .25):.5f}:"
            f"gs={_clamp(-magenta, -.25, .25):.5f}:"
            f"bs={_clamp(-warm + magenta * .45, -.25, .25):.5f}"
        )

    if abs(hue) > .001:
        result.append(f"hue=h={hue:.4f}")

    if vignette > .001:
        angle = 3.14159265 / max(2.0, 8.0 - 5.2 * vignette)
        result.append(f"vignette=angle={angle:.7f}")

    if sharpen > .001:
        amount = _clamp(sharpen * 1.35, 0, 1.35)
        result.append(f"unsharp=5:5:{amount:.4f}:5:5:0")

    return result


def _append_color_grade(filters: list[str], video_out: str, grade: dict | None) -> str:
    if not grade or not grade.get("enabled"):
        return video_out
    chain = _grading_filters(grade)
    if not chain:
        return video_out
    label = "mastergrade"
    filters.append(f"[{video_out}]{','.join(chain)}[{label}]")
    return label


def install_color_grading_engine() -> None:
    """Install master color grading on the V9/V10/V11/V12 render stack.

    V9 builds the timeline, then adds PIP, then invokes `_apply_master_lut`.
    Capturing grade metadata while the builder runs and applying it from the LUT
    hook gives the desired order: timeline/PIP -> LUT -> grade. Text Designer is
    installed after this module and appends text after this hook, so title colors
    remain outside the grading transform.
    """
    from . import video_tools_v9

    base_builder: Callable = video_tools_v9._build_v4_filters
    base_lut: Callable = video_tools_v9._apply_master_lut

    def build_with_color_context(
        project: dict,
        videos: list[Path],
        audios: list[Path],
        images: list[Path],
        video_probes: list[dict],
        width: int,
        height: int,
        folder: Path,
    ):
        grade = _normalize_color_grade(project)
        _CONTEXT.grade = grade
        return base_builder(project, videos, audios, images, video_probes, width, height, folder)

    def apply_lut_then_grade(filters: list[str], video_out: str, lut: Path | None) -> str:
        output = base_lut(filters, video_out, lut)
        try:
            grade = getattr(_CONTEXT, "grade", None)
            return _append_color_grade(filters, output, grade)
        finally:
            if hasattr(_CONTEXT, "grade"):
                delattr(_CONTEXT, "grade")

    video_tools_v9._build_v4_filters = build_with_color_context
    video_tools_v9._apply_master_lut = apply_lut_then_grade
