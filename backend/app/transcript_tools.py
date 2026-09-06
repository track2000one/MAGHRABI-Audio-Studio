from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from .main import DATA_DIR, MAX_UPLOAD_MB, require_auth
from .transcript_core import normalize_transcription_result

router = APIRouter(prefix="/api/transcript", tags=["transcript-intelligence"])
TRANSCRIPT_DIR = DATA_DIR / "transcripts"
TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".webm", ".mp4", ".mpeg", ".mpga"}
MAX_SOURCE_SECONDS = 8 * 60 * 60
UPSTREAM_TIMEOUT_SECONDS = 240


def _api_key() -> str:
    return (os.getenv("TRANSCRIPTION_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()


def _api_base() -> str:
    value = (os.getenv("TRANSCRIPTION_API_BASE") or "https://api.openai.com/v1").strip()
    return value.rstrip("/")


def _word_model() -> str:
    return (os.getenv("TRANSCRIPTION_WORD_MODEL") or "whisper-1").strip()


def _diarize_model() -> str:
    return (os.getenv("TRANSCRIPTION_DIARIZE_MODEL") or "gpt-4o-transcribe-diarize").strip()


def _workspace() -> Path:
    return Path(tempfile.mkdtemp(prefix="transcript-", dir=TRANSCRIPT_DIR))


def _cleanup(folder: Path) -> None:
    shutil.rmtree(folder, ignore_errors=True)


def _run(command: list[str]) -> None:
    process = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        tail = "\n".join(process.stdout.splitlines()[-16:])
        print(f"[transcript] media preparation failed: {tail}", flush=True)
        raise RuntimeError("تعذر تجهيز المقطع الصوتي للتحويل إلى نص.")


async def _save_upload(upload: UploadFile, folder: Path) -> Path:
    original = Path(upload.filename or "audio").name
    suffix = Path(original).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="صيغة الملف غير مدعومة للتحويل إلى نص.")
    target = folder / f"source{suffix}"
    size = 0
    with target.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"الحد الأعلى لحجم الملف هو {MAX_UPLOAD_MB} MB.")
            handle.write(chunk)
    await upload.close()
    return target


def _prepare_segment(source: Path, output: Path, source_start: float, source_end: float | None) -> None:
    command = [
        "ffmpeg", "-hide_banner", "-y",
        "-ss", f"{source_start:.6f}",
        "-i", str(source),
    ]
    if source_end is not None:
        command.extend(["-t", f"{max(.02, source_end - source_start):.6f}"])
    command.extend([
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
    ])
    _run(command)


def _multipart(fields: list[tuple[str, str]], file_path: Path) -> tuple[bytes, str]:
    boundary = f"----MAGHRABITranscript{uuid.uuid4().hex}"
    pieces: list[bytes] = []
    for name, value in fields:
        pieces.append(f"--{boundary}\r\n".encode())
        pieces.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        pieces.append(value.encode("utf-8"))
        pieces.append(b"\r\n")
    mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    pieces.append(f"--{boundary}\r\n".encode())
    pieces.append(f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'.encode())
    pieces.append(f"Content-Type: {mime}\r\n\r\n".encode())
    pieces.append(file_path.read_bytes())
    pieces.append(b"\r\n")
    pieces.append(f"--{boundary}--\r\n".encode())
    return b"".join(pieces), boundary


def _upstream_transcription(fields: list[tuple[str, str]], file_path: Path) -> dict:
    key = _api_key()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="خدمة التحويل إلى نص غير مفعلة. أضف OPENAI_API_KEY أو TRANSCRIPTION_API_KEY في إعدادات الخادم.",
        )
    body, boundary = _multipart(fields, file_path)
    req = urlrequest.Request(
        f"{_api_base()}/audio/transcriptions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
            "User-Agent": "MAGHRABI-Audio-Studio/Transcript-Pro",
        },
    )
    try:
        with urlrequest.urlopen(req, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:700]
        except Exception:
            pass
        print(f"[transcript] upstream HTTP {exc.code}: {detail}", flush=True)
        raise HTTPException(status_code=502, detail="تعذر إكمال التحويل إلى نص لدى مزود الذكاء الصوتي.") from exc
    except (urlerror.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="تعذر الاتصال بخدمة التحويل إلى نص.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="استجابة خدمة التحويل إلى نص غير صالحة.")
    return payload


@router.get("/status")
async def transcript_status(_username: str = Depends(require_auth)) -> dict:
    return {
        "configured": bool(_api_key()),
        "provider": "openai-compatible",
        "wordModel": _word_model(),
        "diarizeModel": _diarize_model(),
        "supportsWordTimestamps": True,
        "supportsSpeakerLabels": True,
    }


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    source_start: float = Form(0),
    source_end: float | None = Form(None),
    language: str = Form(""),
    prompt: str = Form(""),
    diarize: bool = Form(False),
    _username: str = Depends(require_auth),
) -> dict:
    source_start = max(0.0, min(MAX_SOURCE_SECONDS, float(source_start)))
    if source_end is not None:
        source_end = max(source_start + .02, min(MAX_SOURCE_SECONDS, float(source_end)))
    language = language.strip().lower()[:12]
    prompt = prompt.strip()[:600]

    folder = _workspace()
    try:
        source = await _save_upload(file, folder)
        prepared = folder / "transcript-source.wav"
        await asyncio.to_thread(_prepare_segment, source, prepared, source_start, source_end)

        word_fields: list[tuple[str, str]] = [
            ("model", _word_model()),
            ("response_format", "verbose_json"),
            ("timestamp_granularities[]", "word"),
            ("timestamp_granularities[]", "segment"),
            ("temperature", "0"),
        ]
        if language and language not in {"auto", "detect"}:
            word_fields.append(("language", language))
        if prompt:
            word_fields.append(("prompt", prompt))

        primary = await asyncio.to_thread(_upstream_transcription, word_fields, prepared)
        diarized: dict | None = None
        if diarize:
            diarize_fields: list[tuple[str, str]] = [
                ("model", _diarize_model()),
                ("response_format", "diarized_json"),
                ("chunking_strategy", "auto"),
            ]
            if language and language not in {"auto", "detect"}:
                diarize_fields.append(("language", language))
            diarized = await asyncio.to_thread(_upstream_transcription, diarize_fields, prepared)

        normalized = normalize_transcription_result(primary, diarized)
        normalized.update({
            "provider": "openai-compatible",
            "wordModel": _word_model(),
            "diarizeModel": _diarize_model() if diarize else None,
            "diarized": bool(diarize),
            "sourceStart": source_start,
            "sourceEnd": source_end,
        })
        return normalized
    finally:
        _cleanup(folder)
