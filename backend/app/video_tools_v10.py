from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse

from .main import require_auth
from .video_tools_v9 import render_video_v9

router = APIRouter(prefix="/api/video/v10", tags=["video-studio-v10"])


@router.post("/render")
async def render_video_v10(
    video_files: list[UploadFile] = File(...),
    audio_files: list[UploadFile] | None = File(None),
    image_files: list[UploadFile] | None = File(None),
    lut_file: UploadFile | None = File(None),
    manifest: str = Form(...),
    output_size: Literal["720p", "1080p", "portrait", "square"] = Form("720p"),
    quality: Literal["draft", "standard", "high"] = Form("standard"),
    _username: str = Depends(require_auth),
) -> FileResponse:
    """Creator V10 flattens nested sequences, multicam cuts, adjustment layers,
    and mixer buses into the proven V9 timeline manifest before render.
    """
    response = await render_video_v9(
        video_files=video_files,
        audio_files=audio_files,
        image_files=image_files,
        lut_file=lut_file,
        manifest=manifest,
        output_size=output_size,
        quality=quality,
        _username=_username,
    )
    response.headers["X-MAGHRABI-Engine"] = "Creator-V10"
    response.headers["Content-Disposition"] = 'attachment; filename="MAGHRABI-video-v10.mp4"'
    return response
