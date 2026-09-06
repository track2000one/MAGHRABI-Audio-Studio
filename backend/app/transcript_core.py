from __future__ import annotations

from typing import Any


def _safe_time(value: object, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in {float("inf"), float("-inf")}:
        return fallback
    return max(0.0, number)


def _speaker_for_interval(start: float, end: float, segments: list[dict]) -> str | None:
    midpoint = (start + end) / 2.0
    best: tuple[float, str] | None = None
    for segment in segments:
        speaker = str(segment.get("speaker") or "").strip()
        if not speaker:
            continue
        seg_start = _safe_time(segment.get("start"))
        seg_end = max(seg_start, _safe_time(segment.get("end"), seg_start))
        if seg_start <= midpoint <= seg_end:
            return speaker
        distance = min(abs(midpoint - seg_start), abs(midpoint - seg_end))
        if best is None or distance < best[0]:
            best = (distance, speaker)
    return best[1] if best and best[0] <= 1.25 else None


def _fallback_words(segments: list[dict]) -> list[dict]:
    words: list[dict] = []
    for segment in segments:
        text = str(segment.get("text") or "").strip()
        tokens = text.split()
        if not tokens:
            continue
        start = _safe_time(segment.get("start"))
        end = max(start + .02, _safe_time(segment.get("end"), start + .02))
        span = max(.02, end - start)
        for index, token in enumerate(tokens):
            token_start = start + span * index / len(tokens)
            token_end = start + span * (index + 1) / len(tokens)
            words.append({"word": token, "start": token_start, "end": token_end})
    return words


def normalize_transcription_result(primary: dict, diarized: dict | None) -> dict:
    primary_segments = primary.get("segments") if isinstance(primary.get("segments"), list) else []
    raw_words = primary.get("words") if isinstance(primary.get("words"), list) else []
    if not raw_words:
        raw_words = _fallback_words([item for item in primary_segments if isinstance(item, dict)])

    speaker_segments: list[dict] = []
    if diarized and isinstance(diarized.get("segments"), list):
        speaker_segments = [item for item in diarized["segments"] if isinstance(item, dict)]

    words: list[dict] = []
    for index, item in enumerate(raw_words):
        if not isinstance(item, dict):
            continue
        text = str(item.get("word") or item.get("text") or "").strip()
        if not text:
            continue
        start = _safe_time(item.get("start"))
        end = max(start + .01, _safe_time(item.get("end"), start + .08))
        words.append({
            "id": f"w{index + 1}",
            "text": text,
            "start": round(start, 4),
            "end": round(end, 4),
            "speaker": _speaker_for_interval(start, end, speaker_segments),
        })

    segments: list[dict] = []
    source_segments = speaker_segments or [item for item in primary_segments if isinstance(item, dict)]
    for index, item in enumerate(source_segments):
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        start = _safe_time(item.get("start"))
        end = max(start + .02, _safe_time(item.get("end"), start + .02))
        segments.append({
            "id": str(item.get("id") or f"s{index + 1}"),
            "text": text,
            "start": round(start, 4),
            "end": round(end, 4),
            "speaker": str(item.get("speaker") or "").strip() or None,
        })

    duration = _safe_time(primary.get("duration"))
    if duration <= 0 and words:
        duration = words[-1]["end"]
    if diarized:
        duration = max(duration, _safe_time(diarized.get("duration")))
    return {
        "text": str(primary.get("text") or (diarized or {}).get("text") or "").strip(),
        "language": str(primary.get("language") or "").strip() or None,
        "duration": round(duration, 4),
        "words": words,
        "segments": segments,
    }


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
            "id": str(item.get("id") or "").strip() or None,
            "text": text,
            "start": start,
            "end": end,
            "speaker": str(item.get("speaker") or "").strip() or None,
        })
    return sorted(output, key=lambda item: (item["start"], item["end"]))


def _manual_caption_groups(document: dict) -> list[dict] | None:
    raw_cues = document.get("captionManualCues")
    if not isinstance(raw_cues, list) or not raw_cues:
        return None

    raw_words = document.get("words") if isinstance(document.get("words"), list) else []
    word_map: dict[str, dict] = {}
    for item in raw_words:
        if not isinstance(item, dict) or _bool(item.get("deleted"), False):
            continue
        word_id = str(item.get("id") or "").strip()
        if word_id:
            word_map[word_id] = item

    show_speakers = _bool(document.get("captionSpeakerLabels"), False)
    groups: list[dict] = []
    for item in raw_cues:
        if not isinstance(item, dict):
            continue
        start = max(0.0, _number(item.get("start"), 0.0))
        end = max(start + .12, _number(item.get("end"), start + .12))
        word_ids = item.get("wordIds") if isinstance(item.get("wordIds"), list) else []
        resolved_words = [word_map.get(str(word_id or "").strip()) for word_id in word_ids]
        resolved_words = [word for word in resolved_words if isinstance(word, dict)]
        if resolved_words:
            text = " ".join(str(word.get("text") or word.get("word") or "").strip() for word in resolved_words).strip()
            speaker = str(resolved_words[0].get("speaker") or item.get("speaker") or "").strip() or None
        else:
            text = str(item.get("text") or "").strip()
            speaker = str(item.get("speaker") or "").strip() or None
        if not text:
            continue
        if show_speakers and speaker:
            text = f"{speaker}: {text}"
        groups.append({"text": text[:700], "startAt": start, "endAt": end})

    if not groups:
        return None
    groups.sort(key=lambda group: (group["startAt"], group["endAt"]))
    return groups


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
            speaker_changed = bool(
                word.get("speaker")
                and current[0].get("speaker")
                and word.get("speaker") != current[0].get("speaker")
            )
            if gap > max_gap or duration > max_duration or len(current) >= max_words or speaker_changed:
                flush()
        current.append(word)
        if str(word["text"]).rstrip().endswith((".", "!", "?", "؟", "؛", ":")):
            flush()
    flush()
    return groups


def _translated_caption_groups(document: dict) -> tuple[str, list[dict]] | None:
    language = str(document.get("captionLanguage") or "source").strip()
    if not language or language == "source":
        return None
    translations = document.get("captionTranslations")
    if not isinstance(translations, dict):
        return None
    pack = translations.get(language)
    if not isinstance(pack, dict):
        return None
    raw_cues = pack.get("cues")
    if not isinstance(raw_cues, list):
        return None

    show_speakers = _bool(document.get("captionSpeakerLabels"), False)
    groups: list[dict] = []
    for item in raw_cues:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        speaker = str(item.get("speaker") or "").strip() or None
        if show_speakers and speaker:
            text = f"{speaker}: {text}"
        start = max(0.0, _number(item.get("start"), 0.0))
        end = max(start + .12, _number(item.get("end"), start + .12))
        groups.append({"text": text[:700], "startAt": start, "endAt": end})
    if not groups:
        return None
    groups.sort(key=lambda item: (item["startAt"], item["endAt"]))
    return language, groups


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

        selected_translation = _translated_caption_groups(document)
        if selected_translation is not None:
            caption_language, groups = selected_translation
        else:
            manual_groups = _manual_caption_groups(document)
            if manual_groups is not None:
                caption_language = str(document.get("language") or "source").strip() or "source"
                groups = manual_groups
            else:
                words = _normalized_words(document)
                if not words:
                    continue
                caption_language = str(document.get("language") or "source").strip() or "source"
                groups = _caption_groups(words, document)

        size = max(18, min(84, int(_number(document.get("captionSize"), 38))))
        position = str(document.get("captionPosition") or "bottom").strip().lower()
        if position not in {"top", "center", "bottom"}:
            position = "bottom"
        color = _hex(document.get("captionColor"), "#ffffff")
        opacity = max(0.0, min(1.0, _number(document.get("captionBoxOpacity"), .48)))
        preset = str(document.get("captionPreset") or "broadcast").strip()[:32]

        for group in groups:
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
                "captionLanguage": caption_language,
                "captionPreset": preset,
            })

    project["subtitleTracks"] = subtitle_tracks
    return project
