from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .main import require_auth
from .video_tools import _cleanup, _run_ffmpeg, _workspace
from .video_tools_v2 import _save_media
from .video_tools_v10 import render_video_v10

router = APIRouter(prefix="/api/video/v11", tags=["video-studio-v11"])


@router.post("/render")
async def render_video_v11(
    video_files: list[UploadFile] = File(...),
    audio_files: list[UploadFile] | None = File(None),
    image_files: list[UploadFile] | None = File(None),
    lut_file: UploadFile | None = File(None),
    manifest: str = Form(...),
    output_size: Literal["720p", "1080p", "portrait", "square"] = Form("720p"),
    quality: Literal["draft", "standard", "high"] = Form("standard"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    """Creator V11 flattens V1/V2/V3 lanes, linked audio, source edits,
    multicam live cuts and adjustment layers in the browser, then renders with
    the proven Creator V10/V9 FFmpeg engine.
    """
    response = await render_video_v10(
        video_files=video_files,
        audio_files=audio_files,
        image_files=image_files,
        lut_file=lut_file,
        manifest=manifest,
        output_size=output_size,
        quality=quality,
        _username=_username,
    )
    response.headers["X-MAGHRABI-Engine"] = "Creator-V11"
    response.headers["Content-Disposition"] = 'attachment; filename="MAGHRABI-video-v11.mp4"'
    return response


@router.post("/extract-audio")
async def extract_audio_from_video(
    file: UploadFile = File(...),
    _username: str = Depends(require_auth),
) -> FileResponse:
    """Detach a video's audio into an edit-friendly 48 kHz stereo WAV."""
    folder = _workspace()
    try:
        source = await _save_media(file, folder, 0, "video")
        output = folder / "MAGHRABI-detached-audio.wav"
        await asyncio.to_thread(
            _run_ffmpeg,
            [
                "ffmpeg", "-hide_banner", "-y", "-i", str(source), "-vn",
                "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(output),
            ],
        )
        return FileResponse(
            output,
            media_type="audio/wav",
            filename="MAGHRABI-detached-audio.wav",
            background=BackgroundTask(_cleanup, folder),
        )
    except Exception:
        _cleanup(folder)
        raise
