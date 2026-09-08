from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from .video_tools import _has_audio, _probe, _run_ffmpeg
from .video_tools_v3 import _safe_clip
from .video_tools_v5 import _render_advanced_clip as _legacy_render_advanced_clip
from .video_tools_v5 import _validate_v5 as _legacy_validate_v5
from .video_tools_v7 import _video_dimensions

MAX_TRACK_POINTS = 24
MASK_EFFECTS = {"none", "blur", "mosaic", "spotlight", "background-blur"}
MASK_SHAPES = {"rect", "ellipse"}
EASINGS = {"linear", "ease-in", "ease-out", "ease-in-out", "hold"}
_INSTALLED = False


def _ease_expr(kind: str, p: str) -> str:
    if kind == "ease-in":
        return f"(({p})*({p}))"
    if kind == "ease-out":
        return f"(1-(1-({p}))*(1-({p})))"
    if kind == "ease-in-out":
        return f"if(lt(({p}),0.5),2*({p})*({p}),1-((-2*({p})+2)*(-2*({p})+2))/2)"
    if kind == "hold":
        return "0"
    return p


def _segment_expr(a: dict, b: dict, key: str, duration: float, time_var: str = "T") -> str:
    ta = float(a["time"]) * duration
    tb = float(b["time"]) * duration
    va = float(a[key])
    vb = float(b[key])
    if tb <= ta + .0001 or abs(vb - va) < .000001:
        return f"{va:.8f}"
    p = f"min(max(({time_var}-{ta:.8f})/{max(.0001, tb-ta):.8f},0),1)"
    eased = _ease_expr(str(a.get("easing", "linear")), p)
    return f"{va:.8f}+({vb-va:.8f})*({eased})"


def _piecewise_expr(points: list[dict], key: str, duration: float, fallback: float, time_var: str = "T") -> str:
    if not points:
        return f"{fallback:.8f}"
    if len(points) == 1:
        return f"{float(points[0][key]):.8f}"
    result = f"{float(points[-1][key]):.8f}"
    for index in range(len(points) - 2, -1, -1):
        a, b = points[index], points[index + 1]
        tb = float(b["time"]) * duration
        segment = _segment_expr(a, b, key, duration, time_var)
        result = f"if(lt({time_var},{tb:.8f}),{segment},{result})"
    return result


def _normalize_tracking_points(clip: dict) -> list[dict]:
    raw = clip.get("privacyTrackingPoints", []) or []
    if not isinstance(raw, list) or len(raw) > MAX_TRACK_POINTS:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_TRACK_POINTS} Tracking Points لكل Clip.")

    base_w = _safe_clip(clip.get("privacyWidth", .30), .03, 1, .30)
    base_h = _safe_clip(clip.get("privacyHeight", .22), .03, 1, .22)
    base_x = _safe_clip(clip.get("privacyX", .35), 0, max(0.0, 1 - base_w), .35)
    base_y = _safe_clip(clip.get("privacyY", .30), 0, max(0.0, 1 - base_h), .30)

    points: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="إحدى نقاط Tracking غير صالحة.")
        width = _safe_clip(item.get("width", base_w), .03, 1, base_w)
        height = _safe_clip(item.get("height", base_h), .03, 1, base_h)
        x = _safe_clip(item.get("x", base_x), 0, max(0.0, 1 - width), base_x)
        y = _safe_clip(item.get("y", base_y), 0, max(0.0, 1 - height), base_y)
        easing = str(item.get("easing", "ease-in-out"))
        points.append({
            "time": _safe_clip(item.get("time", 0), 0, 1, 0),
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "easing": easing if easing in EASINGS else "ease-in-out",
        })

    points.sort(key=lambda item: item["time"])
    deduped: list[dict] = []
    for point in points:
        if deduped and abs(float(point["time"]) - float(deduped[-1]["time"])) < .0005:
            deduped[-1] = point
        else:
            deduped.append(point)

    if deduped and float(deduped[0]["time"]) > .0005:
        first = dict(deduped[0])
        first["time"] = 0.0
        deduped.insert(0, first)
    if deduped and float(deduped[-1]["time"]) < .9995:
        last = dict(deduped[-1])
        last["time"] = 1.0
        deduped.append(last)
    if len(deduped) > MAX_TRACK_POINTS:
        raise HTTPException(status_code=400, detail=f"تجاوز Clip حد {MAX_TRACK_POINTS} Tracking Points.")

    clip["privacyTrackingPoints"] = deduped
    return deduped


def validate_mask_tracking(project: dict, video_count: int) -> dict:
    project = _legacy_validate_v5(project, video_count)
    for clip in project.get("clips", []):
        mode = str(clip.get("privacyEffect", "none"))
        clip["privacyEffect"] = mode if mode in MASK_EFFECTS else "none"
        shape = str(clip.get("privacyMaskShape", "rect"))
        clip["privacyMaskShape"] = shape if shape in MASK_SHAPES else "rect"
        clip["privacyFeather"] = _safe_clip(clip.get("privacyFeather", .015), 0, .12, .015)
        clip["privacyTrackingEnabled"] = bool(clip.get("privacyTrackingEnabled", False))
        clip["privacyTrackingPoints"] = _normalize_tracking_points(clip)
    return project


def _mask_expr(shape: str, x: str, y: str, width: str, height: str) -> str:
    nx = "X/W"
    ny = "Y/H"
    if shape == "ellipse":
        cx = f"(({x})+({width})/2)"
        cy = f"(({y})+({height})/2)"
        rx = f"max(({width})/2,0.0001)"
        ry = f"max(({height})/2,0.0001)"
        return (
            f"if(lte(pow((({nx})-({cx}))/({rx}),2)+"
            f"pow((({ny})-({cy}))/({ry}),2),1),255,0)"
        )
    return (
        f"if(between({nx},({x}),({x})+({width}))*"
        f"between({ny},({y}),({y})+({height})),255,0)"
    )


def _tracking_geometry(clip: dict, duration: float) -> tuple[str, str, str, str]:
    points = clip.get("privacyTrackingPoints", []) if clip.get("privacyTrackingEnabled") else []
    return (
        _piecewise_expr(points, "x", duration, float(clip.get("privacyX", .35))),
        _piecewise_expr(points, "y", duration, float(clip.get("privacyY", .30))),
        _piecewise_expr(points, "width", duration, float(clip.get("privacyWidth", .30))),
        _piecewise_expr(points, "height", duration, float(clip.get("privacyHeight", .22))),
    )


def _needs_mask_engine(clip: dict) -> bool:
    effect = str(clip.get("privacyEffect", "none"))
    if effect in {"spotlight", "background-blur"}:
        return True
    if effect not in {"blur", "mosaic"}:
        return False
    return (
        str(clip.get("privacyMaskShape", "rect")) != "rect"
        or bool(clip.get("privacyTrackingEnabled"))
        or float(clip.get("privacyFeather", 0) or 0) > .0005
    )


def _render_masked_clip(source: Path, clip: dict, folder: Path, index: int, has_audio: bool) -> Path:
    start = float(clip["start"])
    end = float(clip["end"])
    duration = max(.05, end - start)
    effect = str(clip.get("privacyEffect", "none"))
    intensity = _safe_clip(clip.get("privacyIntensity", .55), .05, 1, .55)
    shape = str(clip.get("privacyMaskShape", "rect"))
    feather = _safe_clip(clip.get("privacyFeather", .015), 0, .12, .015)
    reverse = bool(clip.get("reverse", False))

    probe = _probe(source)
    width, height = _video_dimensions(probe)
    x_expr, y_expr, w_expr, h_expr = _tracking_geometry(clip, duration)
    mask = _mask_expr(shape, x_expr, y_expr, w_expr, h_expr)
    feather_px = max(0, min(48, round(feather * min(width, height))))

    filters: list[str] = [
        f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS,fps=30,setsar=1[trimmed]"
    ]

    if effect == "spotlight":
        darkness = min(.78, .22 + intensity * .48)
        filters.append("[trimmed]split=2[sharp][base0]")
        filters.append(f"[base0]eq=brightness={-darkness:.6f}:saturation={max(.45,1-intensity*.35):.6f}[base]")
        fx_label = "sharp"
    elif effect == "background-blur":
        radius = max(3, round(4 + intensity * 28))
        filters.append("[trimmed]split=2[sharp][base0]")
        filters.append(f"[base0]boxblur=luma_radius={radius}:luma_power=2[base]")
        fx_label = "sharp"
    elif effect == "mosaic":
        divisor = max(6, round(8 + intensity * 30))
        filters.append("[trimmed]split=2[base][fxsrc]")
        filters.append(
            f"[fxsrc]scale=max(2,iw/{divisor}):max(2,ih/{divisor}):flags=neighbor,"
            f"scale={width}:{height}:flags=neighbor[fx]"
        )
        fx_label = "fx"
    else:
        radius = max(3, round(4 + intensity * 28))
        filters.append("[trimmed]split=2[base][fxsrc]")
        filters.append(f"[fxsrc]boxblur=luma_radius={radius}:luma_power=2[fx]")
        fx_label = "fx"

    mask_chain = (
        f"nullsrc=s={width}x{height}:r=30:d={duration:.6f},format=gray,"
        f"geq=lum='{mask}'"
    )
    if feather_px > 0:
        mask_chain += f",boxblur=luma_radius={feather_px}:luma_power=1"
    filters.append(f"{mask_chain}[mask]")
    filters.append(f"[{fx_label}]format=rgba[fxrgba]")
    filters.append("[fxrgba][mask]alphamerge[maskedfx]")
    filters.append("[base][maskedfx]overlay=0:0:shortest=1[masked]")

    if reverse:
        filters.append("[masked]reverse[vout]")
        video_map = "[vout]"
    else:
        video_map = "[masked]"

    if has_audio:
        af = [f"atrim=start={start:.6f}:end={end:.6f}", "asetpts=PTS-STARTPTS"]
        if reverse:
            af.append("areverse")
        filters.append(f"[0:a]{','.join(af)}[aout]")

    output = folder / f"mask-tracking-pro-{index}.mp4"
    command = ["ffmpeg", "-hide_banner", "-y", "-i", str(source), "-filter_complex", ";".join(filters), "-map", video_map]
    if has_audio:
        command.extend(["-map", "[aout]"])
    else:
        command.append("-an")
    command.extend([
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-t", f"{duration:.6f}",
        "-movflags", "+faststart", str(output),
    ])
    _run_ffmpeg(command)
    return output


def render_mask_tracking(source: Path, clip: dict, folder: Path, index: int, has_audio: bool) -> Path:
    if clip.get("freezeFrame") or not _needs_mask_engine(clip):
        return _legacy_render_advanced_clip(source, clip, folder, index, has_audio)
    return _render_masked_clip(source, clip, folder, index, has_audio)


def install_mask_tracking_engine() -> None:
    global _INSTALLED
    if _INSTALLED:
        return

    from . import video_tools_v5, video_tools_v6, video_tools_v8, video_tools_v9

    video_tools_v5.PRIVACY_EFFECTS.update(MASK_EFFECTS)
    modules = (video_tools_v5, video_tools_v6, video_tools_v8, video_tools_v9)
    for module in modules:
        if hasattr(module, "_validate_v5"):
            module._validate_v5 = validate_mask_tracking
        if hasattr(module, "_render_advanced_clip"):
            module._render_advanced_clip = render_mask_tracking

    _INSTALLED = True
