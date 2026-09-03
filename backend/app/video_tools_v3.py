from __future__ import annotations

import asyncio
import json
import re
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

router = APIRouter(prefix="/api/video/v3", tags=["video-studio-v3"])
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_SUBTITLES = 120


def _hex(value: object, fallback: str) -> str:
    text = str(value or fallback)
    return text if HEX_COLOR.match(text) else fallback


def _safe_clip(value: object, low: float, high: float, fallback: float) -> float:
    try:
        return min(high, max(low, float(value)))
    except (TypeError, ValueError):
        return fallback


def _validate_v3(project: dict) -> dict:
    for clip in project.get("clips", []):
        clip["zoomStart"] = _safe_clip(clip.get("zoomStart", 1), 1, 4, 1)
        clip["zoomEnd"] = _safe_clip(clip.get("zoomEnd", clip["zoomStart"]), 1, 4, clip["zoomStart"])
        clip["panXStart"] = _safe_clip(clip.get("panXStart", 0), -1, 1, 0)
        clip["panXEnd"] = _safe_clip(clip.get("panXEnd", clip["panXStart"]), -1, 1, clip["panXStart"])
        clip["panYStart"] = _safe_clip(clip.get("panYStart", 0), -1, 1, 0)
        clip["panYEnd"] = _safe_clip(clip.get("panYEnd", clip["panYStart"]), -1, 1, clip["panYStart"])
        clip["chromaEnabled"] = bool(clip.get("chromaEnabled", False))
        clip["chromaColor"] = _hex(clip.get("chromaColor"), "#00ff00")
        clip["chromaBackground"] = _hex(clip.get("chromaBackground"), "#101010")
        clip["chromaSimilarity"] = _safe_clip(clip.get("chromaSimilarity", .18), .01, 1, .18)
        clip["chromaBlend"] = _safe_clip(clip.get("chromaBlend", .06), 0, 1, .06)

    subtitles = project.get("subtitleTracks", [])
    if not isinstance(subtitles, list) or len(subtitles) > MAX_SUBTITLES:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_SUBTITLES} سطر ترجمة.")
    for item in subtitles:
        try:
            start_at = max(0.0, float(item.get("startAt", 0)))
            end_at = float(item.get("endAt", start_at + 2))
            if end_at <= start_at:
                raise ValueError
            item["startAt"] = start_at
            item["endAt"] = end_at
            item["size"] = int(_safe_clip(item.get("size", 38), 18, 84, 38))
            item["position"] = str(item.get("position", "bottom"))
            if item["position"] not in {"top", "center", "bottom"}:
                item["position"] = "bottom"
            item["color"] = _hex(item.get("color"), "#ffffff")
            item["boxOpacity"] = _safe_clip(item.get("boxOpacity", .48), 0, 1, .48)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="إحدى طبقات الترجمة غير صالحة.")

    for item in project.get("imageTracks", []):
        item["startX"] = _safe_clip(item.get("startX", .78), 0, 1, .78)
        item["startY"] = _safe_clip(item.get("startY", .78), 0, 1, .78)
        item["endX"] = _safe_clip(item.get("endX", item["startX"]), 0, 1, item["startX"])
        item["endY"] = _safe_clip(item.get("endY", item["startY"]), 0, 1, item["startY"])
        item["scaleStart"] = _safe_clip(item.get("scaleStart", item.get("scale", .22)), .05, 1, .22)
        item["scaleEnd"] = _safe_clip(item.get("scaleEnd", item["scaleStart"]), .05, 1, item["scaleStart"])

    return project


def _progress_expr(start: float, end: float, frames: int) -> str:
    if frames <= 1 or abs(end - start) < 1e-7:
        return f"{start:.6f}"
    return f"{start:.6f}+({end - start:.6f})*min(on/{max(1, frames - 1)},1)"


def _pan_expr(start: float, end: float, frames: int) -> str:
    if frames <= 1 or abs(end - start) < 1e-7:
        return f"{start:.6f}"
    return f"{start:.6f}+({end - start:.6f})*min(on/{max(1, frames - 1)},1)"


@router.post("/render")
async def render_video_v3(
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
        clips: list[dict] = project["clips"]
        width, height = OUTPUT_SIZES[output_size]
        transition = str(project.get("transition", "none"))
        transition_duration = min(1.5, max(.1, float(project.get("transitionDuration", .45))))

        command = ["ffmpeg", "-hide_banner", "-y"]
        for item in videos:
            command.extend(["-i", str(item)])
        audio_base = len(videos)
        for item in audios:
            command.extend(["-i", str(item)])
        image_base = audio_base + len(audios)
        for item in images:
            command.extend(["-loop", "1", "-framerate", "30", "-i", str(item)])

        filters: list[str] = []
        clip_durations: list[float] = []

        for index, clip in enumerate(clips):
            src = clip["fileIndex"]
            start, end, speed, volume = clip["start"], clip["end"], clip["speed"], clip["volume"]
            out_duration = (end - start) / speed
            frames = max(1, round(out_duration * 30))
            clip_durations.append(out_duration)

            base_filters = [
                f"trim=start={start:.6f}:end={end:.6f}",
                "setpts=PTS-STARTPTS",
                f"setpts=PTS/{speed:.6f}",
                *_rotation_filters(clip.get("rotation", 0)),
                *_fit_filters(width, height, clip.get("fit", "contain")),
                "setsar=1",
                "fps=30",
                "settb=AVTB",
                *_video_look(str(clip.get("filter", "none"))),
            ]
            base_label = f"vb{index}"
            filters.append(f"[{src}:v]{','.join(base_filters)}[{base_label}]")

            if clip.get("chromaEnabled"):
                key_color = clip["chromaColor"].replace("#", "0x")
                bg_color = clip["chromaBackground"].replace("#", "0x")
                keyed = f"vk{index}"
                bg = f"vbg{index}"
                composed = f"vc{index}"
                filters.append(
                    f"[{base_label}]format=rgba,chromakey={key_color}:{clip['chromaSimilarity']:.5f}:{clip['chromaBlend']:.5f}[{keyed}]"
                )
                filters.append(f"color=c={bg_color}:s={width}x{height}:r=30:d={out_duration:.6f}[{bg}]")
                filters.append(f"[{bg}][{keyed}]overlay=0:0:shortest=1[{composed}]")
                base_label = composed

            zoom_expr = _progress_expr(clip["zoomStart"], clip["zoomEnd"], frames)
            pan_x_expr = _pan_expr(clip["panXStart"], clip["panXEnd"], frames)
            pan_y_expr = _pan_expr(clip["panYStart"], clip["panYEnd"], frames)
            zlabel = f"v{index}"
            filters.append(
                f"[{base_label}]zoompan="
                f"z='{zoom_expr}':"
                f"x='(iw-iw/zoom)*(0.5+0.5*({pan_x_expr}))':"
                f"y='(ih-ih/zoom)*(0.5+0.5*({pan_y_expr}))':"
                f"d=1:s={width}x{height}:fps=30[{zlabel}]"
            )

            if _has_audio(video_probes[src]):
                af = [
                    f"atrim=start={start:.6f}:end={end:.6f}",
                    "asetpts=PTS-STARTPTS",
                    *_atempo_chain(speed),
                    "aresample=48000",
                    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
                    f"volume={volume:.4f}",
                ]
                filters.append(f"[{src}:a]{','.join(af)}[a{index}]")
            else:
                filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={out_duration:.6f},asetpts=PTS-STARTPTS[a{index}]")

        if len(clips) == 1:
            video_out, audio_out = "v0", "a0"
            timeline_duration = clip_durations[0]
        elif transition == "fade":
            current_v, current_a = "v0", "a0"
            timeline_duration = clip_durations[0]
            for i in range(1, len(clips)):
                fade = min(transition_duration, max(.05, clip_durations[i] / 3), max(.05, timeline_duration / 3))
                offset = max(0.0, timeline_duration - fade)
                nv, na = f"vx{i}", f"ax{i}"
                filters.append(f"[{current_v}][v{i}]xfade=transition=fade:duration={fade:.6f}:offset={offset:.6f}[{nv}]")
                filters.append(f"[{current_a}][a{i}]acrossfade=d={fade:.6f}:c1=tri:c2=tri[{na}]")
                timeline_duration += clip_durations[i] - fade
                current_v, current_a = nv, na
            video_out, audio_out = current_v, current_a
        else:
            inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
            filters.append(f"{inputs}concat=n={len(clips)}:v=1:a=1[vcat][acat]")
            video_out, audio_out = "vcat", "acat"
            timeline_duration = sum(clip_durations)

        # Title / free text layers inherited from V2.
        for i, track in enumerate(project.get("textTracks", [])):
            text = str(track.get("text", "")).strip()[:500]
            if not text:
                continue
            start_at = max(0.0, float(track.get("startAt", 0)))
            end_at = min(timeline_duration, float(track.get("endAt", timeline_duration)))
            if end_at <= start_at:
                continue
            text_path = folder / f"v3-title-{i}.txt"
            text_path.write_text(text, encoding="utf-8")
            size = max(20, min(120, int(track.get("size", 52))))
            position = _text_y(str(track.get("position", "bottom")))
            label = f"vtitle{i}"
            filters.append(
                f"[{video_out}]drawtext=fontfile='{FONT_FILE}':textfile='{text_path}':reload=0:"
                f"fontcolor=white:fontsize={size}:x=(w-text_w)/2:y={position}:"
                f"box=1:boxcolor=black@0.42:boxborderw=12:enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]"
            )
            video_out = label

        # Subtitle track, optimized for many short caption rows.
        for i, track in enumerate(project.get("subtitleTracks", [])):
            text = str(track.get("text", "")).strip()[:700]
            if not text:
                continue
            start_at = max(0.0, float(track["startAt"]))
            end_at = min(timeline_duration, float(track["endAt"]))
            if end_at <= start_at:
                continue
            text_path = folder / f"v3-sub-{i}.txt"
            text_path.write_text(text, encoding="utf-8")
            size = int(track["size"])
            position = _text_y(track["position"])
            color = track["color"].replace("#", "0x")
            label = f"vsub{i}"
            filters.append(
                f"[{video_out}]drawtext=fontfile='{FONT_FILE}':textfile='{text_path}':reload=0:"
                f"fontcolor={color}:fontsize={size}:x=(w-text_w)/2:y={position}:"
                f"box=1:boxcolor=black@{track['boxOpacity']:.4f}:boxborderw=10:"
                f"enable='between(t,{start_at:.6f},{end_at:.6f})'[{label}]"
            )
            video_out = label

        # Animated image/logo overlays with start/end motion keyframes.
        for i, track in enumerate(project.get("imageTracks", [])):
            input_index = image_base + int(track["fileIndex"])
            start_at = float(track["startAt"])
            end_at = min(timeline_duration, float(track["endAt"]))
            if end_at <= start_at:
                continue
            duration = max(.001, end_at - start_at)
            opacity = float(track.get("opacity", 1))
            scale_start = float(track.get("scaleStart", track.get("scale", .22)))
            scale_end = float(track.get("scaleEnd", scale_start))
            sx, sy = float(track.get("startX", .78)), float(track.get("startY", .78))
            ex, ey = float(track.get("endX", sx)), float(track.get("endY", sy))
            img_label = f"img{i}"
            label = f"vimg{i}"
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

        # Music and secondary audio layers.
        mix_labels = [f"[{audio_out}]"]
        for i, track in enumerate(project.get("audioTracks", [])):
            input_index = audio_base + int(track["fileIndex"])
            source_start, source_end = float(track["sourceStart"]), float(track["sourceEnd"])
            duration = source_end - source_start
            delay_ms = max(0, round(float(track["startAt"]) * 1000))
            af = [
                f"atrim=start={source_start:.6f}:end={source_end:.6f}",
                "asetpts=PTS-STARTPTS",
                "aresample=48000",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
                f"volume={float(track['volume']):.4f}",
            ]
            if float(track.get("fadeIn", 0)) > 0:
                af.append(f"afade=t=in:st=0:d={min(float(track['fadeIn']), duration):.4f}")
            if float(track.get("fadeOut", 0)) > 0:
                fade_d = min(float(track["fadeOut"]), duration)
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

        output = folder / "MAGHRABI-video-v3.mp4"
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
            filename="MAGHRABI-video-v3.mp4",
            background=BackgroundTask(_cleanup, folder),
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v3] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render مشروع V3. راجع Railway Logs للتفاصيل.") from exc
