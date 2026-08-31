from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import DATA_DIR, MAX_UPLOAD_MB, require_auth

router = APIRouter(prefix="/api/tools", tags=["audio-tools"])
TOOLS_DIR = DATA_DIR / "tools"
TOOLS_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
OUTPUT_FORMATS = {"mp3", "wav", "m4a", "flac"}


def _workspace(prefix: str) -> Path:
    return Path(tempfile.mkdtemp(prefix=f"{prefix}-", dir=TOOLS_DIR))


def _cleanup(folder: Path) -> None:
    shutil.rmtree(folder, ignore_errors=True)


def _codec_args(fmt: str) -> list[str]:
    if fmt == "mp3":
        return ["-c:a", "libmp3lame", "-b:a", "320k"]
    if fmt == "m4a":
        return ["-c:a", "aac", "-b:a", "256k"]
    if fmt == "flac":
        return ["-c:a", "flac"]
    return ["-c:a", "pcm_s16le"]


def _validate_format(fmt: str) -> str:
    fmt = fmt.lower().strip()
    if fmt not in OUTPUT_FORMATS:
        raise HTTPException(status_code=400, detail="صيغة الإخراج غير مدعومة.")
    return fmt


async def _save_upload(upload: UploadFile, folder: Path, index: int = 0) -> Path:
    original_name = Path(upload.filename or "audio").name
    extension = Path(original_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"صيغة الملف {extension or 'غير المعروفة'} غير مدعومة.")

    target = folder / f"input-{index}{extension}"
    size = 0
    with target.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"الحد الأعلى لحجم الملف هو {MAX_UPLOAD_MB} MB.")
            output.write(chunk)
    await upload.close()
    return target


def _run_ffmpeg(command: list[str]) -> None:
    process = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        tail = "\n".join(process.stdout.splitlines()[-18:])
        print(f"[audio-tools] ffmpeg failed: {tail}", flush=True)
        raise RuntimeError("تعذر تنفيذ معالجة الصوت. راجع سجل Railway للتفاصيل التقنية.")


def _response(output: Path, folder: Path, download_name: str) -> FileResponse:
    media = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".flac": "audio/flac",
    }.get(output.suffix.lower(), "application/octet-stream")
    return FileResponse(
        output,
        media_type=media,
        filename=download_name,
        background=BackgroundTask(_cleanup, folder),
    )


@router.post("/trim")
async def trim_audio(
    file: UploadFile = File(...),
    start_seconds: float = Form(0),
    end_seconds: float = Form(...),
    fade_in: float = Form(0),
    fade_out: float = Form(0),
    output_format: str = Form("mp3"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    if start_seconds < 0 or end_seconds <= start_seconds:
        raise HTTPException(status_code=400, detail="حدد وقت بداية ونهاية صحيحين.")
    duration = end_seconds - start_seconds
    if duration > 4 * 60 * 60:
        raise HTTPException(status_code=400, detail="مدة القص القصوى أربع ساعات.")

    fmt = _validate_format(output_format)
    folder = _workspace("trim")
    try:
        source = await _save_upload(file, folder)
        output = folder / f"trimmed.{fmt}"
        filters: list[str] = []
        if fade_in > 0:
            filters.append(f"afade=t=in:st=0:d={min(fade_in, duration):.3f}")
        if fade_out > 0:
            fade_start = max(0, duration - min(fade_out, duration))
            filters.append(f"afade=t=out:st={fade_start:.3f}:d={min(fade_out, duration):.3f}")

        command = ["ffmpeg", "-hide_banner", "-y", "-ss", str(start_seconds), "-i", str(source), "-t", str(duration), "-vn"]
        if filters:
            command.extend(["-af", ",".join(filters)])
        command.extend(_codec_args(fmt))
        command.append(str(output))
        await asyncio.to_thread(_run_ffmpeg, command)
        return _response(output, folder, f"MAGHRABI-trimmed.{fmt}")
    except Exception:
        if folder.exists():
            _cleanup(folder)
        raise


@router.post("/merge")
async def merge_audio(
    files: list[UploadFile] = File(...),
    output_format: str = Form("mp3"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    if len(files) < 2:
        raise HTTPException(status_code=400, detail="اختر ملفين على الأقل للدمج.")
    if len(files) > 12:
        raise HTTPException(status_code=400, detail="يمكن دمج 12 ملفًا كحد أقصى في العملية الواحدة.")

    fmt = _validate_format(output_format)
    folder = _workspace("merge")
    try:
        sources = [await _save_upload(upload, folder, index) for index, upload in enumerate(files)]
        output = folder / f"merged.{fmt}"
        command = ["ffmpeg", "-hide_banner", "-y"]
        for source in sources:
            command.extend(["-i", str(source)])
        inputs = "".join(f"[{index}:a]" for index in range(len(sources)))
        command.extend([
            "-filter_complex",
            f"{inputs}concat=n={len(sources)}:v=0:a=1[outa]",
            "-map",
            "[outa]",
        ])
        command.extend(_codec_args(fmt))
        command.append(str(output))
        await asyncio.to_thread(_run_ffmpeg, command)
        return _response(output, folder, f"MAGHRABI-merged.{fmt}")
    except Exception:
        if folder.exists():
            _cleanup(folder)
        raise


@router.post("/enhance")
async def enhance_audio(
    file: UploadFile = File(...),
    profile: Literal["voice", "music", "clean"] = Form("voice"),
    normalize: bool = Form(True),
    fade_in: float = Form(0),
    fade_out: float = Form(0),
    output_format: str = Form("mp3"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    fmt = _validate_format(output_format)
    folder = _workspace("enhance")
    try:
        source = await _save_upload(file, folder)
        output = folder / f"enhanced.{fmt}"

        if profile == "voice":
            filters = ["highpass=f=80", "lowpass=f=12000", "afftdn=nf=-25", "acompressor=threshold=-18dB:ratio=2.5:attack=20:release=180"]
            target_loudness = "-16"
        elif profile == "music":
            filters = ["highpass=f=25", "lowpass=f=19000", "acompressor=threshold=-14dB:ratio=1.8:attack=30:release=250"]
            target_loudness = "-14"
        else:
            filters = ["afftdn=nf=-28", "highpass=f=45"]
            target_loudness = "-16"

        if normalize:
            filters.append(f"loudnorm=I={target_loudness}:TP=-1.5:LRA=11")
        if fade_in > 0:
            filters.append(f"afade=t=in:st=0:d={min(fade_in, 15):.3f}")
        if fade_out > 0:
            # Reverse-fade-reverse avoids requiring a duration probe for fade-out.
            filters.extend(["areverse", f"afade=t=in:st=0:d={min(fade_out, 15):.3f}", "areverse"])

        command = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(source), "-vn",
            "-af", ",".join(filters),
            *_codec_args(fmt),
            str(output),
        ]
        await asyncio.to_thread(_run_ffmpeg, command)
        return _response(output, folder, f"MAGHRABI-enhanced-{profile}.{fmt}")
    except Exception:
        if folder.exists():
            _cleanup(folder)
        raise


@router.post("/convert")
async def convert_audio(
    file: UploadFile = File(...),
    output_format: str = Form("mp3"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    fmt = _validate_format(output_format)
    folder = _workspace("convert")
    try:
        source = await _save_upload(file, folder)
        output = folder / f"converted.{fmt}"
        command = ["ffmpeg", "-hide_banner", "-y", "-i", str(source), "-vn", *_codec_args(fmt), str(output)]
        await asyncio.to_thread(_run_ffmpeg, command)
        return _response(output, folder, f"MAGHRABI-converted.{fmt}")
    except Exception:
        if folder.exists():
            _cleanup(folder)
        raise
