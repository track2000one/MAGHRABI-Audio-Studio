from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import MAX_UPLOAD_MB, require_auth
from .video_tools import (
    FONT_FILE,
    OUTPUT_SIZES,
    VIDEO_EXTENSIONS,
    _atempo_chain,
    _cleanup,
    _duration,
    _has_audio,
    _probe,
    _run_ffmpeg,
    _text_y,
    _video_look,
    _workspace,
)

router = APIRouter(prefix="/api/video/v2", tags=["video-studio-pro"])
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_VIDEO_FILES = 10
MAX_AUDIO_FILES = 8
MAX_IMAGE_FILES = 12
MAX_CLIPS = 40
MAX_OVERLAYS = 30


async def _save_media(upload: UploadFile, folder: Path, index: int, kind: str) -> Path:
    original = Path(upload.filename or f"{kind}-{index}").name
    ext = Path(original).suffix.lower()
    allowed = VIDEO_EXTENSIONS if kind == "video" else AUDIO_EXTENSIONS if kind == "audio" else IMAGE_EXTENSIONS
    if ext not in allowed:
        raise HTTPException(status_code=415, detail=f"صيغة {kind} {ext or 'غير المعروفة'} غير مدعومة.")
    target = folder / f"{kind}-{index}{ext}"
    size = 0
    with target.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"الحد الأعلى لكل ملف هو {MAX_UPLOAD_MB} MB.")
            output.write(chunk)
    await upload.close()
    return target


def _rotation_filters(value: int) -> list[str]:
    value %= 360
    if value == 90:
        return ["transpose=clock"]
    if value == 180:
        return ["hflip", "vflip"]
    if value == 270:
        return ["transpose=cclock"]
    return []


def _fit_filters(width: int, height: int, fit: str) -> list[str]:
    if fit == "cover":
        return [
            f"scale={width}:{height}:force_original_aspect_ratio=increase",
            f"crop={width}:{height}",
        ]
    return [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
    ]


def _overlay_xy(position: str) -> tuple[str, str]:
    margin = 36
    mapping = {
        "top-left": (str(margin), str(margin)),
        "top-right": (f"W-w-{margin}", str(margin)),
        "bottom-left": (str(margin), f"H-h-{margin}"),
        "bottom-right": (f"W-w-{margin}", f"H-h-{margin}"),
        "center": ("(W-w)/2", "(H-h)/2"),
    }
    return mapping.get(position, mapping["bottom-right"])


def _validate_project(raw: str, video_count: int, audio_count: int, image_count: int, probes: list[dict]) -> dict:
    try:
        project = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="بيانات مشروع الفيديو غير صالحة.") from exc

    clips = project.get("clips")
    if not isinstance(clips, list) or not clips:
        raise HTTPException(status_code=400, detail="أضف مقطع فيديو واحدًا على الأقل.")
    if len(clips) > MAX_CLIPS:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى {MAX_CLIPS} مقطع فيديو.")

    for clip in clips:
        try:
            idx = int(clip.get("fileIndex"))
            if not 0 <= idx < video_count:
                raise ValueError
            source_duration = _duration(probes[idx])
            start = max(0.0, float(clip.get("start", 0)))
            end = min(source_duration, float(clip.get("end", source_duration)))
            speed = float(clip.get("speed", 1))
            volume = float(clip.get("volume", 1))
            rotation = int(clip.get("rotation", 0))
            fit = str(clip.get("fit", "contain"))
            if end <= start or not .25 <= speed <= 4 or not 0 <= volume <= 2:
                raise ValueError
            if rotation not in {0, 90, 180, 270} or fit not in {"contain", "cover"}:
                raise ValueError
            clip.update(fileIndex=idx, start=start, end=end, speed=speed, volume=volume, rotation=rotation, fit=fit)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="إحدى إعدادات مقاطع الفيديو غير صالحة.")

    text_tracks = project.get("textTracks", [])
    audio_tracks = project.get("audioTracks", [])
    image_tracks = project.get("imageTracks", [])
    if len(text_tracks) + len(audio_tracks) + len(image_tracks) > MAX_OVERLAYS:
        raise HTTPException(status_code=400, detail="عدد طبقات المشروع كبير جدًا.")

    for track in audio_tracks:
        try:
            idx = int(track.get("fileIndex"))
            if not 0 <= idx < audio_count:
                raise ValueError
            start_at = max(0.0, float(track.get("startAt", 0)))
            source_start = max(0.0, float(track.get("sourceStart", 0)))
            source_end = float(track.get("sourceEnd", 0))
            volume = float(track.get("volume", .7))
            fade_in = max(0.0, min(10.0, float(track.get("fadeIn", 0))))
            fade_out = max(0.0, min(10.0, float(track.get("fadeOut", 0))))
            if source_end <= source_start or not 0 <= volume <= 2:
                raise ValueError
            track.update(fileIndex=idx, startAt=start_at, sourceStart=source_start, sourceEnd=source_end, volume=volume, fadeIn=fade_in, fadeOut=fade_out)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="إحدى طبقات الصوت غير صالحة.")

    for track in image_tracks:
        try:
            idx = int(track.get("fileIndex"))
            if not 0 <= idx < image_count:
                raise ValueError
            start_at = max(0.0, float(track.get("startAt", 0)))
            end_at = float(track.get("endAt", start_at + 2))
            scale = float(track.get("scale", .22))
            opacity = float(track.get("opacity", 1))
            if end_at <= start_at or not .05 <= scale <= 1 or not 0 <= opacity <= 1:
                raise ValueError
            track.update(fileIndex=idx, startAt=start_at, endAt=end_at, scale=scale, opacity=opacity)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="إحدى طبقات الصور غير صالحة.")

    return project


@router.post("/render")
async def render_video_pro(
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
            command.extend(["-loop", "1", "-i", str(item)])

        filters: list[str] = []
        clip_durations: list[float] = []
        for index, clip in enumerate(clips):
            src = clip["fileIndex"]
            start, end, speed, volume = clip["start"], clip["end"], clip["speed"], clip["volume"]
            out_duration = (end - start) / speed
            clip_durations.append(out_duration)
            vf = [
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
            filters.append(f"[{src}:v]{','.join(vf)}[v{index}]")
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

        # Independent text track layers.
        for i, track in enumerate(project.get("textTracks", [])):
            text = str(track.get("text", "")).strip()[:500]
            if not text:
                continue
            start_at = max(0.0, float(track.get("startAt", 0)))
            end_at = min(timeline_duration, float(track.get("endAt", timeline_duration)))
            if end_at <= start_at:
                continue
            text_path = folder / f"pro-text-{i}.txt"
            text_path.write_text(text, encoding="utf-8")
            size = max(20, min(120, int(track.get("size", 52))))
            position = _text_y(str(track.get("position", "bottom")))
            next_label = f"vt{i}"
            filters.append(
                f"[{video_out}]drawtext=fontfile='{FONT_FILE}':textfile='{text_path}':reload=0:"
                f"fontcolor=white:fontsize={size}:x=(w-text_w)/2:y={position}:"
                f"box=1:boxcolor=black@0.42:boxborderw=12:enable='between(t,{start_at:.6f},{end_at:.6f})'[{next_label}]"
            )
            video_out = next_label

        # Independent image/logo layers.
        for i, track in enumerate(project.get("imageTracks", [])):
            input_index = image_base + int(track["fileIndex"])
            start_at, end_at = track["startAt"], min(timeline_duration, track["endAt"])
            if end_at <= start_at:
                continue
            scale_px = max(24, round(width * float(track.get("scale", .22))))
            opacity = float(track.get("opacity", 1))
            img_label = f"img{i}"
            next_label = f"vi{i}"
            x, y = _overlay_xy(str(track.get("position", "bottom-right")))
            filters.append(f"[{input_index}:v]format=rgba,scale={scale_px}:-1,colorchannelmixer=aa={opacity:.4f}[{img_label}]")
            filters.append(f"[{video_out}][{img_label}]overlay=x={x}:y={y}:enable='between(t,{start_at:.6f},{end_at:.6f})'[{next_label}]")
            video_out = next_label

        # Independent music/audio track layers.
        mix_labels = [f"[{audio_out}]"]
        for i, track in enumerate(project.get("audioTracks", [])):
            input_index = audio_base + int(track["fileIndex"])
            source_start, source_end = track["sourceStart"], track["sourceEnd"]
            duration = source_end - source_start
            delay_ms = max(0, round(track["startAt"] * 1000))
            af = [
                f"atrim=start={source_start:.6f}:end={source_end:.6f}",
                "asetpts=PTS-STARTPTS",
                "aresample=48000",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
                f"volume={track['volume']:.4f}",
            ]
            if track.get("fadeIn", 0) > 0:
                af.append(f"afade=t=in:st=0:d={min(track['fadeIn'], duration):.4f}")
            if track.get("fadeOut", 0) > 0:
                fade_d = min(track["fadeOut"], duration)
                af.append(f"afade=t=out:st={max(0, duration - fade_d):.4f}:d={fade_d:.4f}")
            af.append(f"adelay={delay_ms}|{delay_ms}")
            label = f"music{i}"
            filters.append(f"[{input_index}:a]{','.join(af)}[{label}]")
            mix_labels.append(f"[{label}]")

        if len(mix_labels) > 1:
            filters.append(f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:duration=longest:dropout_transition=2,alimiter=limit=.98[amixout]")
            audio_out = "amixout"

        output = folder / "MAGHRABI-video-pro.mp4"
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
        return FileResponse(output, media_type="video/mp4", filename="MAGHRABI-video-pro.mp4", background=BackgroundTask(_cleanup, folder))
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio-v2] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="تعذر Render المشروع الاحترافي. راجع Railway Logs للتفاصيل.") from exc
