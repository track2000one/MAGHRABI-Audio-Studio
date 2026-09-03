from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from . import video_tools_v19 as base
from .main import require_auth
from .video_tools import _cleanup, _has_audio, _probe, _run_ffmpeg, _save_upload, _workspace

router = base.router


def _render_highlight_reel(source: Path, output: Path, threshold: float, max_duration: float) -> dict:
    analysis = base._production_analysis(source, threshold)
    candidates = list(analysis.get("highlights") or [])
    if not candidates:
        raise HTTPException(status_code=400, detail="لم يتم العثور على Highlights مناسبة.")

    max_duration = max(5.0, min(120.0, max_duration))
    chosen: list[dict] = []
    used = 0.0
    for item in candidates:
        available = max(0.25, float(item["end"]) - float(item["start"]))
        if used >= max_duration:
            break
        take = min(available, max_duration - used)
        if take < .25:
            continue
        chosen.append({**item, "end": float(item["start"]) + take, "duration": take})
        used += take
    chosen.sort(key=lambda item: float(item["start"]))
    if not chosen:
        raise HTTPException(status_code=400, detail="لا توجد مدة كافية لإنشاء Highlight Reel.")

    probe = _probe(source)
    has_audio = _has_audio(probe)
    graph: list[str] = []
    concat_inputs: list[str] = []
    for index, item in enumerate(chosen):
        start = float(item["start"])
        end = float(item["end"])
        graph.append(f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[v{index}]")
        concat_inputs.append(f"[v{index}]")
        if has_audio:
            graph.append(f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a{index}]")
            concat_inputs.append(f"[a{index}]")

    if has_audio:
        graph.append("".join(concat_inputs) + f"concat=n={len(chosen)}:v=1:a=1[vout][aout]")
        command = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(source),
            "-filter_complex", ";".join(graph), "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(output),
        ]
    else:
        graph.append("".join(concat_inputs) + f"concat=n={len(chosen)}:v=1:a=0[vout]")
        command = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(source),
            "-filter_complex", ";".join(graph), "-map", "[vout]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-an", "-movflags", "+faststart", str(output),
        ]
    _run_ffmpeg(command)
    return {"duration": used, "segments": chosen, "sourceSceneCount": analysis.get("sceneCount", 0)}


@router.post("/highlight-reel")
async def highlight_reel_v19(
    file: UploadFile = File(...),
    threshold: float = Form(.35),
    max_duration: float = Form(30),
    _username: str = Depends(require_auth),
) -> FileResponse:
    folder = _workspace()
    try:
        source = await _save_upload(file, folder, 0)
        output = folder / "MAGHRABI-v19-highlight-reel.mp4"
        meta = await asyncio.to_thread(
            _render_highlight_reel,
            source,
            output,
            max(.08, min(.85, threshold)),
            max_duration,
        )
        return FileResponse(
            output,
            media_type="video/mp4",
            filename=output.name,
            background=BackgroundTask(_cleanup, folder),
            headers={
                "X-MAGHRABI-Engine": "Creator-V19-HighlightReel",
                "X-MAGHRABI-Highlight-Duration": f"{meta['duration']:.3f}",
                "X-MAGHRABI-Highlight-Segments": str(len(meta["segments"])),
            },
        )
    except Exception:
        _cleanup(folder)
        raise
