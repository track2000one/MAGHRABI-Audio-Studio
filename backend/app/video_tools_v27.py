from __future__ import annotations

import json
import threading
import time
import uuid

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse

from . import identity_store_v24 as identity
from . import managed_workers_v27 as managed
from . import reliability_store_v26 as rel
from . import video_tools_v12_runtime as v12runtime
from . import video_tools_v13_runtime as v13runtime
from . import video_tools_v20_runtime as v20runtime
from . import video_tools_v21_runtime as v21runtime
from . import video_tools_v24 as v24
from .video_tools_v26_runtime import base as v26

router = APIRouter(prefix="/api/video/v27", tags=["video-studio-v27"])

_STOP = threading.Event()
_STARTED = False
_START_LOCK = threading.Lock()
_LAST_RECONCILE: dict = {}


def _lease_for(prefix: str, identity_key: str, generation: int) -> dict | None:
    return managed.lease_row(managed.generation_key(prefix, identity_key, generation))


def _coverage_v12() -> dict:
    total = managed_count = active_unmanaged = 0
    states: dict[str, int] = {}
    for path in v12runtime.base.QUEUE_DIR.glob("*/job.json"):
        try:
            state = v12runtime.base._read_state(path.parent.name)
        except Exception:
            continue
        total += 1
        status = str(state.get("status") or "unknown")
        states[status] = states.get(status, 0) + 1
        job_id = str(state.get("id") or path.parent.name)
        row = _lease_for("v12-render", job_id, int(state.get("v27Generation") or 1))
        if row:
            managed_count += 1
        elif status in {"queued", "rendering"}:
            active_unmanaged += 1
    return {"id": "v12", "label": "V12 Render Queue", "total": total, "managed": managed_count, "activeUnmanaged": active_unmanaged, "states": states}


def _coverage_v13() -> dict:
    total = managed_count = active_unmanaged = 0
    states: dict[str, int] = {}
    for path in v13runtime.base.PROXY_DIR.glob("*/job.json"):
        try:
            state = v13runtime.base._read(path.parent.name)
        except Exception:
            continue
        total += 1
        status = str(state.get("status") or "unknown")
        states[status] = states.get(status, 0) + 1
        job_id = str(state.get("id") or path.parent.name)
        row = _lease_for("v13-proxy", job_id, int(state.get("v27Generation") or 1))
        if row:
            managed_count += 1
        elif status in {"queued", "processing"}:
            active_unmanaged += 1
    return {"id": "v13", "label": "V13 Proxy Queue", "total": total, "managed": managed_count, "activeUnmanaged": active_unmanaged, "states": states}


def _coverage_v20() -> dict:
    total = managed_count = active_unmanaged = 0
    states: dict[str, int] = {}
    for path in v20runtime.base.PIPELINE_DIR.glob("*/job.json"):
        try:
            state = v20runtime.base._read_state(path.parent.name)
        except Exception:
            continue
        if state.get("managedBy") == "v21":
            continue
        total += 1
        status = str(state.get("status") or "unknown")
        states[status] = states.get(status, 0) + 1
        job_id = str(state.get("id") or path.parent.name)
        row = _lease_for("v20-pipeline", job_id, int(state.get("v27Generation") or 1))
        if row:
            managed_count += 1
        elif status in {"queued", "processing"}:
            active_unmanaged += 1
    return {"id": "v20", "label": "V20 Production Pipeline", "total": total, "managed": managed_count, "activeUnmanaged": active_unmanaged, "states": states}


def _coverage_v21() -> dict:
    total = managed_count = active_unmanaged = 0
    states: dict[str, int] = {}
    projects = 0
    for path in v21runtime.base.PROJECTS_DIR.glob("*/project.json"):
        try:
            project = v21runtime.base._read_project(path.parent.name)
        except Exception:
            continue
        projects += 1
        project_id = str(project.get("id") or path.parent.name)
        for item in project.get("items", []):
            total += 1
            status = str(item.get("status") or "unknown")
            states[status] = states.get(status, 0) + 1
            item_id = str(item.get("id") or "")
            if not item_id:
                continue
            row = _lease_for("v21-item", f"{project_id}:{item_id}", int(item.get("v27Generation") or 1))
            if row:
                managed_count += 1
            elif status in {"queued", "processing"}:
                active_unmanaged += 1
    return {"id": "v21", "label": "V21 Orchestrator Items", "projects": projects, "total": total, "managed": managed_count, "activeUnmanaged": active_unmanaged, "states": states}


def _coverage() -> dict:
    integrations = [_coverage_v12(), _coverage_v13(), _coverage_v20(), _coverage_v21()]
    total = sum(int(item["total"]) for item in integrations)
    managed_total = sum(int(item["managed"]) for item in integrations)
    active_unmanaged = sum(int(item["activeUnmanaged"]) for item in integrations)
    return {
        "integrations": integrations,
        "totalJobs": total,
        "managedJobs": managed_total,
        "coveragePercent": round((managed_total / total) * 100, 1) if total else 100.0,
        "activeUnmanaged": active_unmanaged,
    }


def reconcile_all() -> dict:
    global _LAST_RECONCILE
    with rel.distributed_lock("v27:managed-reconcile") as acquired:
        if not acquired:
            return {"acquired": False, "reason": "another replica owns reconciliation"}
        v26_recovery = v26._recover_expired_leases()
        result = {
            "acquired": True,
            "at": v26._now(),
            "v26Recovery": v26_recovery,
            "v12": v12runtime.reconcile(),
            "v13": v13runtime.reconcile(),
            "v20": v20runtime.reconcile(),
            "v21": v21runtime.reconcile(),
        }
        _LAST_RECONCILE = result
        if v26_recovery.get("expired"):
            rel.event("v27_expired_leases_reconciled", node_id=v26.NODE_ID, details=result)
        return result


def _loop() -> None:
    while not _STOP.wait(5.0):
        try:
            reconcile_all()
        except Exception as exc:
            rel.event("v27_reconcile_error", severity="error", node_id=v26.NODE_ID, details={"error": str(exc)[:1000]})


def install_managed_workers(app) -> None:
    global _STARTED
    with _START_LOCK:
        if _STARTED:
            return
        _STARTED = True

    async def startup() -> None:
        _STOP.clear()
        try:
            reconcile_all()
        except Exception:
            pass
        threading.Thread(target=_loop, daemon=True, name="v27-managed-reconciler").start()

    async def shutdown() -> None:
        _STOP.set()

    app.add_event_handler("startup", startup)
    app.add_event_handler("shutdown", shutdown)


def _chaos_history() -> list[dict]:
    rows = identity.fetchall(
        "SELECT * FROM v26_reliability_events WHERE event_type='v27_chaos_drill' ORDER BY created_at DESC LIMIT 30"
    )
    output = []
    for row in rows:
        try:
            details = json.loads(str(row.get("details_json") or "{}"))
        except Exception:
            details = {}
        output.append({"id": row.get("id"), "createdAt": row.get("created_at"), "severity": row.get("severity"), "details": details})
    return output


def _overview() -> dict:
    coverage = _coverage()
    v26_ready = v26._ready_payload()
    managed_ready = bool(v26_ready.get("ready")) and coverage["activeUnmanaged"] == 0
    return {
        "version": "27",
        "generatedAt": v26._now(),
        "nodeId": v26.NODE_ID,
        "managedReady": managed_ready,
        "v26Readiness": v26_ready,
        "coverage": coverage,
        "managedLeaseCounts": managed.managed_counts(["v27-v12-render", "v27-v13-proxy", "v27-v20-pipeline", "v27-v21-item", "v27-chaos"]),
        "circuits": [managed.circuit_state(name) for name in ["ffmpeg-render", "ffmpeg-proxy", "ffmpeg-pipeline", "orchestrator-pipeline"]],
        "lastReconcile": _LAST_RECONCILE,
        "chaosHistory": _chaos_history(),
        "semantics": {
            "heartbeat": "lease-token based and load-balancer safe",
            "retry": "exponential backoff from V26",
            "dlq": "after max attempts",
            "idempotency": "per queue job generation",
            "shutdown": "V26 drain + lease expiry recovery",
        },
    }


@router.get("/health/live")
async def live_v27() -> dict:
    return {"live": True, "version": "27", "nodeId": v26.NODE_ID}


@router.get("/health/ready")
async def ready_v27() -> JSONResponse:
    payload = _overview()
    return JSONResponse(payload, status_code=200 if payload["managedReady"] else 503)


@router.get("/admin/overview")
async def overview_v27(admin: dict = Depends(v24.require_admin)) -> dict:
    return _overview()


@router.post("/admin/reconcile")
async def reconcile_v27(admin: dict = Depends(v24.require_admin_write)) -> dict:
    result = reconcile_all()
    rel.event("v27_manual_reconcile", node_id=v26.NODE_ID, details={"actor": admin.get("id"), "result": result})
    return result


@router.post("/admin/chaos-drill")
async def chaos_drill_v27(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    mode = str(payload.get("mode") or "retry").lower()
    if mode not in {"retry", "dlq"}:
        mode = "retry"
    drill_id = uuid.uuid4().hex[:12]
    state = {"kind": "synthetic-heartbeat-loss", "drillId": drill_id, "mode": mode, "createdAt": v26._now()}
    handle = managed.acquire(
        prefix="chaos",
        identity_key=drill_id,
        generation=1,
        state=state,
        max_attempts=2,
        circuit=None,
    )
    if not handle.acquired:
        return {"ok": False, "drillId": drill_id, "reason": handle.reason}
    handle.stop_heartbeat()
    identity.execute("UPDATE v26_job_leases SET expires_at=? WHERE job_key=?", (int(time.time()) - 1, handle.job_key))
    first = v26._recover_expired_leases()
    first_row = managed.lease_row(handle.job_key) or {}
    stages = [{"attempt": 1, "state": first_row.get("state"), "recovery": first}]

    if mode == "dlq" and first_row.get("state") == "retry_wait":
        identity.execute("UPDATE v26_job_leases SET next_retry_at=? WHERE job_key=?", (int(time.time()) - 1, handle.job_key))
        second = managed.acquire(prefix="chaos", identity_key=drill_id, generation=1, state=state, max_attempts=2)
        if second.acquired:
            second.stop_heartbeat()
            identity.execute("UPDATE v26_job_leases SET expires_at=? WHERE job_key=?", (int(time.time()) - 1, second.job_key))
            recovery2 = v26._recover_expired_leases()
            second_row = managed.lease_row(second.job_key) or {}
            stages.append({"attempt": 2, "state": second_row.get("state"), "recovery": recovery2})

    final_row = managed.lease_row(handle.job_key) or {}
    details = {
        "drillId": drill_id,
        "mode": mode,
        "jobKey": handle.job_key,
        "finalState": final_row.get("state"),
        "stages": stages,
        "actor": admin.get("id"),
        "synthetic": True,
    }
    rel.event("v27_chaos_drill", severity="warning", job_key=handle.job_key, node_id=v26.NODE_ID, details=details)
    return {"ok": True, **details}
