from __future__ import annotations

import copy
import re
import threading
from pathlib import Path
from typing import Callable

from .video_tools import FONT_FILE, _text_y
from .video_tools_v3 import _safe_clip

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
FONT_PRESETS = {
    "sans": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "sans-bold": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "serif": "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "serif-bold": "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "mono": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "mono-bold": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
}
TEXT_ANIMATIONS = {"none", "fade", "slide-up", "slide-left", "slide-right", "pop"}
TEXT_ALIGNS = {"left", "center", "right"}
_CONTEXT = threading.local()


def _color(value: object, fallback: str) -> str:
    text = str(value or fallback)
    return text if HEX.match(text) else fallback


def _ff_color(value: object, fallback: str) -> str:
    return _color(value, fallback).replace("#", "0x")


def _font(track: dict) -> str:
    requested = FONT_PRESETS.get(str(track.get("fontPreset", "sans-bold")), FONT_FILE)
    return requested if Path(requested).exists() else FONT_FILE


def _base_x(track: dict) -> str:
    raw_x = track.get("x")
    if raw_x is not None:
        x = _safe_clip(raw_x, 0, 1, .5)
        return f"(w-text_w)*{x:.6f}"
    align = str(track.get("align", "center"))
    if align not in TEXT_ALIGNS:
        align = "center"
    if align == "left":
        return "w*0.055"
    if align == "right":
        return "w-text_w-w*0.055"
    return "(w-text_w)/2"


def _base_y(track: dict) -> str:
    raw_y = track.get("y")
    if raw_y is not None:
        y = _safe_clip(raw_y, 0, 1, .5)
        return f"(h-text_h)*{y:.6f}"
    return _text_y(str(track.get("position", "bottom")))


def _progress(start: float, duration: float) -> str:
    return f"min(max((t-{start:.6f})/{max(.08, duration):.6f},0),1)"


def _alpha_expression(animation: str, start: float, end: float) -> str:
    if animation == "none":
        return "1"
    enter = min(.38, max(.12, (end - start) * .18))
    exit_d = min(.30, max(.10, (end - start) * .14))
    pin = _progress(start, enter)
    pout = f"min(max(({end:.6f}-t)/{exit_d:.6f},0),1)"
    if animation == "pop":
        enter = min(.22, max(.10, (end - start) * .12))
        pin = _progress(start, enter)
    return f"min({pin},{pout})"


def _motion_expression(base: str, axis: str, animation: str, start: float, end: float) -> str:
    enter = min(.42, max(.14, (end - start) * .20))
    p = _progress(start, enter)
    if animation == "slide-left" and axis == "x":
        return f"w-(w-({base}))*({p})"
    if animation == "slide-right" and axis == "x":
        return f"-text_w+(({base})+text_w)*({p})"
    if animation == "slide-up" and axis == "y":
        return f"h-(h-({base}))*({p})"
    if animation == "pop" and axis == "y":
        return f"({base})+h*0.035*(1-({p}))"
    return base


def _append_track(
    filters: list[str],
    video_out: str,
    track: dict,
    folder: Path,
    index: int,
    timeline_duration: float,
    prefix: str,
    subtitle: bool,
) -> str:
    text = str(track.get("text", "")).strip()[:700 if subtitle else 500]
    if not text:
        return video_out
    start_at = max(0.0, float(track.get("startAt", 0)))
    end_at = min(timeline_duration, float(track.get("endAt", timeline_duration)))
    if end_at <= start_at:
        return video_out

    text_path = folder / f"pro-text-{prefix}-{index}.txt"
    text_path.write_text(text, encoding="utf-8")
    size = int(_safe_clip(track.get("size", 38 if subtitle else 58), 18, 140, 38 if subtitle else 58))
    font_color = _ff_color(track.get("color"), "#ffffff")
    box_color = _ff_color(track.get("boxColor"), "#000000")
    box_opacity = _safe_clip(track.get("boxOpacity", .48 if subtitle else .30), 0, 1, .48 if subtitle else .30)
    border_color = _ff_color(track.get("borderColor"), "#000000")
    border_width = int(_safe_clip(track.get("borderWidth", 0 if subtitle else 1), 0, 10, 0))
    shadow_color = _ff_color(track.get("shadowColor"), "#000000")
    shadow_distance = int(_safe_clip(track.get("shadowDistance", 2 if subtitle else 3), 0, 14, 2))
    line_spacing = int(_safe_clip(track.get("lineSpacing", 4), -10, 40, 4))
    animation = str(track.get("animation", "fade" if subtitle else "none"))
    if animation not in TEXT_ANIMATIONS:
        animation = "none"

    x = _motion_expression(_base_x(track), "x", animation, start_at, end_at)
    y = _motion_expression(_base_y(track), "y", animation, start_at, end_at)
    alpha = _alpha_expression(animation, start_at, end_at)
    label = f"protext{prefix}{index}"
    box = 1 if box_opacity > .001 else 0
    box_border = int(_safe_clip(track.get("boxPadding", 12 if subtitle else 14), 0, 40, 12))

    filters.append(
        f"[{video_out}]drawtext=fontfile='{_font(track)}':textfile='{text_path}':reload=0:"
        f"fontcolor={font_color}:fontsize={size}:line_spacing={line_spacing}:"
        f"x='{x}':y='{y}':alpha='{alpha}':"
        f"borderw={border_width}:bordercolor={border_color}:"
        f"shadowx={shadow_distance}:shadowy={shadow_distance}:shadowcolor={shadow_color}:"
        f"box={box}:boxcolor={box_color}@{box_opacity:.4f}:boxborderw={box_border}:"
        f"enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]"
    )
    return label


def _append_professional_text(
    filters: list[str],
    video_out: str,
    project: dict,
    folder: Path,
    timeline_duration: float,
) -> str:
    for index, track in enumerate(project.get("textTracks", [])):
        video_out = _append_track(filters, video_out, track, folder, index, timeline_duration, "t", False)
    for index, track in enumerate(project.get("subtitleTracks", [])):
        video_out = _append_track(filters, video_out, track, folder, index, timeline_duration, "s", True)
    return video_out


def install_text_designer_engine() -> None:
    """Install professional text after LUT and master color grading.

    V9 adds PIP overlays after the shared builder and calls `_apply_master_lut`
    immediately before encode. We therefore strip legacy text in the builder,
    retain its metadata in thread-local render context, then append drawtext from
    the LUT hook. If Color Grading Pro is installed first, that hook already
    performs LUT -> grade, producing the final order: PIP -> LUT -> grade -> text.
    """
    from . import video_tools_v9

    base_builder: Callable = video_tools_v9._build_v4_filters
    base_lut: Callable = video_tools_v9._apply_master_lut

    def build_with_text_context(
        project: dict,
        videos: list[Path],
        audios: list[Path],
        images: list[Path],
        video_probes: list[dict],
        width: int,
        height: int,
        folder: Path,
    ):
        stripped = copy.deepcopy(project)
        stripped["textTracks"] = []
        stripped["subtitleTracks"] = []
        filters, video_out, audio_out, timeline_duration = base_builder(
            stripped, videos, audios, images, video_probes, width, height, folder
        )
        _CONTEXT.project = project
        _CONTEXT.folder = folder
        _CONTEXT.timeline_duration = timeline_duration
        return filters, video_out, audio_out, timeline_duration

    def apply_lut_grade_then_text(filters: list[str], video_out: str, lut: Path | None) -> str:
        output = base_lut(filters, video_out, lut)
        try:
            project = getattr(_CONTEXT, "project", None)
            folder = getattr(_CONTEXT, "folder", None)
            timeline_duration = getattr(_CONTEXT, "timeline_duration", None)
            if project is None or folder is None or timeline_duration is None:
                return output
            return _append_professional_text(filters, output, project, folder, float(timeline_duration))
        finally:
            for key in ("project", "folder", "timeline_duration"):
                if hasattr(_CONTEXT, key):
                    delattr(_CONTEXT, key)

    video_tools_v9._build_v4_filters = build_with_text_context
    video_tools_v9._apply_master_lut = apply_lut_grade_then_text
