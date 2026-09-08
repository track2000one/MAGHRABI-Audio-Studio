from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import HTTPException, UploadFile

MAX_NESTED_SEQUENCES = 12
MAX_NESTED_DURATION = 900.0
MAX_NESTED_CLIPS = 120
_MAX_INTERNAL_VIDEO_FILES = 48


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clip_output_duration(clip: dict) -> float:
    if clip.get("freezeFrame"):
        return max(.02, min(12.0, _safe_float(clip.get("freezeDuration"), 2.0)))
    source = max(.02, _safe_float(clip.get("end")) - _safe_float(clip.get("start")))
    base_speed = max(.25, min(4.0, _safe_float(clip.get("speed"), 1.0)))
    preset = str(clip.get("speedRamp", "off"))
    ramps = {
        "montage": [.7, 1.8, .7],
        "hero": [.5, 1.0, 2.0],
        "bullet": [1.0, .35, 1.0],
        "flash": [2.0, .5, 2.0],
    }
    values = ramps.get(preset)
    if not values:
        return source / base_speed
    part = source / len(values)
    return sum(part / max(.25, min(4.0, speed * base_speed)) for speed in values)


def _normalize_sequences(project: dict) -> list[dict]:
    raw = project.get("compoundSequences", []) or []
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="Compound Sequences غير صالحة.")
    if len(raw) > MAX_NESTED_SEQUENCES:
        raise HTTPException(status_code=400, detail=f"الحد الأعلى {MAX_NESTED_SEQUENCES} Nested Sequences لكل Render.")

    sequences: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or item.get("enabled", True) is False:
            continue
        sequence_id = str(item.get("id") or f"compound-{index}")[:96]
        if sequence_id in seen:
            raise HTTPException(status_code=400, detail="يوجد Compound Sequence ID مكرر.")
        seen.add(sequence_id)
        start = max(0.0, min(86400.0, _safe_float(item.get("parentStartAt"), 0.0)))
        duration = max(.1, min(MAX_NESTED_DURATION, _safe_float(item.get("duration"), 5.0)))
        manifest = item.get("manifest")
        if not isinstance(manifest, dict):
            raise HTTPException(status_code=400, detail=f"Nested Manifest غير صالح للـCompound: {sequence_id}")
        clips = manifest.get("clips", [])
        if not isinstance(clips, list) or not clips:
            raise HTTPException(status_code=400, detail=f"الـCompound {sequence_id} لا يحتوي على V1 Clips.")
        if len(clips) > MAX_NESTED_CLIPS:
            raise HTTPException(status_code=400, detail=f"عدد المقاطع داخل الـCompound {sequence_id} أكبر من الحد المسموح.")
        if manifest.get("compoundSequences"):
            raise HTTPException(status_code=400, detail="Nested-in-Nested recursion غير مفعلة في هذا الإصدار؛ استخدم Compound مستقلًا داخل Parent Timeline.")
        sequences.append({
            "id": sequence_id,
            "name": str(item.get("name") or f"Compound {index + 1}")[:96],
            "parentStartAt": start,
            "duration": duration,
            "manifest": manifest,
        })

    sequences.sort(key=lambda item: float(item["parentStartAt"]))
    for previous, current in zip(sequences, sequences[1:]):
        previous_end = float(previous["parentStartAt"]) + float(previous["duration"])
        if float(current["parentStartAt"]) < previous_end - .015:
            raise HTTPException(status_code=400, detail="Nested Sequences المتداخلة على Parent Timeline غير مدعومة.")
    project["compoundSequences"] = sequences
    return sequences


def _sequence_for_time(sequences: list[dict], start: float, end: float) -> dict | None:
    for sequence in sequences:
        sequence_start = float(sequence["parentStartAt"])
        sequence_end = sequence_start + float(sequence["duration"])
        if end > sequence_start + .015 and start < sequence_end - .015:
            return sequence
    return None


def _replace_parent_main_clips(project: dict, sequences: list[dict]) -> None:
    clips = project.get("clips", [])
    if not isinstance(clips, list):
        raise HTTPException(status_code=400, detail="Parent Timeline clips غير صالحة.")

    kept: list[dict] = []
    cursor = 0.0
    removed_by_sequence: dict[str, int] = {str(item["id"]): 0 for item in sequences}
    for raw in clips:
        if not isinstance(raw, dict):
            continue
        clip = dict(raw)
        start = max(0.0, _safe_float(clip.get("timelineStartAt"), cursor))
        duration = _clip_output_duration(clip)
        end = start + duration
        sequence = _sequence_for_time(sequences, start, end)
        if sequence is None:
            kept.append(clip)
        else:
            sequence_start = float(sequence["parentStartAt"])
            sequence_end = sequence_start + float(sequence["duration"])
            if start < sequence_start - .02 or end > sequence_end + .02:
                raise HTTPException(
                    status_code=400,
                    detail="حدود Compound يجب أن تكون على حدود V1 Clips كاملة. أعد Sync Parent ليتم Snap تلقائيًا.",
                )
            removed_by_sequence[str(sequence["id"])] += 1
        cursor = max(cursor, start) + duration

    for sequence in sequences:
        sequence_id = str(sequence["id"])
        if removed_by_sequence.get(sequence_id, 0) < 1:
            raise HTTPException(status_code=400, detail=f"لم يتم العثور على Parent V1 Clips للنطاق {sequence_id}.")
        duration = float(sequence["duration"])
        kept.append({
            "fileIndex": 0,
            "start": 0.0,
            "end": duration,
            "speed": 1.0,
            "volume": 1.0,
            "filter": "none",
            "text": "",
            "textSize": 48,
            "textPosition": "bottom",
            "rotation": 0,
            "fit": "contain",
            "speedRamp": "off",
            "transformKeyframes": [],
            "audioFadeIn": 0,
            "audioFadeOut": 0,
            "audioAutomation": [],
            "timelineStartAt": float(sequence["parentStartAt"]),
            "compoundSequenceId": sequence_id,
        })

    kept.sort(key=lambda item: _safe_float(item.get("timelineStartAt"), 0.0))
    project["clips"] = kept


def _subtract_overlay_ranges(track: dict, sequences: list[dict]) -> list[dict]:
    pieces = [dict(track)]
    for sequence in sequences:
        cut_start = float(sequence["parentStartAt"])
        cut_end = cut_start + float(sequence["duration"])
        next_pieces: list[dict] = []
        for piece in pieces:
            start = max(0.0, _safe_float(piece.get("startAt"), 0.0))
            end = max(start, _safe_float(piece.get("endAt"), start))
            if end <= cut_start + .015 or start >= cut_end - .015:
                next_pieces.append(piece)
                continue
            source_start = max(0.0, _safe_float(piece.get("sourceStart"), 0.0))
            source_end = max(source_start, _safe_float(piece.get("sourceEnd"), source_start))
            timeline_duration = max(.001, end - start)
            source_duration = max(.001, source_end - source_start)
            if start < cut_start - .015:
                ratio = (cut_start - start) / timeline_duration
                left = dict(piece)
                left["endAt"] = cut_start
                left["sourceEnd"] = source_start + source_duration * ratio
                next_pieces.append(left)
            if end > cut_end + .015:
                ratio = (cut_end - start) / timeline_duration
                right = dict(piece)
                right["startAt"] = cut_end
                right["sourceStart"] = source_start + source_duration * ratio
                next_pieces.append(right)
        pieces = next_pieces
    return pieces


def _subtract_audio_ranges(track: dict, sequences: list[dict]) -> list[dict]:
    pieces = [dict(track)]
    for sequence in sequences:
        cut_start = float(sequence["parentStartAt"])
        cut_end = cut_start + float(sequence["duration"])
        next_pieces: list[dict] = []
        for piece in pieces:
            start = max(0.0, _safe_float(piece.get("startAt"), 0.0))
            source_start = max(0.0, _safe_float(piece.get("sourceStart"), 0.0))
            source_end = max(source_start, _safe_float(piece.get("sourceEnd"), source_start))
            end = start + max(.001, source_end - source_start)
            if end <= cut_start + .015 or start >= cut_end - .015:
                next_pieces.append(piece)
                continue
            if start < cut_start - .015:
                left = dict(piece)
                left["sourceEnd"] = source_start + (cut_start - start)
                next_pieces.append(left)
            if end > cut_end + .015:
                right = dict(piece)
                right["startAt"] = cut_end
                right["sourceStart"] = source_start + (cut_end - start)
                next_pieces.append(right)
        pieces = next_pieces
    return pieces


def _replace_parent_range_media(project: dict, sequences: list[dict]) -> None:
    overlays = project.get("videoOverlays", []) or []
    if isinstance(overlays, list):
        project["videoOverlays"] = [piece for track in overlays if isinstance(track, dict) for piece in _subtract_overlay_ranges(track, sequences)]
    audios = project.get("audioTracks", []) or []
    if isinstance(audios, list):
        project["audioTracks"] = [piece for track in audios if isinstance(track, dict) for piece in _subtract_audio_ranges(track, sequences)]


def _prepare_parent_for_compounds(project: dict) -> dict:
    sequences = _normalize_sequences(project)
    if not sequences:
        return project
    _replace_parent_main_clips(project, sequences)
    _replace_parent_range_media(project, sequences)
    return project


async def _rewind(items: list[UploadFile] | None) -> None:
    for item in items or []:
        await item.seek(0)


async def _run_background(response: object) -> None:
    background = getattr(response, "background", None)
    if background is not None:
        result = background()
        if isinstance(result, Awaitable):
            await result


def install_nested_sequence_engine() -> None:
    """Install true V12 Compound/Nested rendering without changing V12 API.

    Hook 1 runs before V12 timeline-gap materialization. It replaces each
    Compound range with a timing-safe placeholder while removing the original
    V1/PIP/audio media from that Parent range.

    Hook 2 runs immediately before V11. It renders every child manifest to a
    high-quality intermediate, swaps the placeholder to that generated media,
    then delegates to the normal Parent render. The Parent LUT/grade/text pass
    therefore happens exactly once after the Nested sequence is flattened.
    """
    from . import video_tools_v9, video_tools_v12

    base_materialize: Callable = video_tools_v12._materialize_timeline_gaps
    base_render: Callable = video_tools_v12.render_video_v11

    # V12 already accepts more source assets than the historical V2/V9 guard.
    # Reserve headroom for V12-generated gap and Nested intermediates while the
    # public upload endpoints remain constrained by their own request contracts.
    video_tools_v9.MAX_VIDEO_FILES = max(int(video_tools_v9.MAX_VIDEO_FILES), _MAX_INTERNAL_VIDEO_FILES)

    def materialize_with_nested_placeholders(folder: Path, manifest_text: str, original_video_count: int):
        try:
            project = json.loads(manifest_text)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Nested Parent Manifest غير صالح.") from exc
        if project.get("compoundSequences"):
            project = _prepare_parent_for_compounds(project)
            manifest_text = json.dumps(project, ensure_ascii=False)
        return base_materialize(folder, manifest_text, original_video_count)

    async def render_with_nested_sequences(
        video_files: list[UploadFile],
        audio_files: list[UploadFile] | None = None,
        image_files: list[UploadFile] | None = None,
        lut_file: UploadFile | None = None,
        manifest: str = "{}",
        output_size: str = "720p",
        quality: str = "standard",
        _username: str = "v12-nested-worker",
    ):
        try:
            project = json.loads(manifest)
        except json.JSONDecodeError:
            return await base_render(
                video_files=video_files, audio_files=audio_files, image_files=image_files,
                lut_file=lut_file, manifest=manifest, output_size=output_size,
                quality=quality, _username=_username,
            )

        sequences = _normalize_sequences(project)
        placeholders = [clip for clip in project.get("clips", []) if isinstance(clip, dict) and clip.get("compoundSequenceId")]
        if not sequences or not placeholders:
            project.pop("compoundSequences", None)
            return await base_render(
                video_files=video_files, audio_files=audio_files, image_files=image_files,
                lut_file=lut_file, manifest=json.dumps(project, ensure_ascii=False), output_size=output_size,
                quality=quality, _username=_username,
            )

        sequence_map = {str(item["id"]): item for item in sequences}
        temp_root = Path(tempfile.mkdtemp(prefix="maghrabi-nested-"))
        generated_uploads: list[UploadFile] = []
        generated_handles: list[object] = []
        generated_index: dict[str, int] = {}
        try:
            for sequence_id in dict.fromkeys(str(clip.get("compoundSequenceId")) for clip in placeholders):
                sequence = sequence_map.get(sequence_id)
                if sequence is None:
                    raise HTTPException(status_code=400, detail=f"Compound placeholder بلا Sequence: {sequence_id}")

                child_folder = temp_root / f"child-{len(generated_uploads):02d}"
                child_folder.mkdir(parents=True, exist_ok=True)
                child_manifest = dict(sequence["manifest"])
                child_manifest.pop("compoundSequences", None)
                child_manifest_text = json.dumps(child_manifest, ensure_ascii=False)
                child_manifest_text, child_gap_paths = await asyncio.to_thread(
                    base_materialize,
                    child_folder,
                    child_manifest_text,
                    len(video_files),
                )

                gap_uploads: list[UploadFile] = []
                gap_handles: list[object] = []
                try:
                    for rel in child_gap_paths:
                        handle = (child_folder / rel).open("rb")
                        gap_handles.append(handle)
                        gap_uploads.append(UploadFile(file=handle, filename=Path(rel).name))

                    await _rewind(video_files)
                    await _rewind(audio_files)
                    await _rewind(image_files)
                    await _rewind(gap_uploads)
                    child_response = await base_render(
                        video_files=[*video_files, *gap_uploads],
                        audio_files=audio_files,
                        image_files=image_files,
                        lut_file=None,
                        manifest=child_manifest_text,
                        output_size=output_size,
                        quality="standard" if quality == "draft" else "high",
                        _username=f"nested:{sequence_id}",
                    )
                    child_source = Path(str(child_response.path))
                    generated_path = temp_root / f"compound-{len(generated_uploads):02d}.mp4"
                    shutil.copy2(child_source, generated_path)
                    await _run_background(child_response)
                finally:
                    for handle in gap_handles:
                        try:
                            handle.close()
                        except Exception:
                            pass
                    shutil.rmtree(child_folder, ignore_errors=True)

                handle = generated_path.open("rb")
                generated_handles.append(handle)
                generated_index[sequence_id] = len(video_files) + len(generated_uploads)
                generated_uploads.append(UploadFile(file=handle, filename=generated_path.name))

            for clip in project.get("clips", []):
                if not isinstance(clip, dict) or not clip.get("compoundSequenceId"):
                    continue
                sequence_id = str(clip.pop("compoundSequenceId"))
                sequence = sequence_map[sequence_id]
                clip.update(
                    fileIndex=generated_index[sequence_id],
                    start=0.0,
                    end=float(sequence["duration"]),
                    speed=1.0,
                    volume=1.0,
                    filter="none",
                    reverse=False,
                    freezeFrame=False,
                    privacyEffect="none",
                    transformKeyframes=[],
                )

            project.pop("compoundSequences", None)
            await _rewind(video_files)
            await _rewind(audio_files)
            await _rewind(image_files)
            await _rewind(generated_uploads)
            return await base_render(
                video_files=[*video_files, *generated_uploads],
                audio_files=audio_files,
                image_files=image_files,
                lut_file=lut_file,
                manifest=json.dumps(project, ensure_ascii=False),
                output_size=output_size,
                quality=quality,
                _username=_username,
            )
        finally:
            for handle in generated_handles:
                try:
                    handle.close()
                except Exception:
                    pass
            shutil.rmtree(temp_root, ignore_errors=True)

    video_tools_v12._materialize_timeline_gaps = materialize_with_nested_placeholders
    video_tools_v12.render_video_v11 = render_with_nested_sequences
