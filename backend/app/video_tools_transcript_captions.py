from __future__ import annotations

import json
from typing import Any

from . import video_tools_v10

_INSTALLED = False
_ORIGINAL_MIXER = video_tools_v10.render_with_audio_mixer


def _number(value: object, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in {float("inf"), float("-inf")}:
        return fallback
    return number


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


def _hex(value: object, fallback: str = "#ffffff") -> str:
    text = str(value or "").strip()
    if len(text) == 7 and text.startswith("#"):
        try:
            int(text[1:], 16)
            return text.lower()
        except ValueError:
            pass
    return fallback


def _word_time(word: dict, key: str) -> float:
    timeline_key = "timelineStart" if key == "start" else "timelineEnd"
    if timeline_key in word:
        return max(0.0, _number(word.get(timeline_key), 0.0))
    return max(0.0, _number(word.get(key), 0.0))


def _normalized_words(document: dict) -> list[dict]:
    raw = document.get("words")
    if not isinstance(raw, list):
        return []
    output: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or item.get("word") or "").strip()
        if not text or _bool(item.get("deleted"), False):
            continue
        start = _word_time(item, "start")
        end = max(start + .01, _word_time(item, "end"))
        output.append({
            "text": text,
            "start": start,
            "end": end,
            "speaker": str(item.get("speaker") or "").strip() or None,
        })
    return sorted(output, key=lambda item: (item["start"], item["end"]))


def _caption_groups(words: list[dict], document: dict) -> list[dict]:
    max_words = max(2, min(12, int(_number(document.get("captionMaxWords"), 7))))
    max_duration = max(1.0, min(6.0, _number(document.get("captionMaxDuration"), 3.2)))
    max_gap = max(.1, min(1.5, _number(document.get("captionBreakGap"), .65)))
    show_speakers = _bool(document.get("captionSpeakerLabels"), False)
    groups: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        speaker = current[0].get("speaker")
        text = " ".join(str(item["text"]) for item in current).strip()
        if show_speakers and speaker:
            text = f"{speaker}: {text}"
        groups.append({
            "text": text,
            "startAt": current[0]["start"],
            "endAt": max(current[-1]["end"], current[0]["start"] + .12),
        })
        current = []

    for word in words:
        if current:
            gap = word["start"] - current[-1]["end"]
            duration = word["end"] - current[0]["start"]
            speaker_changed = bool(word.get("speaker") and current[0].get("speaker") and word.get("speaker") != current[0].get("speaker"))
            if gap > max_gap or duration > max_duration or len(current) >= max_words or speaker_changed:
                flush()
        current.append(word)
        if str(word["text"]).rstrip().endswith((".", "!", "?", "؟", "؛", ":")):
            flush()
    flush()
    return groups


def inject_transcript_subtitles(project: dict[str, Any]) -> dict[str, Any]:
    tracks = project.get("audioTracks")
    if not isinstance(tracks, list):
        return project

    existing = project.get("subtitleTracks")
    subtitle_tracks = list(existing) if isinstance(existing, list) else []
    seen_documents: set[str] = set()

    for track in tracks:
        if not isinstance(track, dict):
            continue
        document = track.get("dialogueTranscript")
        if not isinstance(document, dict) or not _bool(document.get("captionsEnabled"), False):
            continue
        document_id = str(document.get("id") or "").strip()
        if document_id and document_id in seen_documents:
            continue
        if document_id:
            seen_documents.add(document_id)

        words = _normalized_words(document)
        if not words:
            continue
        size = max(18, min(84, int(_number(document.get("captionSize"), 38))))
        position = str(document.get("captionPosition") or "bottom").strip().lower()
        if position not in {"top", "center", "bottom"}:
            position = "bottom"
        color = _hex(document.get("captionColor"), "#ffffff")
        opacity = max(0.0, min(1.0, _number(document.get("captionBoxOpacity"), .48)))

        for group in _caption_groups(words, document):
            subtitle_tracks.append({
                "text": group["text"][:700],
                "startAt": round(group["startAt"], 4),
                "endAt": round(group["endAt"], 4),
                "size": size,
                "position": position,
                "color": color,
                "boxOpacity": opacity,
                "source": "dialogue-transcript",
                "transcriptId": document_id or None,
            })

    project["subtitleTracks"] = subtitle_tracks
    return project


async def _captioned_mixer(render_fn, **kwargs):
    manifest = kwargs.get("manifest")
    if isinstance(manifest, str):
        try:
            project = json.loads(manifest)
            if isinstance(project, dict):
                kwargs["manifest"] = json.dumps(inject_transcript_subtitles(project), ensure_ascii=False)
        except Exception:
            pass
    return await _ORIGINAL_MIXER(render_fn, **kwargs)


def install_transcript_caption_engine() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    video_tools_v10.render_with_audio_mixer = _captioned_mixer
    _INSTALLED = True
