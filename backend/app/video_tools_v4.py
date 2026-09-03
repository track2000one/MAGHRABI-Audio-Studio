from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import (
    FONT_FILE,
    OUTPUT_SIZES,
    _atempo_chain,
    _cleanup,
    _has_audio,
    _probe,
    _run_ffmpeg,
    _text_y,
    _video_look,
    _workspace,
)
from .video_tools_v2 import (
    MAX_AUDIO_FILES,
    MAX_IMAGE_FILES,
    MAX_VIDEO_FILES,
    _fit_filters,
    _rotation_filters,
    _save_media,
    _validate_project,
)
from .video_tools_v3 import _hex, _safe_clip, _validate_v3

router = APIRouter(prefix="/api/video/v4", tags=["video-studio-v4"])

TRANSITIONS = {
    "none",
    "fade",
    "fadeblack",
    "fadewhite",
    "dissolve",
    "wipeleft",
    "wiperight",
    "slideleft",
    "slideright",
    "smoothleft",
    "smoothright",
    "circleopen",
    "circleclose",
    "pixelize",
}
SPEED_RAMPS = {"off", "montage", "hero", "bullet", "flash"}
SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.]+)")
SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)(?:\s*\|\s*silence_duration:\s*([0-9.]+))?")


def _validate_v4(project: dict) -> dict:
    transition = str(project.get("transition", "fade"))
    project["transition"] = transition if transition in TRANSITIONS else "fade"

    for clip in project.get("clips", []):
        clip["brightness"] = _safe_clip(clip.get("brightness", 0), -.6, .6, 0)
        clip["contrast"] = _safe_clip(clip.get("contrast", 1), .5, 2.0, 1)
        clip["saturation"] = _safe_clip(clip.get("saturation", 1), 0, 3.0, 1)
        clip["temperature"] = _safe_clip(clip.get("temperature", 0), -1, 1, 0)
        clip["vignette"] = _safe_clip(clip.get("vignette", 0), 0, 1, 0)
        ramp = str(clip.get("speedRamp", "off"))
        clip["speedRamp"] = ramp if ramp in SPEED_RAMPS else "off"
    return project


def _ramp_speeds(preset: str, base_speed: float) -> list[float]:
    relative = {
        "montage": [.70, 1.80, .70],
        "hero": [.50, 1.00, 2.00],
        "bullet": [1.00, .35, 1.00],
        "flash": [2.00, .50, 2.00],
    }.get(preset)
    if not relative:
        return [base_speed]
    return [min(4.0, max(.25, base_speed * value)) for value in relative]


def _grading_filters(clip: dict) -> list[str]:
    brightness = float(clip.get("brightness", 0))
    contrast = float(clip.get("contrast", 1))
    saturation = float(clip.get("saturation", 1))
    temperature = float(clip.get("temperature", 0))
    vignette = float(clip.get("vignette", 0))
    result = [f"eq=brightness={brightness:.5f}:contrast={contrast:.5f}:saturation={saturation:.5f}"]
    if abs(temperature) > .001:
        shift = temperature * .12
        result.append(f"colorbalance=rs={shift:.5f}:bs={-shift:.5f}")
    if vignette > .001:
        angle = 3.14159265 / max(2.2, 8.0 - 5.0 * vignette)
        result.append(f"vignette=angle={angle:.7f}")
    return result


def _segment_chain(
    filters: list[str],
    src: int,
    clip_index: int,
    start: float,
    end: float,
    speeds: list[float],
    has_audio: bool,
) -> tuple[str, str | None, float]:
    source_duration = end - start
    segment_count = len(speeds)
    segment_source = source_duration / segment_count
    video_labels: list[str] = []
    audio_labels: list[str] = []
    output_duration = 0.0

    for segment_index, speed in enumerate(speeds):
        seg_start = start + segment_source * segment_index
        seg_end = end if segment_index == segment_count - 1 else start + segment_source * (segment_index + 1)
        seg_source_duration = max(.001, seg_end - seg_start)
        seg_output_duration = seg_source_duration / speed
        output_duration += seg_output_duration

        vlabel = f"vr{clip_index}_{segment_index}"
        filters.append(
            f"[{src}:v]trim=start={seg_start:.6f}:end={seg_end:.6f},"
            f"setpts=PTS-STARTPTS,setpts=PTS/{speed:.6f}[{vlabel}]"
        )
        video_labels.append(vlabel)

        if has_audio:
            alabel = f"ar{clip_index}_{segment_index}"
            af = [
                f"atrim=start={seg_start:.6f}:end={seg_end:.6f}",
                "asetpts=PTS-STARTPTS",
                *_atempo_chain(speed),
                "aresample=48000",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
            ]
            filters.append(f"[{src}:a]{','.join(af)}[{alabel}]")
            audio_labels.append(alabel)

    if len(video_labels) == 1:
        video_out = video_labels[0]
    else:
        video_out = f"vrc{clip_index}"
        filters.append(f"{''.join(f'[{label}]' for label in video_labels)}concat=n={len(video_labels)}:v=1:a=0[{video_out}]")

    audio_out: str | None = None
    if has_audio:
        if len(audio_labels) == 1:
            audio_out = audio_labels[0]
        else:
            audio_out = f"arc{clip_index}"
            filters.append(f"{''.join(f'[{label}]' for label in audio_labels)}concat=n={len(audio_labels)}:v=0:a=1[{audio_out}]")

    return video_out, audio_out, output_duration


def _build_v4_filters(project: dict, videos: list[Path], audios: list[Path], images: list[Path], video_probes: list[dict], width: int, height: int, folder: Path) -> tuple[list[str], str, str, float]:
    clips: list[dict] = project["clips"]
    filters: list[str] = []
    clip_durations: list[float] = []
    transition = str(project.get("transition", "fade"))
    transition_duration = min(1.5, max(.1, float(project.get("transitionDuration", .45))))

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
    elif transition != "none":
        current_v, current_a = "v0", "a0"
        timeline_duration = clip_durations[0]
        for i in range(1, len(clips)):
            fade = min(transition_duration, max(.05, clip_durations[i] / 3), max(.05, timeline_duration / 3))
            offset = max(0.0, timeline_duration - fade)
            nv, na = f"vx{i}", f"ax{i}"
            filters.append(f"[{current_v}][v{i}]xfade=transition={transition}:duration={fade:.6f}:offset={offset:.6f}[{nv}]")
            filters.append(f"[{current_a}][a{i}]acrossfade=d={fade:.6f}:c1=tri:c2=tri[{na}]")
            timeline_duration += clip_durations[i] - fade
            current_v, current_a = nv, na
        video_out, audio_out = current_v, current_a
    else:
        inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
        filters.append(f"{inputs}concat=n={len(clips)}:v=1:a=1[vcat][acat]")
        video_out, audio_out = "vcat", "acat"
        timeline_duration = sum(clip_durations)

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
        filters.append(f"[{input_index}:v]format=rgba,scale=w='{scale_expr}':h=-1:eval=frame,colorchannelmixer=aa={opacity:.4f}[{img_label}]")
        filters.append(f"[{video_out}][{img_label}]overlay=x='{x_expr}':y='{y_expr}':enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]")
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
        filters.append(f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:duration=longest:dropout_transition=2,alimiter=limit=.98[amixout]")
        audio_out = "amixout"

    return filters, video_out, audio_out, timeline_duration


@router.post("/render")
async def render_video_v4(
    video_files: list[UploadFile] = File(...),
    audio_files: list[UploadFile] | None = File(None),
    image_files: list[UploadFile] | None = File(None),
    manifest: str = Form(...),
    output_size: Literal["720p", "1080p", "portrait", "square"] = Form("720p"),
    quality: Literal["draft", "standard", "high"] = Form("standard"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    audio_files = audio_files or []
    image_files = image_files or []
    if not video_files or len(video_files) > MAX_VIDEO_FILES:
        raise HTTPException(status_code=400, detail=f"ارفع من 1 إلى {MAX_VIDEO_FILES} ملفات فيديو.")
    if len(audio_files) > MAX_AUDIO_FILES or len(image_files) > MAX_IMAGE_FILES:
        raise HTTPException(status_code=400, detail="عدد ملفات الصوت أو الصور أكبر من الحد المسموح.")

    folder = _workspace()
    try:
        videos = [await _save_media(item, folder, i, "video") for i, item in enumerate(video_files)]
        audios = [await _save_media(item, folder, i, "audio") for i, item in enumerate(audio_files)]
        images = [await _save_media(item, folder, i, "image") for i, item in enumerate(image_files)]
        video_probes = await asyncio.gather(*[asyncio.to_thread(_probe, item) for item in videos])
        project = _validate_project(manifest, len(videos), len(audios), len(images), video_probes)
        project = _validate_v3(project)
        project = _validate_v4(project)
        width, height = OUTPUT_SIZES[output_size]

        command = ["ffmpeg", "-hide_banner", "-y"]
        for item in videos:
            command.extend(["-i", str(item)])
        for item in audios:
            command.extend(["-i", str(item)])
        for item in images:
            command.extend(["-loop", "1", "-framerate", "30", "-i", str(item)])

        filters, video_out, audio_out, timeline_duration = _build_v4_filters(
            project, videos, audios, images, video_probes, width, height, folder
        )
        output = folder / "MAGHRABI-video-v4.mp4"
        crf = {"draft": "28", "standard": "23", "high": "19"}[quality]
        preset = {"draft": "ultrafast", "standard": "veryfast", "high": "fast"}[quality]
        command.extend([
            "-filter_complex", ";".join(filters),
            "-map", f"[{video_out}]",
            "-map", f"[{audio_out}]",
            "-c:v", "libx264", "-preset", preset, "-crf", crf,
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            "-t", f"{timeline_duration:.6f}", "-movflags", "+faststart", str(output),
        ])
        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(
            output,
            media_type="video/mp4",
            filename="MAGHRABI-video-v4.mp4",
            background=BackgroundTask(_cleanup, folder),
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v4] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render مشروع V4. راجع Railway Logs للتفاصيل.") from exc


@router.post("/silence-detect")
async def silence_detect(
    file: UploadFile = File(...),
    threshold_db: float = Form(-35),
    min_duration: float = Form(.5),
    _username: str = Depends(require_auth),
) -> dict:
    threshold_db = min(-5.0, max(-80.0, float(threshold_db)))
    min_duration = min(10.0, max(.1, float(min_duration)))
    folder = _workspace()
    try:
        path = await _save_media(file, folder, 0, "video")
        probe = await asyncio.to_thread(_probe, path)
        try:
            total_duration = max(.01, float(probe.get("format", {}).get("duration", 0)))
        except (TypeError, ValueError):
            total_duration = .01
        process = await asyncio.to_thread(
            subprocess.run,
            [
                "ffmpeg", "-hide_banner", "-i", str(path),
                "-af", f"silencedetect=noise={threshold_db:.2f}dB:d={min_duration:.3f}",
                "-f", "null", "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        intervals: list[dict] = []
        open_start: float | None = None
        for line in process.stdout.splitlines():
            start_match = SILENCE_START_RE.search(line)
            if start_match:
                open_start = max(0.0, float(start_match.group(1)))
                continue
            end_match = SILENCE_END_RE.search(line)
            if end_match and open_start is not None:
                end = min(total_duration, float(end_match.group(1)))
                if end > open_start:
                    intervals.append({"start": open_start, "end": end, "duration": end - open_start})
                open_start = None
        if open_start is not None and total_duration > open_start:
            intervals.append({"start": open_start, "end": total_duration, "duration": total_duration - open_start})
        total_silence = sum(item["duration"] for item in intervals)
        return {
            "duration": total_duration,
            "intervals": intervals,
            "totalSilence": total_silence,
            "thresholdDb": threshold_db,
            "minDuration": min_duration,
        }
    finally:
        _cleanup(folder)
