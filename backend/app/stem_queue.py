from __future__ import annotations

from collections.abc import Iterable
from typing import Any

PENDING_STATUSES = {"queued", "processing"}


def _queued_at(state: dict[str, Any]) -> float:
    value = state.get("queued_at", state.get("created_at", 0))
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def choose_active_job(states: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    pending = [state for state in states if state.get("status") in PENDING_STATUSES]
    if not pending:
        return None
    processing = [state for state in pending if state.get("status") == "processing"]
    candidates = processing or [state for state in pending if state.get("status") == "queued"]
    return min(candidates, key=lambda state: (_queued_at(state), str(state.get("id", ""))))


def find_duplicate_pending_job(
    states: Iterable[dict[str, Any]],
    *,
    content_sha256: str,
    mode: str,
) -> dict[str, Any] | None:
    matches = [
        state
        for state in states
        if state.get("status") in PENDING_STATUSES
        and state.get("content_sha256") == content_sha256
        and state.get("mode") == mode
    ]
    return choose_active_job(matches)


def queue_position(states: Iterable[dict[str, Any]], job_id: str) -> int:
    queued = sorted(
        (state for state in states if state.get("status") == "queued"),
        key=lambda state: (_queued_at(state), str(state.get("id", ""))),
    )
    for index, state in enumerate(queued, start=1):
        if state.get("id") == job_id:
            return index
    return 0
