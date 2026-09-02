from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import DATA_DIR, MAX_UPLOAD_MB, require_auth

router = APIRouter(prefix="/api/video", tags=["video-studio"])
VIDEO_DIR = DATA_DIR / "video"
VIDEO_DIR.mkdir(parents=True, exist_ok=True)

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
MAX_FILES = 10
MAX_CLIPS = 24
FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

OUTPUT_SIZES: dict[str, tuple[int, int]] = {
    "720p": (1280, 720),
    "1080p": (1920, 1080),
    "portrait": (1080, 1920),
    "square": (1080, 1080),
}


def _workspace() -> Path:
    return Path(tempfile.mkdtemp(prefix="render-", dir=VIDEO_DIR))


def _cleanup(folder: Path) -> None:
    shutil.rmtree(folder, ignore_errors=True)


async def _save_upload(upload: UploadFile, folder: Path, index: int) -> Path:
    original = Path(upload.filename or f"video-{index}.mp4").name
    extension = Path(original).suffix.lower()
    if extension not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"صيغة الفيديو {extension or 'غير المعروفة'} غير مدعومة.")

    target = folder / f"source-{index}{extension}"
    size = 0
    with target.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                target.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"الحد الأعلى لكل ملف فيديو هو {MAX_UPLOAD_MB} MB.",
                )
            output.write(chunk)
    await upload.close()
    return target


def _probe(path: Path) -> dict:
    process = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,width,height",
            "-of",
            "json",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError("تعذر قراءة معلومات أحد ملفات الفيديو.")
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("تعذر تحليل معلومات ملف الفيديو.") from exc


def _has_audio(probe: dict) -> bool:
    return any(stream.get("codec_type") == "audio" for stream in probe.get("streams", []))


def _duration(probe: dict) -> float:
    try:
        return max(0.01, float(probe.get("format", {}).get("duration", 0)))
    except (TypeError, ValueError):
        return 0.01


def _atempo_chain(speed: float) -> list[str]:
    value = speed
    filters: list[str] = []
    while value > 2.0:
        filters.append("atempo=2.0")
        value /= 2.0
    while value < 0.5:
        filters.append("atempo=0.5")
        value /= 0.5
    filters.append(f"atempo={value:.6f}")
    return filters


def _video_look(name: str) -> list[str]:
    return {
        "none": [],
        "warm": ["eq=contrast=1.04:brightness=0.02:saturation=1.12", "colorbalance=rs=.05:bs=-.03"],
        "cool": ["eq=contrast=1.03:brightness=0.00:saturation=1.05", "colorbalance=bs=.06:rs=-.02"],
        "cinematic": ["eq=contrast=1.12:brightness=-0.025:saturation=.90", "vignette=PI/5"],
        "vivid": ["eq=contrast=1.07:brightness=.01:saturation=1.35"],
        "mono": ["hue=s=0", "eq=contrast=1.08"],
    }.get(name, [])


def _text_y(position: str) -> str:
    if position == "top":
        return "h*0.08"
    if position == "center":
        return "(h-text_h)/2"
    return "h-text_h-h*0.08"


def _run_ffmpeg(command: list[str]) -> None:
    process = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        tail = "\n".join(process.stdout.splitlines()[-40:])
        print(f"[video-studio] ffmpeg failed:\n{tail}", flush=True)
        raise RuntimeError("تعذر تصدير الفيديو. راجع سجل Railway للتفاصيل التقنية.")


def _validate_manifest(raw: str, file_count: int, probes: list[dict]) -> dict:
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="بيانات مشروع الفيديو غير صالحة.") from exc

    clips = manifest.get("clips")
    if not isinstance(clips, list) or not clips:
        raise HTTPException(status_code=400, detail="أضف مقطع فيديو واحدًا على الأقل إلى Timeline.")
    if len(clips) > MAX_CLIPS:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى هو {MAX_CLIPS} مقطعًا في المشروع.")

    for clip in clips:
        try:
            file_index = int(clip.get("fileIndex"))
            if file_index < 0 or file_index >= file_count:
                raise ValueError
            source_duration = _duration(probes[file_index])
            start = max(0.0, float(clip.get("start", 0)))
            end = min(source_duration, float(clip.get("end", source_duration)))
            speed = float(clip.get("speed", 1))
            volume = float(clip.get("volume", 1))
            if end <= start or not 0.25 <= speed <= 4.0 or not 0 <= volume <= 2.0:
                raise ValueError
            clip["fileIndex"] = file_index
            clip["start"] = start
            clip["end"] = end
            clip["speed"] = speed
            clip["volume"] = volume
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="إحدى إعدادات المقاطع غير صالحة.")

    return manifest


@router.post("/render")
async def render_video(
    files: list[UploadFile] = File(...),
    manifest: str = Form(...),
    output_size: Literal["720p", "1080p", "portrait", "square"] = Form("720p"),
    quality: Literal["draft", "standard", "high"] = Form("standard"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    if not files or len(files) > MAX_FILES:
        raise HTTPException(status_code=400, detail=f"ارفع من ملف واحد إلى {MAX_FILES} ملفات فيديو.")

    folder = _workspace()
    try:
        sources = [await _save_upload(upload, folder, index) for index, upload in enumerate(files)]
        probes = await asyncio.gather(*[asyncio.to_thread(_probe, source) for source in sources])
        project = _validate_manifest(manifest, len(sources), probes)
        clips: list[dict] = project["clips"]

        width, height = OUTPUT_SIZES[output_size]
        transition = project.get("transition", "none")
        transition_duration = min(1.5, max(0.15, float(project.get("transitionDuration", 0.45))))

        command = ["ffmpeg", "-hide_banner", "-y"]
        for source in sources:
            command.extend(["-i", str(source)])

        filters: list[str] = []
        clip_durations: list[float] = []

        for index, clip in enumerate(clips):
            source_index = clip["fileIndex"]
            start = clip["start"]
            end = clip["end"]
            speed = clip["speed"]
            volume = clip["volume"]
            out_duration = (end - start) / speed
            clip_durations.append(out_duration)

            video_filters = [
                f"trim=start={start:.6f}:end={end:.6f}",
                "setpts=PTS-STARTPTS",
                f"setpts=PTS/{speed:.6f}",
                f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
                "setsar=1",
                "fps=30",
                "settb=AVTB",
            ]
            video_filters.extend(_video_look(str(clip.get("filter", "none"))))

            text = str(clip.get("text", "")).strip()
            if text:
                text_path = folder / f"text-{index}.txt"
                text_path.write_text(text[:500], encoding="utf-8")
                font_size = max(24, min(96, int(clip.get("textSize", 48))))
                position = _text_y(str(clip.get("textPosition", "bottom")))
                video_filters.append(
                    "drawtext="
                    f"fontfile='{FONT_FILE}':textfile='{text_path}':reload=0:"
                    f"fontcolor=white:fontsize={font_size}:x=(w-text_w)/2:y={position}:"
                    "box=1:boxcolor=black@0.48:boxborderw=14"
                )

            filters.append(f"[{source_index}:v]{','.join(video_filters)}[v{index}]")

            if _has_audio(probes[source_index]):
                audio_filters = [
                    f"atrim=start={start:.6f}:end={end:.6f}",
                    "asetpts=PTS-STARTPTS",
                    *_atempo_chain(speed),
                    "aresample=48000",
                    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
                    f"volume={volume:.4f}",
                ]
                filters.append(f"[{source_index}:a]{','.join(audio_filters)}[a{index}]")
            else:
                filters.append(
                    f"anullsrc=r=48000:cl=stereo,atrim=duration={out_duration:.6f},asetpts=PTS-STARTPTS[a{index}]"
                )

        if len(clips) == 1:
            video_out = "v0"
            audio_out = "a0"
        elif transition == "fade":
            current_v = "v0"
            current_a = "a0"
            timeline_duration = clip_durations[0]
            for index in range(1, len(clips)):
                fade = min(transition_duration, max(0.05, clip_durations[index] / 3), max(0.05, timeline_duration / 3))
                offset = max(0.0, timeline_duration - fade)
                next_v = f"vx{index}"
                next_a = f"ax{index}"
                filters.append(
                    f"[{current_v}][v{index}]xfade=transition=fade:duration={fade:.6f}:offset={offset:.6f}[{next_v}]"
                )
                filters.append(f"[{current_a}][a{index}]acrossfade=d={fade:.6f}:c1=tri:c2=tri[{next_a}]")
                timeline_duration = timeline_duration + clip_durations[index] - fade
                current_v, current_a = next_v, next_a
            video_out, audio_out = current_v, current_a
        else:
            concat_inputs = "".join(f"[v{index}][a{index}]" for index in range(len(clips)))
            filters.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[vcat][acat]")
            video_out, audio_out = "vcat", "acat"

        output = folder / "MAGHRABI-video.mp4"
        crf = {"draft": "28", "standard": "23", "high": "19"}[quality]
        preset = {"draft": "ultrafast", "standard": "veryfast", "high": "fast"}[quality]

        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                f"[{video_out}]",
                "-map",
                f"[{audio_out}]",
                "-c:v",
                "libx264",
                "-preset",
                preset,
                "-crf",
                crf,
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                str(output),
            ]
        )

        await asyncio.to_thread(_run_ffmpeg, command)
        return FileResponse(
            output,
            media_type="video/mp4",
            filename="MAGHRABI-video.mp4",
            background=BackgroundTask(_cleanup, folder),
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except Exception as exc:
        _cleanup(folder)
        print(f"[video-studio] render error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
