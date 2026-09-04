from __future__ import annotations

import hashlib
import os
import sys
import time
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException

from . import identity_store_v24 as identity
from . import reliability_store_v28 as store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _heartbeat(job_key: str, token: str, ttl: int) -> bool:
    row = identity.fetchone("SELECT state,lease_token_hash FROM v26_job_leases WHERE job_key=?", (job_key,))
    if not row or row.get("state") != "active":
        return False
    if str(row.get("lease_token_hash") or "") != _hash(token):
        return False
    now_ts = int(time.time())
    identity.execute(
        "UPDATE v26_job_leases SET heartbeat_at=?,expires_at=?,updated_at=? WHERE job_key=? AND state='active' AND lease_token_hash=?",
        (_now(), now_ts + ttl, _now(), job_key, _hash(token)),
    )
    return True


def heartbeat_worker() -> int:
    drill_id = os.environ["V28_DRILL_ID"]
    job_key = os.environ["V28_JOB_KEY"]
    token = os.environ["V28_LEASE_TOKEN"]
    worker_id = os.environ.get("V28_WORKER_ID") or f"chaos-worker-{os.getpid()}"
    phase = os.environ.get("V28_PHASE", "primary")
    ttl = max(8, min(60, int(os.environ.get("V28_TTL", "15"))))
    work_seconds = max(1.0, min(30.0, float(os.environ.get("V28_WORK_SECONDS", "3"))))
    interval = max(1.0, min(3.0, ttl / 4))

    store.mark(drill_id, worker_id, "process_started", {"pid": os.getpid(), "phase": phase})
    started = time.monotonic()
    while True:
        if not _heartbeat(job_key, token, ttl):
            store.mark(drill_id, worker_id, "lease_lost", {"pid": os.getpid(), "phase": phase})
            return 3
        store.mark(drill_id, worker_id, "heartbeat", {"pid": os.getpid(), "phase": phase})
        if phase == "replacement" and time.monotonic() - started >= work_seconds:
            committed = store.try_commit(drill_id, worker_id)
            store.mark(
                drill_id,
                worker_id,
                "result_committed" if committed else "duplicate_commit_blocked",
                {"pid": os.getpid(), "phase": phase},
            )
            return 0 if committed else 4
        time.sleep(interval)


def contender_worker() -> int:
    # Import only for the contender mode so the lightweight heartbeat worker
    # does not initialize the full video reliability module unnecessarily.
    from .video_tools_v26_runtime import base as v26

    drill_id = os.environ["V28_DRILL_ID"]
    job_key = os.environ["V28_JOB_KEY"]
    worker_id = os.environ.get("V28_WORKER_ID") or f"contender-{os.getpid()}-{uuid.uuid4().hex[:4]}"
    start_at = float(os.environ.get("V28_START_AT", "0") or 0)
    while start_at and time.time() < start_at:
        time.sleep(.01)

    payload = {
        "jobKey": job_key,
        "category": "v28-duplicate-contest",
        "jobId": drill_id,
        "workerId": worker_id,
        "ttlSeconds": 15,
        "maxAttempts": 1,
        "idempotencyKey": job_key,
        "payloadChecksum": hashlib.sha256(drill_id.encode("utf-8")).hexdigest(),
    }
    try:
        result = v26._acquire_lease(payload)
    except HTTPException as exc:
        store.mark(drill_id, worker_id, "lease_rejected", {"status": exc.status_code, "detail": str(exc.detail)[:300]})
        return 0

    token = result.get("leaseToken")
    if not token:
        store.mark(drill_id, worker_id, "lease_replayed", {"replayed": bool(result.get("replayed"))})
        return 0

    store.mark(drill_id, worker_id, "lease_won", {"pid": os.getpid()})
    time.sleep(1.5)
    committed = store.try_commit(drill_id, worker_id)
    store.mark(drill_id, worker_id, "result_committed" if committed else "duplicate_commit_blocked", {"pid": os.getpid()})
    try:
        v26._verify_lease_token(job_key, token)
        identity.execute(
            "UPDATE v26_job_leases SET state='completed',heartbeat_at=?,expires_at=NULL,lease_token_hash=NULL,updated_at=? WHERE job_key=?",
            (_now(), _now(), job_key),
        )
    except Exception:
        pass
    return 0


def main() -> int:
    mode = os.environ.get("V28_MODE", "heartbeat")
    if mode == "contend":
        return contender_worker()
    return heartbeat_worker()


if __name__ == "__main__":
    sys.exit(main())
