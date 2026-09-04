from __future__ import annotations

import hashlib

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from . import video_tools_v30 as base

router = base.router


def _safe_stage_since(release: dict) -> str:
    events = base.store.stage_events(release["id"], 100)
    for event in events:
        if event["eventType"] in {"stage_applied", "auto_stage_applied", "release_started", "promoted", "auto_promoted", "resumed"}:
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
# runtime, so patching them here hardens V30 without duplicating existing routes.
base._stage_since = _safe_stage_since
base._cohort_for = _safe_cohort_for


@router.post("/admin/releases/{release_id}/resume")
async def resume_release_v30(release_id: str, admin: dict = Depends(base.v24.require_admin_write)) -> dict:
    release = base.store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    if release.get("state") != "paused":
        raise HTTPException(status_code=409, detail="Release ليست في حالة PAUSED.")
    next_state = "promoting" if int(release.get("appliedPercent") or 0) >= 100 else "canary"
    updated = base.store.update_release(release_id, state=next_state)
    base.store.add_stage_event(
        release_id, "resumed", release.get("appliedPercent"), release.get("appliedPercent"),
        next_state, str(admin.get("id") or "admin"), {"preservedTrafficPercent": release.get("appliedPercent")},
    )
    base.rel26.event(
        "v30_release_resumed", node_id=base.v29.v26.NODE_ID,
        details={"releaseId": release_id, "trafficPercent": release.get("appliedPercent")},
    )
    return updated


def install_v30(app) -> None:
    # Install base sampling/controller first.
    base.install_v30(app)
    if getattr(app.state, "v30_runtime_guard_installed", False):
        return
    app.state.v30_runtime_guard_installed = True

    @app.middleware("http")
    async def v30_single_active_release_guard(request: Request, call_next):
        path = request.url.path
        if request.method.upper() == "POST" and path.startswith("/api/video/v30/admin/releases/") and path.endswith("/start"):
            parts = [part for part in path.split("/") if part]
            release_id = parts[-2] if len(parts) >= 2 else ""
            active = base.store.active_release()
            if active and active.get("id") != release_id:
                return JSONResponse(
                    {"detail": f"يوجد Progressive Release نشطة بالفعل: {active.get('name')}. أنهها أو Rollback قبل بدء Release أخرى."},
                    status_code=409,
                )
        return await call_next(request)
