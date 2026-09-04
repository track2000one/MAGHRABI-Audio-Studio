from __future__ import annotations

import hmac
import os
import re
import socket

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from . import video_tools_v26 as base

# RAILWAY_REPLICA_ID is the preferred stable identity. When it is absent,
# never fall back to deployment id alone because a deployment may have more
# than one replica. Hostname + PID keeps the runtime node identity unique.
base.DEPLOYMENT_ID = os.getenv("RAILWAY_DEPLOYMENT_ID", "")
base.INSTANCE_ID = os.getenv("RAILWAY_REPLICA_ID") or os.getenv("HOSTNAME") or socket.gethostname()
base.NODE_ID = (
    os.getenv("RAILWAY_REPLICA_ID")
    or f"{base.DEPLOYMENT_ID or 'local'}:{socket.gethostname()}:{os.getpid()}"
)

# Lease ownership must survive a load balancer routing heartbeat/complete to
# another API replica. The unguessable lease token proves ownership; the DB
# owner field is informational/drain-aware. External workers may supply a
# stable workerId, while in-process workers keep the local node id.
_original_acquire = base._acquire_lease


def _runtime_acquire(payload: dict) -> dict:
    result = _original_acquire(payload)
    worker_id = str(payload.get("workerId") or "").strip()[:180]
    lease_token = result.get("leaseToken")
    lease = result.get("lease") or {}
    if worker_id and lease_token and lease.get("jobKey"):
        base.identity.execute(
            "UPDATE v26_job_leases SET owner_node_id=?,updated_at=? WHERE job_key=? AND state='active'",
            (worker_id, base._now(), lease["jobKey"]),
        )
        fresh = base.identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (lease["jobKey"],))
        if fresh:
            result["lease"] = base._lease_public(fresh)
    return result


def _runtime_verify_lease_token(job_key: str, token: str) -> dict:
    row = base.identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,))
    if not row or row.get("state") != "active":
        raise HTTPException(status_code=404, detail="Lease نشطة غير موجودة.")
    if not token or not hmac.compare_digest(str(row.get("lease_token_hash") or ""), base._hash(token)):
        raise HTTPException(status_code=401, detail="Lease token غير صالح.")
    return row


base._acquire_lease = _runtime_acquire
base._verify_lease_token = _runtime_verify_lease_token
router = base.router


def install_reliability(app) -> None:
    base.install_reliability(app)
    if getattr(app.state, "v26_unversioned_video_gate_installed", False):
        return
    app.state.v26_unversioned_video_gate_installed = True

    @app.middleware("http")
    async def v26_unversioned_video_gate(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        is_versioned = bool(re.match(r"^/api/video/v\d+(?:/|$)", path))
        is_base_video_mutation = (
            path.startswith("/api/video/")
            and not is_versioned
            and method not in {"GET", "HEAD", "OPTIONS"}
        )
        maintenance = base._maintenance()
        if is_base_video_mutation and (maintenance["enabled"] or maintenance["draining"]):
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "Production processing is temporarily unavailable during Maintenance/Draining.",
                    "maintenance": maintenance,
                },
                headers={"Retry-After": "30", "X-MAGHRABI-MAINTENANCE": "true"},
            )
        return await call_next(request)
