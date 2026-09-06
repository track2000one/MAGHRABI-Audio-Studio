from __future__ import annotations

import asyncio
import json
import os
from urllib import error as urlerror
from urllib import request as urlrequest

from fastapi import APIRouter, Body, Depends, HTTPException

from .main import require_auth

router = APIRouter(prefix="/api/transcript", tags=["transcript-intelligence"])
MAX_CUES_PER_REQUEST = 80
MAX_SOURCE_CHARACTERS = 12_000
UPSTREAM_TIMEOUT_SECONDS = 180


def _api_key() -> str:
    return (os.getenv("TRANSCRIPTION_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()


def _api_base() -> str:
    value = (os.getenv("TRANSCRIPTION_API_BASE") or "https://api.openai.com/v1").strip()
    return value.rstrip("/")


def _translation_model() -> str:
    return (os.getenv("TRANSCRIPTION_TRANSLATION_MODEL") or "gpt-4o-mini").strip()


def _language_label(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="حدد لغة الترجمة المستهدفة.")
    return text[:80]


def _normalize_cues(value: object) -> list[dict]:
    if not isinstance(value, list) or not value:
        raise HTTPException(status_code=422, detail="لا توجد Captions صالحة للترجمة.")
    if len(value) > MAX_CUES_PER_REQUEST:
        raise HTTPException(status_code=413, detail=f"الحد الأعلى لكل دفعة ترجمة هو {MAX_CUES_PER_REQUEST} Caption.")

    output: list[dict] = []
    total_chars = 0
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        cue_id = str(item.get("id") or f"c{index + 1}").strip()[:96]
        text = str(item.get("text") or "").strip()
        if not cue_id or cue_id in seen or not text:
            continue
        seen.add(cue_id)
        total_chars += len(text)
        if total_chars > MAX_SOURCE_CHARACTERS:
            raise HTTPException(status_code=413, detail="دفعة الترجمة كبيرة جدًا. قسّمها إلى أجزاء أصغر.")
        output.append({"id": cue_id, "text": text[:1200]})
    if not output:
        raise HTTPException(status_code=422, detail="لا توجد Captions نصية صالحة للترجمة.")
    return output


def _extract_json_text(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        cleaned = cleaned.rsplit("```", 1)[0].strip()
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("translation response did not contain JSON")
        payload = json.loads(cleaned[start:end + 1])
    if not isinstance(payload, dict):
        raise ValueError("translation response JSON must be an object")
    return payload


def _upstream_translate(cues: list[dict], source_language: str, target_language: str) -> dict:
    key = _api_key()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="خدمة الترجمة غير مفعلة. أضف OPENAI_API_KEY أو TRANSCRIPTION_API_KEY في إعدادات الخادم.",
        )

    source_hint = source_language or "auto-detected source language"
    system_prompt = (
        "You are a professional audiovisual subtitle translator. Translate each caption faithfully and naturally "
        "for on-screen subtitles. Preserve meaning, names, numbers, punctuation intent, and reading brevity. "
        "Never merge, split, reorder, omit, or invent captions. Return JSON only with this exact shape: "
        '{"translations":[{"id":"same input id","text":"translated caption"}]}. '
        "Keep every input id exactly unchanged."
    )
    user_payload = {
        "sourceLanguage": source_hint,
        "targetLanguage": target_language,
        "captions": cues,
    }
    request_body = json.dumps({
        "model": _translation_model(),
        "temperature": 0.15,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
    }, ensure_ascii=False).encode("utf-8")

    req = urlrequest.Request(
        f"{_api_base()}/chat/completions",
        data=request_body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "MAGHRABI-Audio-Studio/Transcript-Finishing-Pro",
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
        print(f"[transcript-translate] upstream HTTP {exc.code}: {detail}", flush=True)
        raise HTTPException(status_code=502, detail="تعذر إكمال ترجمة Captions لدى مزود الذكاء اللغوي.") from exc
    except (urlerror.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="تعذر الاتصال بخدمة ترجمة Captions.") from exc

    try:
        choices = payload.get("choices") if isinstance(payload, dict) else None
        content = choices[0]["message"]["content"] if isinstance(choices, list) and choices else ""
        translated = _extract_json_text(str(content or ""))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="استجابة خدمة ترجمة Captions غير صالحة.") from exc

    raw = translated.get("translations")
    if not isinstance(raw, list):
        raise HTTPException(status_code=502, detail="استجابة الترجمة لا تحتوي Captions صالحة.")

    expected = [item["id"] for item in cues]
    by_id: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        cue_id = str(item.get("id") or "").strip()
        text = str(item.get("text") or "").strip()
        if cue_id in expected and text:
            by_id[cue_id] = text[:1600]
    if any(cue_id not in by_id for cue_id in expected):
        raise HTTPException(status_code=502, detail="الترجمة لم تُرجع جميع Captions المطلوبة؛ لم يتم حفظ نتيجة ناقصة.")

    return {
        "model": _translation_model(),
        "translations": [{"id": cue_id, "text": by_id[cue_id]} for cue_id in expected],
    }


@router.post("/translate")
async def translate_captions(
    payload: dict = Body(...),
    _username: str = Depends(require_auth),
) -> dict:
    target_language = _language_label(payload.get("targetLanguage"))
    source_language = str(payload.get("sourceLanguage") or "").strip()[:80]
    cues = _normalize_cues(payload.get("cues"))
    result = await asyncio.to_thread(_upstream_translate, cues, source_language, target_language)
    return {
        "provider": "openai-compatible",
        "model": result["model"],
        "sourceLanguage": source_language or None,
        "targetLanguage": target_language,
        "translations": result["translations"],
    }
