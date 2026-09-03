from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse

from .main import require_auth
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
