from __future__ import annotations

import re


def extract_demucs_percent(line: str) -> int | None:
    match = re.search(r"(?<!\d)(\d{1,3})%\|", line)
    if not match:
        match = re.search(r"(?<!\d)(\d{1,3})%", line)
    if not match:
        return None
    return max(0, min(100, int(match.group(1))))


def demucs_progress_state(demucs_percent: int) -> dict[str, object]:
    percent = max(0, min(100, int(demucs_percent)))
    if percent >= 100:
        return {
            "stage": "finalizing",
            "progress": 90,
            "message": "اكتمل فصل المسارات، ويتم الآن كتابة وتجهيز الملفات النهائية...",
        }
    return {
        "stage": "separating",
        "progress": min(88, 25 + round(percent * 0.63)),
        "message": f"جاري فصل المسارات وتحليل الصوت — تقدم المحرك {percent}%.",
    }


def demucs_stall_reason(
    *,
    now: float,
    last_output_at: float,
    engine_completed_at: float | None,
    stall_timeout_seconds: int,
    finalize_timeout_seconds: int,
) -> str | None:
    if engine_completed_at is not None:
        if now - engine_completed_at > max(1, finalize_timeout_seconds):
            return "اكتمل فصل المسارات، لكن محرك Demucs لم يُنهِ كتابة الملفات النهائية ضمن المهلة المحددة."
        return None
    if now - last_output_at > max(1, stall_timeout_seconds):
        return "توقف محرك Demucs عن إرسال تقدم لفترة أطول من المهلة المحددة."
    return None
