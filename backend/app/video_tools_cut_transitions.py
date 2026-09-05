from __future__ import annotations

from pathlib import Path

from .video_tools import FONT_FILE, _atempo_chain, _has_audio, _text_y, _video_look
from .video_tools_v2 import _fit_filters, _rotation_filters
from .video_tools_v3 import _hex, _safe_clip
from .video_tools_v4 import (
    TRANSITIONS,
    _build_v4_filters as _original_build_v4_filters,
    _grading_filters,
    _ramp_speeds,
    _segment_chain,
)


def _transition_for_cut(left: dict, right: dict, default_type: str, default_duration: float) -> tuple[str, float] | None:
    spec = left.get("transitionOut")
    if isinstance(spec, dict):
        kind = str(spec.get("type", "none"))
        if kind not in TRANSITIONS or kind == "none":
            return None

        try:
            expected_index = spec.get("rightFileIndex")
            if expected_index is not None and int(expected_index) != int(right.get("fileIndex", -1)):
                return None
        except (TypeError, ValueError):
            return None

        try:
            expected_start = spec.get("rightSourceStart")
            if expected_start is not None and abs(float(expected_start) - float(right.get("start", 0))) > .5:
                return None
        except (TypeError, ValueError):
            return None

        try:
            duration = min(1.5, max(.08, float(spec.get("duration", default_duration))))
        except (TypeError, ValueError):
            duration = default_duration
        return kind, duration

    if default_type in TRANSITIONS and default_type != "none":
        return default_type, default_duration
    return None


def build_v4_filters_with_cut_transitions(
    project: dict,
    videos: list[Path],
    audios: list[Path],
    images: list[Path],
    video_probes: list[dict],
    width: int,
    height: int,
    folder: Path,
) -> tuple[list[str], str, str, float]:
    clips: list[dict] = project["clips"]
    if not any(isinstance(clip.get("transitionOut"), dict) for clip in clips):
        return _original_build_v4_filters(project, videos, audios, images, video_probes, width, height, folder)

    filters: list[str] = []
    clip_durations: list[float] = []
    default_transition = str(project.get("transition", "none"))
    default_duration = min(1.5, max(.1, float(project.get("transitionDuration", .45))))

    for index, clip in enumerate(clips):
        src = clip["fileIndex"]
        start, end = float(clip["start"]), float(clip["end"])
        base_speed = float(clip["speed"])
        volume = float(clip["volume"])
        speeds = _ramp_speeds(str(clip.get("speedRamp", "off")), base_speed)
        source_label, source_audio_label, out_duration = _segment_chain(
            filters, src, index, start, end, speeds, _has_audio(video_probes[src])
        )
        clip_durations.append(out_duration)
        frames = max(1, round(out_duration * 30))

        base_filters = [
            *_rotation_filters(clip.get("rotation", 0)),
            *_fit_filters(width, height, clip.get("fit", "contain")),
            "setsar=1",
            "fps=30",
            "settb=AVTB",
            *_video_look(str(clip.get("filter", "none"))),
            *_grading_filters(clip),
        ]
        base_label = f"vb{index}"
        filters.append(f"[{source_label}]{','.join(base_filters)}[{base_label}]")

        if clip.get("chromaEnabled"):
            key_color = _hex(clip.get("chromaColor"), "#00ff00").replace("#", "0x")
            bg_color = _hex(clip.get("chromaBackground"), "#101010").replace("#", "0x")
            similarity = _safe_clip(clip.get("chromaSimilarity", .18), .01, 1, .18)
            blend = _safe_clip(clip.get("chromaBlend", .06), 0, 1, .06)
            keyed, bg, composed = f"vk{index}", f"vbg{index}", f"vc{index}"
            filters.append(f"[{base_label}]format=rgba,chromakey={key_color}:{similarity:.5f}:{blend:.5f}[{keyed}]")
            filters.append(f"color=c={bg_color}:s={width}x{height}:r=30:d={out_duration:.6f}[{bg}]")
            filters.append(f"[{bg}][{keyed}]overlay=0:0:shortest=1[{composed}]")
            base_label = composed

        zoom_start = _safe_clip(clip.get("zoomStart", 1), 1, 4, 1)
        zoom_end = _safe_clip(clip.get("zoomEnd", zoom_start), 1, 4, zoom_start)
        pan_x_start = _safe_clip(clip.get("panXStart", 0), -1, 1, 0)
        pan_x_end = _safe_clip(clip.get("panXEnd", pan_x_start), -1, 1, pan_x_start)
        pan_y_start = _safe_clip(clip.get("panYStart", 0), -1, 1, 0)
        pan_y_end = _safe_clip(clip.get("panYEnd", pan_y_start), -1, 1, pan_y_start)
        denom = max(1, frames - 1)
        zoom_expr = f"{zoom_start:.6f}+({zoom_end - zoom_start:.6f})*min(on/{denom},1)"
        px_expr = f"{pan_x_start:.6f}+({pan_x_end - pan_x_start:.6f})*min(on/{denom},1)"
        py_expr = f"{pan_y_start:.6f}+({pan_y_end - pan_y_start:.6f})*min(on/{denom},1)"
        final_v = f"v{index}"
        filters.append(
            f"[{base_label}]zoompan=z='{zoom_expr}':"
            f"x='(iw-iw/zoom)*(0.5+0.5*({px_expr}))':"
            f"y='(ih-ih/zoom)*(0.5+0.5*({py_expr}))':"
            f"d=1:s={width}x{height}:fps=30[{final_v}]"
        )

        if source_audio_label:
            filters.append(f"[{source_audio_label}]volume={volume:.4f}[a{index}]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={out_duration:.6f},asetpts=PTS-STARTPTS[a{index}]")

    if len(clips) == 1:
        video_out, audio_out = "v0", "a0"
        timeline_duration = clip_durations[0]
    else:
        current_v, current_a = "v0", "a0"
        timeline_duration = clip_durations[0]
        for i in range(1, len(clips)):
            transition = _transition_for_cut(clips[i - 1], clips[i], default_transition, default_duration)
            if transition is None:
                nv, na = f"vcut{i}", f"acut{i}"
                filters.append(f"[{current_v}][{current_a}][v{i}][a{i}]concat=n=2:v=1:a=1[{nv}][{na}]")
                timeline_duration += clip_durations[i]
                current_v, current_a = nv, na
                continue

            transition_type, requested_duration = transition
            fade = min(requested_duration, max(.05, clip_durations[i] / 3), max(.05, timeline_duration / 3))
            offset = max(0.0, timeline_duration - fade)
            nv, na = f"vtx{i}", f"atx{i}"
            filters.append(
                f"[{current_v}][v{i}]xfade=transition={transition_type}:duration={fade:.6f}:offset={offset:.6f}[{nv}]"
            )
            filters.append(f"[{current_a}][a{i}]acrossfade=d={fade:.6f}:c1=tri:c2=tri[{na}]")
            timeline_duration += clip_durations[i] - fade
            current_v, current_a = nv, na
        video_out, audio_out = current_v, current_a

    for i, track in enumerate(project.get("textTracks", [])):
        text = str(track.get("text", "")).strip()[:500]
        if not text:
            continue
        start_at = max(0.0, float(track.get("startAt", 0)))
        end_at = min(timeline_duration, float(track.get("endAt", timeline_duration)))
        if end_at <= start_at:
            continue
        text_path = folder / f"v4-title-{i}.txt"
        text_path.write_text(text, encoding="utf-8")
        size = max(20, min(120, int(track.get("size", 52))))
        position = _text_y(str(track.get("position", "bottom")))
        label = f"vtitle{i}"
        filters.append(
            f"[{video_out}]drawtext=fontfile='{FONT_FILE}':textfile='{text_path}':reload=0:fontcolor=white:"
            f"fontsize={size}:x=(w-text_w)/2:y={position}:box=1:boxcolor=black@0.42:boxborderw=12:"
            f"enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]"
        )
        video_out = label

    for i, track in enumerate(project.get("subtitleTracks", [])):
        text = str(track.get("text", "")).strip()[:700]
        if not text:
            continue
        start_at = max(0.0, float(track.get("startAt", 0)))
        end_at = min(timeline_duration, float(track.get("endAt", timeline_duration)))
        if end_at <= start_at:
            continue
        text_path = folder / f"v4-sub-{i}.txt"
        text_path.write_text(text, encoding="utf-8")
        size = max(18, min(84, int(track.get("size", 38))))
        position = _text_y(str(track.get("position", "bottom")))
        color = _hex(track.get("color"), "#ffffff").replace("#", "0x")
        opacity = _safe_clip(track.get("boxOpacity", .48), 0, 1, .48)
        label = f"vsub{i}"
        filters.append(
            f"[{video_out}]drawtext=fontfile='{FONT_FILE}':textfile='{text_path}':reload=0:fontcolor={color}:"
            f"fontsize={size}:x=(w-text_w)/2:y={position}:box=1:boxcolor=black@{opacity:.4f}:boxborderw=10:"
            f"enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]"
        )
        video_out = label

    audio_base = len(videos)
    image_base = audio_base + len(audios)

    for i, track in enumerate(project.get("imageTracks", [])):
        input_index = image_base + int(track["fileIndex"])
        start_at = max(0.0, float(track.get("startAt", 0)))
        end_at = min(timeline_duration, float(track.get("endAt", timeline_duration)))
        if end_at <= start_at:
            continue
        duration = max(.001, end_at - start_at)
        opacity = _safe_clip(track.get("opacity", 1), 0, 1, 1)
        scale_start = _safe_clip(track.get("scaleStart", track.get("scale", .22)), .05, 1, .22)
        scale_end = _safe_clip(track.get("scaleEnd", scale_start), .05, 1, scale_start)
        sx = _safe_clip(track.get("startX", .76), 0, 1, .76)
        sy = _safe_clip(track.get("startY", .76), 0, 1, .76)
        ex = _safe_clip(track.get("endX", sx), 0, 1, sx)
        ey = _safe_clip(track.get("endY", sy), 0, 1, sy)
        img_label, label = f"img{i}", f"vimg{i}"
        scale_expr = f"max(24,{width}*({scale_start:.6f}+({scale_end - scale_start:.6f})*clip((t-{start_at:.6f})/{duration:.6f},0,1)))"
        x_expr = f"(W-w)*({sx:.6f}+({ex - sx:.6f})*clip((t-{start_at:.6f})/{duration:.6f},0,1))"
        y_expr = f"(H-h)*({sy:.6f}+({ey - sy:.6f})*clip((t-{start_at:.6f})/{duration:.6f},0,1))"
        filters.append(
            f"[{input_index}:v]format=rgba,scale=w='{scale_expr}':h=-1:eval=frame,colorchannelmixer=aa={opacity:.4f}[{img_label}]"
        )
        filters.append(
            f"[{video_out}][{img_label}]overlay=x='{x_expr}':y='{y_expr}':enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]"
        )
        video_out = label

    mix_labels = [f"[{audio_out}]"]
    for i, track in enumerate(project.get("audioTracks", [])):
        input_index = audio_base + int(track["fileIndex"])
        source_start, source_end = float(track["sourceStart"]), float(track["sourceEnd"])
        duration = max(.001, source_end - source_start)
        delay_ms = max(0, round(float(track.get("startAt", 0)) * 1000))
        af = [
            f"atrim=start={source_start:.6f}:end={source_end:.6f}",
            "asetpts=PTS-STARTPTS",
            "aresample=48000",
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
            f"volume={_safe_clip(track.get('volume', .65), 0, 2, .65):.4f}",
        ]
        fade_in = _safe_clip(track.get("fadeIn", 0), 0, 10, 0)
        fade_out = _safe_clip(track.get("fadeOut", 0), 0, 10, 0)
        if fade_in > 0:
            af.append(f"afade=t=in:st=0:d={min(fade_in, duration):.4f}")
        if fade_out > 0:
            fade_d = min(fade_out, duration)
            af.append(f"afade=t=out:st={max(0, duration - fade_d):.4f}:d={fade_d:.4f}")
        af.append(f"adelay={delay_ms}|{delay_ms}")
        label = f"music{i}"
        filters.append(f"[{input_index}:a]{','.join(af)}[{label}]")
        mix_labels.append(f"[{label}]")

    if len(mix_labels) > 1:
        filters.append(
            f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:duration=longest:dropout_transition=2,alimiter=limit=.98[amixout]"
        )
        audio_out = "amixout"

    return filters, video_out, audio_out, timeline_duration


def install_cut_transition_engine() -> None:
    # V9 is the shared renderer used by V10/V11 and the V12 persistent queue.
    # Replacing its imported filter builder here upgrades those paths while
    # leaving the historical V4 endpoint unchanged and preserving fallback
    # behaviour for projects without per-cut transition metadata.
    from . import video_tools_v9

    video_tools_v9._build_v4_filters = build_v4_filters_with_cut_transitions
