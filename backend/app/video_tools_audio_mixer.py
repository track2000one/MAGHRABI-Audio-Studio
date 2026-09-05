from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .video_tools import _cleanup, _run_ffmpeg, _workspace

RenderFn = Callable[..., Awaitable[FileResponse]]


def _clip(value: object, minimum: float, maximum: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(number):
        return fallback
    return max(minimum, min(maximum, number))


def _bool(value: object, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return fallback


def _master_settings(project: dict) -> dict:
    return {
        "gain": _clip(project.get("audioMasterGain", 1.0), 0.0, 2.0, 1.0),
        "limiter": _bool(project.get("audioLimiterEnabled", True), True),
        "ceiling_db": _clip(project.get("audioLimiterCeilingDb", -1.0), -12.0, -0.1, -1.0),
        "normalize": _bool(project.get("audioNormalizeEnabled", False), False),
        "target_lufs": _clip(project.get("audioTargetLufs", -14.0), -24.0, -9.0, -14.0),
    }


async def _copy_upload(upload: UploadFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        await upload.seek(0)
    except Exception:
        try:
            upload.file.seek(0)
        except Exception:
            pass
    with destination.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    try:
        await upload.seek(0)
    except Exception:
        try:
            upload.file.seek(0)
        except Exception:
            pass


def _safe_suffix(upload: UploadFile, fallback: str = ".wav") -> str:
    suffix = Path(upload.filename or "").suffix.lower()
    if not suffix or len(suffix) > 10:
        return fallback
    return suffix


def _as_upload(path: Path, handles: list) -> UploadFile:
    handle = path.open("rb")
    handles.append(handle)
    return UploadFile(file=handle, filename=path.name)


def _pan_filter(pan: float) -> str:
    value = _clip(pan, -1.0, 1.0, 0.0)
    return f"aformat=channel_layouts=stereo,stereotools=balance_out={value:.6f},aresample=48000"


def _needs_master_processing(settings: dict) -> bool:
    return (
        abs(float(settings["gain"]) - 1.0) > .0005
        or bool(settings["normalize"])
        or bool(settings["limiter"])
    )


def _master_filter(settings: dict) -> str:
    chain: list[str] = []
    gain = float(settings["gain"])
    if abs(gain - 1.0) > .0005:
        chain.append(f"volume={gain:.6f}")
    ceiling_db = float(settings["ceiling_db"])
    if settings["normalize"]:
        chain.append(
            f"loudnorm=I={float(settings['target_lufs']):.2f}:TP={ceiling_db:.2f}:LRA=11"
        )
    if settings["limiter"]:
        ceiling_linear = max(.05, min(.999, 10 ** (ceiling_db / 20.0)))
        chain.append(f"alimiter=limit={ceiling_linear:.6f}")
    chain.append("aresample=48000")
    return ",".join(chain)


async def render_with_audio_mixer(
    render_fn: RenderFn,
    *,
    video_files: list[UploadFile],
    audio_files: list[UploadFile] | None,
    image_files: list[UploadFile] | None,
    lut_file: UploadFile | None,
    manifest: str,
    output_size: str,
    quality: str,
    username: str,
) -> FileResponse:
    """Apply MAGHRABI mixer semantics before the proven V9 render engine.

    Channel gain/mute/solo are folded into the audio-track manifest. Per-track
    pan is materialized into a dedicated 48 kHz stereo source, allowing tracks
    that reference the same original file to use different pan positions.
    Master gain, EBU R128 loudness normalization and true-peak ceiling limiting
    are applied after the timeline render so they affect video, music and PIP
    audio together.
    """
    try:
        project = json.loads(manifest)
    except Exception:
        return await render_fn(
            video_files=video_files,
            audio_files=audio_files,
            image_files=image_files,
            lut_file=lut_file,
            manifest=manifest,
            output_size=output_size,
            quality=quality,
            _username=username,
        )

    if not isinstance(project, dict):
        return await render_fn(
            video_files=video_files,
            audio_files=audio_files,
            image_files=image_files,
            lut_file=lut_file,
            manifest=manifest,
            output_size=output_size,
            quality=quality,
            _username=username,
        )

    source_audio = list(audio_files or [])
    tracks = project.get("audioTracks", [])
    if not isinstance(tracks, list):
        tracks = []
        project["audioTracks"] = tracks

    workspace = _workspace()
    handles: list = []
    base_audio_paths: list[Path] = []
    response: FileResponse | None = None
    master = _master_settings(project)

    try:
        for index, upload in enumerate(source_audio):
            path = workspace / f"audio-source-{index:03d}{_safe_suffix(upload)}"
            await _copy_upload(upload, path)
            base_audio_paths.append(path)

        prepared_paths = list(base_audio_paths)
        solo_active = any(isinstance(track, dict) and _bool(track.get("solo"), False) for track in tracks)

        for index, track in enumerate(tracks):
            if not isinstance(track, dict):
                continue
            try:
                file_index = int(track.get("fileIndex", -1))
            except (TypeError, ValueError):
                continue
            if not 0 <= file_index < len(base_audio_paths):
                continue

            gain = _clip(track.get("mixerGain", 1.0), 0.0, 2.0, 1.0)
            base_volume = _clip(track.get("volume", .65), 0.0, 2.0, .65)
            muted = _bool(track.get("muted"), False)
            solo = _bool(track.get("solo"), False)
            if muted or (solo_active and not solo):
                track["volume"] = 0.0
            else:
                track["volume"] = max(0.0, min(2.0, base_volume * gain))

            pan = _clip(track.get("pan", 0.0), -1.0, 1.0, 0.0)
            if abs(pan) <= .0005 or float(track.get("volume", 0.0)) <= .00001:
                continue

            panned = workspace / f"audio-pan-{index:03d}.wav"
            _run_ffmpeg([
                "ffmpeg", "-hide_banner", "-y", "-i", str(base_audio_paths[file_index]),
                "-vn", "-af", _pan_filter(pan), "-ac", "2", "-ar", "48000",
                "-c:a", "pcm_s16le", str(panned),
            ])
            prepared_paths.append(panned)
            track["fileIndex"] = len(prepared_paths) - 1

        prepared_uploads = [_as_upload(path, handles) for path in prepared_paths]
        response = await render_fn(
            video_files=video_files,
            audio_files=prepared_uploads,
            image_files=image_files,
            lut_file=lut_file,
            manifest=json.dumps(project, ensure_ascii=False),
            output_size=output_size,
            quality=quality,
            _username=username,
        )

        if not _needs_master_processing(master):
            _cleanup(workspace)
            return response

        source = Path(str(response.path))
        final_output = workspace / "MAGHRABI-master-mix.mp4"
        _run_ffmpeg([
            "ffmpeg", "-hide_banner", "-y", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
            "-af", _master_filter(master), "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(final_output),
        ])

        if response.background is not None:
            await response.background()
            response.background = None
        return FileResponse(
            final_output,
            media_type="video/mp4",
            filename="MAGHRABI-master-mix.mp4",
            background=BackgroundTask(_cleanup, workspace),
        )
    except Exception:
        if response is not None and response.background is not None:
            try:
                await response.background()
            except Exception:
                pass
        _cleanup(workspace)
        raise
    finally:
        for handle in handles:
            try:
                handle.close()
            except Exception:
                pass
