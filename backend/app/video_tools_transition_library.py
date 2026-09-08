from __future__ import annotations

from typing import Any

EXPANDED_TRANSITIONS = {
    "wipeup", "wipedown",
    "slideup", "slidedown",
    "circlecrop", "rectcrop", "distance", "radial",
    "smoothup", "smoothdown",
    "vertopen", "vertclose", "horzopen", "horzclose",
    "diagtl", "diagtr", "diagbl", "diagbr",
    "hlslice", "hrslice", "vuslice", "vdslice",
    "hblur", "fadegrays", "wipetl", "wipetr", "wipebl", "wipebr",
    "squeezeh", "squeezev", "zoomin", "fadefast", "fadeslow",
    "hlwind", "hrwind", "vuwind", "vdwind",
    "coverleft", "coverright", "coverup", "coverdown",
    "revealleft", "revealright", "revealup", "revealdown",
}

_SMOOTH_DIRECTIONAL = {
    "slideleft": "smoothleft",
    "slideright": "smoothright",
    "slideup": "smoothup",
    "slidedown": "smoothdown",
}


def _install_easing_aware_cut_resolver() -> None:
    from . import video_tools_cut_transitions as cut

    original = cut._transition_for_cut

    def resolve(left: dict[str, Any], right: dict[str, Any], default_type: str, default_duration: float):
        result = original(left, right, default_type, default_duration)
        if result is None:
            return None
        kind, duration = result
        spec = left.get("transitionOut")
        easing = str(spec.get("easing", "linear")) if isinstance(spec, dict) else "linear"
        if easing in {"smooth", "cinematic"}:
            kind = _SMOOTH_DIRECTIONAL.get(kind, kind)
        if easing == "cinematic" and kind == "fade":
            kind = "fadeslow"
        return kind, duration

    cut._transition_for_cut = resolve


def install_transition_library() -> None:
    """Extend the shared V4/V9 transition registry with current FFmpeg xfade
    presets while preserving the historical transition path.

    The set is mutated in place because video_tools_cut_transitions imports the
    same registry object. This upgrades per-cut V12 rendering without changing
    legacy projects or the public endpoint contract.
    """
    from . import video_tools_v4
    from . import video_tools_cut_transitions

    video_tools_v4.TRANSITIONS.update(EXPANDED_TRANSITIONS)
    video_tools_cut_transitions.TRANSITIONS.update(EXPANDED_TRANSITIONS)
    _install_easing_aware_cut_resolver()
