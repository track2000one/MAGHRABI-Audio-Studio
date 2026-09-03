from __future__ import annotations

from pathlib import Path

from . import video_tools_v20 as base

router = base.router
_original_transcribe = base._transcribe


def _safe_transcribe(source: Path, folder: Path, language: str):
    try:
        return _original_transcribe(source, folder, language)
    except Exception as exc:
        return None, None, f"تعذر الوصول إلى Speech-to-Text Worker؛ تم تخطي النسخ التلقائي واستمرار Pipeline. ({str(exc)[:300]})"


base._transcribe = _safe_transcribe
