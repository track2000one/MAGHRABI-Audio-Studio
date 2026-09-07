from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from .video_tools import _duration, _probe, _run_ffmpeg
from .video_tools_v3 import _safe_clip
from .video_tools_v7 import _video_dimensions

MAX_KEYFRAMES_PER_CLIP = 20
EASINGS = {"linear", "ease-in", "ease-out", "ease-in-out", "hold"}


def _normalize_motion_keyframes(clip: dict) -> list[dict]:
    raw = clip.get("transformKeyframes", []) or []
    if not isinstance(raw, list) or len(raw) > MAX_KEYFRAMES_PER_CLIP:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_KEYFRAMES_PER_CLIP} Keyframes لكل Clip.")

    points: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="إحدى نقاط Keyframe غير صالحة.")
        easing = str(item.get("easing", "linear"))
        points.append({
            "time": _safe_clip(item.get("time", 0), 0, 1, 0),
            "zoom": _safe_clip(item.get("zoom", 1), 1, 4, 1),
            "panX": _safe_clip(item.get("panX", 0), -1, 1, 0),
            "panY": _safe_clip(item.get("panY", 0), -1, 1, 0),
            "rotation": _safe_clip(item.get("rotation", 0), -360, 360, 0),
            "opacity": _safe_clip(item.get("opacity", 1), 0, 1, 1),
            "easing": easing if easing in EASINGS else "linear",
        })

    points.sort(key=lambda item: item["time"])
    deduped: list[dict] = []
    for point in points:
        if deduped and abs(point["time"] - deduped[-1]["time"]) < .0005:
            deduped[-1] = point
        else:
            deduped.append(point)

    if deduped and deduped[0]["time"] > .0005:
        deduped.insert(0, {
            "time": 0.0,
            "zoom": _safe_clip(clip.get("zoomStart", 1), 1, 4, 1),
            "panX": _safe_clip(clip.get("panXStart", 0), -1, 1, 0),
            "panY": _safe_clip(clip.get("panYStart", 0), -1, 1, 0),
            "rotation": _safe_clip(clip.get("rotationAngleStart", 0), -360, 360, 0),
            "opacity": _safe_clip(clip.get("opacityStart", 1), 0, 1, 1),
            "easing": "linear",
        })
    if deduped and deduped[-1]["time"] < .9995:
        deduped.append({
            "time": 1.0,
            "zoom": _safe_clip(clip.get("zoomEnd", 1), 1, 4, 1),
            "panX": _safe_clip(clip.get("panXEnd", 0), -1, 1, 0),
            "panY": _safe_clip(clip.get("panYEnd", 0), -1, 1, 0),
            "rotation": _safe_clip(clip.get("rotationAngleEnd", 0), -360, 360, 0),
            "opacity": _safe_clip(clip.get("opacityEnd", 1), 0, 1, 1),
            "easing": "linear",
        })
    if len(deduped) > MAX_KEYFRAMES_PER_CLIP:
        raise HTTPException(status_code=400, detail=f"تجاوز Clip حد {MAX_KEYFRAMES_PER_CLIP} Keyframes.")

    clip["transformKeyframes"] = deduped
    return deduped


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


def _segment_expr(a: dict, b: dict, key: str, duration: float, time_var: str = "t") -> str:
    ta = float(a["time"]) * duration
    tb = float(b["time"]) * duration
    va = float(a[key])
    vb = float(b[key])
    if tb <= ta + .0001 or abs(vb - va) < .000001:
        return f"{va:.8f}"
    p = f"min(max(({time_var}-{ta:.8f})/{max(.0001, tb-ta):.8f},0),1)"
    eased = _ease_expr(str(a.get("easing", "linear")), p)
    return f"{va:.8f}+({vb-va:.8f})*({eased})"


def _piecewise_expr(points: list[dict], key: str, duration: float, time_var: str = "t") -> str:
    if not points:
        return "0" if key == "rotation" else "1"
    if len(points) == 1:
        return f"{float(points[0][key]):.8f}"
    result = f"{float(points[-1][key]):.8f}"
    for index in range(len(points) - 2, -1, -1):
        a, b = points[index], points[index + 1]
        tb = float(b["time"]) * duration
        segment = _segment_expr(a, b, key, duration, time_var)
        result = f"if(lt({time_var},{tb:.8f}),{segment},{result})"
    return result


def _needs_extended_motion(points: list[dict]) -> bool:
    return any(abs(float(point.get("rotation", 0))) > .0001 or abs(float(point.get("opacity", 1)) - 1) > .0001 for point in points)


def _apply_rotation_opacity(source: Path, probe: dict, clip: dict, folder: Path, index: int) -> Path:
    points = clip.get("transformKeyframes", []) or []
    if len(points) < 2 or not _needs_extended_motion(points):
        return source

    duration = max(.05, _duration(probe))
    width, height = _video_dimensions(probe)
    # rotate evaluates timestamps as lowercase `t`; blend exposes timestamp as
    # uppercase `T`. Build the same easing curve against the correct variable
    # for each filter instead of performing an unsafe string replacement.
    rotation = _piecewise_expr(points, "rotation", duration, "t")
    opacity = _piecewise_expr(points, "opacity", duration, "T")
    output = folder / f"motion-pro-{index}.mp4"

    filters = (
        f"[0:v]rotate=angle='({rotation})*PI/180':ow=iw:oh=ih:c=black,setsar=1[rot];"
        f"[rot][1:v]blend=all_expr='A*({opacity})+B*(1-({opacity}))':shortest=1[vout]"
    )
    command = [
        "ffmpeg", "-hide_banner", "-y",
        "-i", str(source),
        "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=30:d={duration:.6f}",
        "-filter_complex", filters,
        "-map", "[vout]",
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-t", f"{duration:.6f}", "-movflags", "+faststart", str(output),
    ]
    _run_ffmpeg(command)
    return output


def install_motion_keyframe_engine() -> None:
    from . import video_tools_v8, video_tools_v9

    original_render: Callable = video_tools_v8._render_eased_keyframed_clip

    def validate_v8_with_motion(project: dict) -> dict:
        project["magneticSnap"] = bool(project.get("magneticSnap", True))
        for clip in project.get("clips", []):
            _normalize_motion_keyframes(clip)
            clip["audioLead"] = _safe_clip(clip.get("audioLead", 0), 0, 4, 0)
            clip["audioTail"] = _safe_clip(clip.get("audioTail", 0), 0, 4, 0)
            if clip.get("reverse") or clip.get("freezeFrame") or str(clip.get("speedRamp", "off")) != "off":
                clip["audioLead"] = 0.0
                clip["audioTail"] = 0.0
        return project

    def render_motion_keyframed_clip(source: Path, probe: dict, clip: dict, folder: Path, index: int) -> Path:
        rendered = original_render(source, probe, clip, folder, index)
        rendered_probe = _probe(rendered)
        return _apply_rotation_opacity(rendered, rendered_probe, clip, folder, index)

    # V8 direct rendering and V9 (which powers V10/V11/V12) resolve these
    # functions from module globals at execution time, so patch both bindings.
    video_tools_v8._validate_v8 = validate_v8_with_motion
    video_tools_v8._normalize_keyframes = _normalize_motion_keyframes
    video_tools_v8._render_eased_keyframed_clip = render_motion_keyframed_clip
    video_tools_v9._validate_v8 = validate_v8_with_motion
    video_tools_v9._render_eased_keyframed_clip = render_motion_keyframed_clip