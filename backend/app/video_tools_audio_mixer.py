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


def _dialogue_settings(track: dict) -> dict:
    anchor = str(track.get("dialogueRoomToneAnchor", "tail")).strip().lower()
    return {
        "enabled": _bool(track.get("dialogueCleanupEnabled", False), False),
        "tempo": _clip(track.get("dialogueTempo", 1.0), .90, 1.10, 1.0),
        "noise_reduction_db": _clip(track.get("dialogueNoiseReductionDb", 0.0), 0.0, 24.0, 0.0),
        "highpass_hz": _clip(track.get("dialogueHighPassHz", 70.0), 40.0, 180.0, 70.0),
        "deess": _clip(track.get("dialogueDeEss", 0.0), 0.0, 1.0, 0.0),
        "compressor": _bool(track.get("dialogueCompressorEnabled", False), False),
        "compressor_threshold_db": _clip(track.get("dialogueCompressorThresholdDb", -18.0), -36.0, -6.0, -18.0),
        "compressor_ratio": _clip(track.get("dialogueCompressorRatio", 3.0), 1.0, 8.0, 3.0),
        "loudness_match": _bool(track.get("dialogueLoudnessMatchEnabled", False), False),
        "target_lufs": _clip(track.get("dialogueTargetLufs", -18.0), -24.0, -14.0, -18.0),
        "room_tone_db": _clip(track.get("dialogueRoomToneDb", -60.0), -60.0, -24.0, -60.0),
        "room_tone_anchor": anchor if anchor in {"head", "tail"} else "tail",
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


def _dialogue_core_filter(settings: dict) -> list[str]:
    chain: list[str] = ["aresample=48000"]
    tempo = float(settings["tempo"])
    if abs(tempo - 1.0) > .0005:
        chain.append(f"atempo={tempo:.6f}")
    if settings["enabled"]:
        highpass = float(settings["highpass_hz"])
        if highpass > 40.5:
            chain.append(f"highpass=f={highpass:.2f}:p=2")
        reduction = float(settings["noise_reduction_db"])
        if reduction > .05:
            chain.append(f"afftdn=nr={reduction:.2f}:nf=-45")
        deess = float(settings["deess"])
        if deess > .01:
            chain.append(f"deesser=i={deess:.4f}:m=0.55:f=0.5:s=o")
        if settings["compressor"]:
            threshold = 10 ** (float(settings["compressor_threshold_db"]) / 20.0)
            ratio = float(settings["compressor_ratio"])
            chain.append(
                f"acompressor=threshold={threshold:.7f}:ratio={ratio:.3f}:attack=6:release=90:makeup=1.35"
            )
        if settings["loudness_match"]:
            chain.append(
                f"loudnorm=I={float(settings['target_lufs']):.2f}:TP=-2.0:LRA=7"
            )
    return chain


def _needs_dialogue_variant(settings: dict, pan: float) -> bool:
    return (
        bool(settings["enabled"])
        or abs(float(settings["tempo"]) - 1.0) > .0005
        or float(settings["room_tone_db"]) > -59.5
        or abs(pan) > .0005
    )


def _render_track_variant(
    source: Path,
    output: Path,
    *,
    source_start: float,
    source_duration: float,
    pan: float,
    dialogue: dict,
) -> None:
    duration = max(.02, source_duration)
    core = ",".join(_dialogue_core_filter(dialogue))
    finish = [f"apad=pad_dur={duration:.6f}", f"atrim=duration={duration:.6f}", "asetpts=N/SR/TB"]
    if abs(pan) > .0005:
        finish.append(_pan_filter(pan))
    else:
        finish.extend(["aformat=channel_layouts=stereo", "aresample=48000"])

    command = [
        "ffmpeg", "-hide_banner", "-y",
        "-ss", f"{max(0.0, source_start):.6f}",
        "-t", f"{duration:.6f}",
        "-i", str(source),
    ]

    room_db = float(dialogue["room_tone_db"])
    if room_db <= -59.5:
        chain = ",".join([core, *finish])
        command.extend([
            "-vn", "-af", chain,
            "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(output),
        ])
        _run_ffmpeg(command)
        return

    sample = min(.22, max(.04, duration / 3.0))
    if dialogue["room_tone_anchor"] == "head":
        room_start = 0.0
        room_end = sample
    else:
        room_end = duration
        room_start = max(0.0, duration - sample)
    room_gain = 10 ** (room_db / 20.0)
    loop_size = max(1, int(round(sample * 48000)))
    output_chain = ",".join(finish)
    filter_complex = (
        f"[0:a]asplit=2[cleanin][roomin];"
        f"[cleanin]{core}[clean];"
        f"[roomin]aresample=48000,atrim=start={room_start:.6f}:end={room_end:.6f},"
        f"asetpts=N/SR/TB,aloop=loop=-1:size={loop_size},atrim=duration={duration:.6f},"
        f"volume={room_gain:.8f}[room];"
        f"[clean][room]amix=inputs=2:duration=longest:normalize=0,{output_chain}[out]"
    )
    command.extend([
        "-filter_complex", filter_complex,
        "-map", "[out]", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(output),
    ])
    _run_ffmpeg(command)


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
    """Apply MAGHRABI mixer and dialogue semantics before the proven V9 renderer.

    Channel gain/mute/solo are folded into the track manifest. Per-track pan,
    ADR timing-fit and dialogue cleanup are materialized into dedicated 48 kHz
    stereo sources, so tracks sharing one original file can still use different
    cleanup/alignment choices. Optional room-tone blending loops a short head or
    tail sample underneath the processed take. Master gain, EBU R128 loudness
    normalization and true-peak ceiling limiting remain post-timeline stages.
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

            if float(track.get("volume", 0.0)) <= .00001:
                continue

            pan = _clip(track.get("pan", 0.0), -1.0, 1.0, 0.0)
            dialogue = _dialogue_settings(track)
            if not _needs_dialogue_variant(dialogue, pan):
                continue

            source_start = _clip(track.get("sourceStart", 0.0), 0.0, 60.0 * 60.0 * 8.0, 0.0)
            source_end = _clip(track.get("sourceEnd", source_start + .02), source_start + .02, 60.0 * 60.0 * 8.0, source_start + .02)
            source_duration = max(.02, source_end - source_start)
            variant = workspace / f"audio-dialogue-{index:03d}.wav"
            _render_track_variant(
                base_audio_paths[file_index],
                variant,
                source_start=source_start,
                source_duration=source_duration,
                pan=pan,
                dialogue=dialogue,
            )
            prepared_paths.append(variant)
            track["fileIndex"] = len(prepared_paths) - 1
            track["sourceStart"] = 0.0
            track["sourceEnd"] = source_duration
            track["dialogueRendered"] = True

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
