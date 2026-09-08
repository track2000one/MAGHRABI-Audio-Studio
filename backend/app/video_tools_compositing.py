from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from .video_tools_v3 import _safe_clip

_CONTEXT = threading.local()
MAX_LAYERS = 12
MAX_KEYFRAMES = 16
BLEND_MODES = {"normal", "screen", "multiply", "overlay", "add", "difference", "lighten", "darken"}
EASINGS = {"linear", "ease-in", "ease-out", "ease-in-out", "hold"}


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


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


def _normalize_keyframes(raw: object, fallback: float) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_KEYFRAMES:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_KEYFRAMES} Opacity Keyframes لكل Compositing Layer.")
    points: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="إحدى نقاط Compositing Opacity غير صالحة.")
        easing = str(item.get("easing", "ease-in-out"))
        points.append({
            "time": _safe_clip(item.get("time", 0), 0, 1, 0),
            "opacity": _safe_clip(item.get("opacity", fallback), 0, 1, fallback),
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
    return deduped[:MAX_KEYFRAMES]


def _normalize_layers(project: dict) -> list[dict]:
    raw = project.get("adjustmentLayers", []) or []
    if not isinstance(raw, list) or len(raw) > MAX_LAYERS:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_LAYERS} Compositing Layers لكل مشروع.")
    layers: list[dict] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="إحدى طبقات Compositing غير صالحة.")
        start = _safe_clip(item.get("startAt", 0), 0, 86400, 0)
        end = max(start + .1, _safe_clip(item.get("endAt", start + 6), 0, 86400, start + 6))
        opacity = _safe_clip(item.get("opacity", 1), 0, 1, 1)
        blend = str(item.get("blendMode", "normal"))
        layer = {
            "id": str(item.get("id") or f"layer-{index}"),
            "name": str(item.get("name") or f"Adjustment Pro {index + 1}")[:80],
            "enabled": bool(item.get("enabled", True)),
            "startAt": start,
            "endAt": end,
            "blendMode": blend if blend in BLEND_MODES else "normal",
            "opacity": opacity,
            "opacityKeyframes": _normalize_keyframes(item.get("opacityKeyframes", []), opacity),
            "brightness": _safe_clip(item.get("brightness", 0), -.5, .5, 0),
            "contrast": _safe_clip(item.get("contrast", 1), .5, 2, 1),
            "saturation": _safe_clip(item.get("saturation", 1), 0, 2.5, 1),
            "hue": _safe_clip(item.get("hue", 0), -180, 180, 0),
            "blur": _safe_clip(item.get("blur", 0), 0, 1, 0),
            "sharpen": _safe_clip(item.get("sharpen", 0), 0, 1, 0),
            "vignette": _safe_clip(item.get("vignette", 0), 0, 1, 0),
            "grain": _safe_clip(item.get("grain", 0), 0, 1, 0),
            "glow": _safe_clip(item.get("glow", 0), 0, 1, 0),
            "lightLeak": _safe_clip(item.get("lightLeak", 0), 0, 1, 0),
            "zoom": _safe_clip(item.get("zoom", 1), 1, 2.5, 1),
            "panX": _safe_clip(item.get("panX", 0), -1, 1, 0),
            "panY": _safe_clip(item.get("panY", 0), -1, 1, 0),
        }
        layers.append(layer)
    project["adjustmentLayers"] = layers
    return layers


def _segment_expr(a: dict, b: dict, start_at: float, duration: float) -> str:
    ta = start_at + float(a["time"]) * duration
    tb = start_at + float(b["time"]) * duration
    va = float(a["opacity"])
    vb = float(b["opacity"])
    if tb <= ta + .0001 or abs(vb - va) < .000001:
        return f"{va:.7f}"
    p = f"min(max((T-{ta:.7f})/{max(.0001, tb-ta):.7f},0),1)"
    eased = _ease_expr(str(a.get("easing", "linear")), p)
    return f"{va:.7f}+({vb-va:.7f})*({eased})"


def _opacity_expr(layer: dict) -> str:
    start_at = float(layer["startAt"])
    end_at = float(layer["endAt"])
    duration = max(.1, end_at - start_at)
    points = layer.get("opacityKeyframes", []) or []
    if not points:
        inside = f"{float(layer['opacity']):.7f}"
    elif len(points) == 1:
        inside = f"{float(points[0]['opacity']):.7f}"
    else:
        inside = f"{float(points[-1]['opacity']):.7f}"
        for index in range(len(points) - 2, -1, -1):
            a, b = points[index], points[index + 1]
            boundary = start_at + float(b["time"]) * duration
            inside = f"if(lt(T,{boundary:.7f}),{_segment_expr(a,b,start_at,duration)},{inside})"
    return f"if(between(T,{start_at:.7f},{end_at:.7f}),{inside},0)"


def _mode_expr(mode: str) -> str:
    if mode == "screen":
        return "255-(255-A)*(255-B)/255"
    if mode == "multiply":
        return "A*B/255"
    if mode == "overlay":
        return "if(lt(A,128),2*A*B/255,255-2*(255-A)*(255-B)/255)"
    if mode == "add":
        return "min(255,A+B)"
    if mode == "difference":
        return "abs(A-B)"
    if mode == "lighten":
        return "max(A,B)"
    if mode == "darken":
        return "min(A,B)"
    return "B"


def _layer_filters(layer: dict, width: int, height: int) -> list[str]:
    chain: list[str] = []
    zoom = float(layer["zoom"])
    pan_x = float(layer["panX"])
    pan_y = float(layer["panY"])
    if zoom > 1.001:
        crop_w = max(2, round(width / zoom))
        crop_h = max(2, round(height / zoom))
        x = round((width - crop_w) * (pan_x + 1) / 2)
        y = round((height - crop_h) * (pan_y + 1) / 2)
        chain.append(f"crop={crop_w}:{crop_h}:{x}:{y}")
        chain.append(f"scale={width}:{height}:flags=lanczos")

    brightness = float(layer["brightness"])
    contrast = float(layer["contrast"])
    saturation = float(layer["saturation"])
    if abs(brightness) > .001 or abs(contrast - 1) > .001 or abs(saturation - 1) > .001:
        chain.append(f"eq=brightness={brightness:.5f}:contrast={contrast:.5f}:saturation={saturation:.5f}")

    hue = float(layer["hue"])
    if abs(hue) > .001:
        chain.append(f"hue=h={hue:.4f}")

    blur = float(layer["blur"])
    if blur > .001:
        radius = max(1, min(28, round(1 + blur * 27)))
        chain.append(f"boxblur=luma_radius={radius}:luma_power=1")

    glow = float(layer["glow"])
    if glow > .001:
        radius = max(2, min(24, round(2 + glow * 18)))
        lift = _clamp(glow * .10, 0, .10)
        chain.append(f"boxblur=luma_radius={radius}:luma_power=1")
        chain.append(f"eq=brightness={lift:.5f}:contrast={1+glow*.08:.5f}")

    sharpen = float(layer["sharpen"])
    if sharpen > .001:
        chain.append(f"unsharp=5:5:{_clamp(sharpen*1.25,0,1.25):.4f}:5:5:0")

    vignette = float(layer["vignette"])
    if vignette > .001:
        angle = 3.14159265 / max(2.0, 8.0 - 5.2 * vignette)
        chain.append(f"vignette=angle={angle:.7f}")

    grain = float(layer["grain"])
    if grain > .001:
        strength = _clamp(grain * 26, 0, 26)
        chain.append(f"noise=alls={strength:.3f}:allf=t")

    leak = float(layer["lightLeak"])
    if leak > .001:
        chain.append(
            "colorbalance="
            f"rs={_clamp(leak*.18,0,.18):.5f}:"
            f"gs={_clamp(leak*.045,0,.06):.5f}:"
            f"bs={-_clamp(leak*.12,0,.12):.5f}"
        )
        chain.append(f"eq=brightness={_clamp(leak*.055,0,.055):.5f}:saturation={1+leak*.16:.5f}")

    return chain


def _append_compositing(filters: list[str], video_out: str, layers: list[dict], width: int, height: int) -> str:
    current = video_out
    for index, layer in enumerate(layers):
        if not layer.get("enabled"):
            continue
        if float(layer.get("opacity", 0)) <= .0001 and not layer.get("opacityKeyframes"):
            continue
        base = f"compbase{index}"
        fxsrc = f"compfxsrc{index}"
        fx = f"compfx{index}"
        output = f"compout{index}"
        filters.append(f"[{current}]split=2[{base}][{fxsrc}]")
        chain = _layer_filters(layer, width, height)
        if chain:
            filters.append(f"[{fxsrc}]{','.join(chain)}[{fx}]")
        else:
            filters.append(f"[{fxsrc}]null[{fx}]")
        opacity = _opacity_expr(layer)
        mode = _mode_expr(str(layer.get("blendMode", "normal")))
        expression = f"A*(1-({opacity}))+({mode})*({opacity})"
        filters.append(f"[{base}][{fx}]blend=all_expr='{expression}'[{output}]")
        current = output
    return current


def install_compositing_engine() -> None:
    """Install sequence-level compositing before LUT/grade/text.

    The V9 renderer composes timeline + PIP before calling `_apply_master_lut`.
    This hook captures adjustmentLayers while the shared builder runs, applies
    them to the fully composed Program image, then delegates to the original LUT
    hook. Color Grading and Text Designer are installed afterwards and therefore
    retain the intended finishing order.
    """
    from . import video_tools_v9

    base_builder: Callable = video_tools_v9._build_v4_filters
    base_lut: Callable = video_tools_v9._apply_master_lut

    def build_with_compositing_context(
        project: dict,
        videos: list[Path],
        audios: list[Path],
        images: list[Path],
        video_probes: list[dict],
        width: int,
        height: int,
        folder: Path,
    ):
        _CONTEXT.layers = _normalize_layers(project)
        _CONTEXT.width = width
        _CONTEXT.height = height
        return base_builder(project, videos, audios, images, video_probes, width, height, folder)

    def apply_compositing_then_lut(filters: list[str], video_out: str, lut: Path | None) -> str:
        try:
            layers = getattr(_CONTEXT, "layers", [])
            width = int(getattr(_CONTEXT, "width", 1280))
            height = int(getattr(_CONTEXT, "height", 720))
            composited = _append_compositing(filters, video_out, layers, width, height)
            return base_lut(filters, composited, lut)
        finally:
            for key in ("layers", "width", "height"):
                if hasattr(_CONTEXT, key):
                    delattr(_CONTEXT, key)

    video_tools_v9._build_v4_filters = build_with_compositing_context
    video_tools_v9._apply_master_lut = apply_compositing_then_lut
