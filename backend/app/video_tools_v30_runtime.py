from __future__ import annotations

import hashlib

from . import video_tools_v30 as base

router = base.router
install_v30 = base.install_v30


def _safe_stage_since(release: dict) -> str:
    events = base.store.stage_events(release["id"], 100)
    for event in events:
        if event["eventType"] in {"stage_applied", "auto_stage_applied", "release_started", "promoted", "auto_promoted"}:
            return str(event["createdAt"])
    return str(release.get("startedAt") or release.get("createdAt") or base._now())


def _safe_cohort_for(request, release: dict):
    header = request.headers.get("x-v30-cohort", "").strip().lower()
    if header in {"current", "candidate"}:
        return header

    # When an external traffic controller is configured, only that controller
    # knows which deployment actually served the request. Never invent a
    # Current/Canary label from hashing in this mode; unlabeled requests are
    # deliberately excluded from comparative SLO metrics.
    if base._traffic_config().get("configured"):
        return None

    percent = max(0, min(100, int(release.get("appliedPercent") or 0)))
    subject = base._stable_subject(request)
    digest = hashlib.sha256(f"{release['id']}|{subject}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") % 100
    return "candidate" if bucket < percent else "current"


# Endpoint/background functions in the base module resolve these globals at
# runtime, so patching them here hardens V30 without duplicating routes.
base._stage_since = _safe_stage_since
base._cohort_for = _safe_cohort_for
