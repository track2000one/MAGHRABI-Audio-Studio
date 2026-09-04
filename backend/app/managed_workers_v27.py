from __future__ import annotations

import hashlib
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException

from . import identity_store_v24 as identity
from . import reliability_store_v26 as rel
from .video_tools_v26_runtime import base as v26


TERMINAL = {"done", "failed", "cancelled", "partial"}


def _now_ts() -> int:
    return int(time.time())


def _stable_payload(value: Any) -> Any:
    if isinstance(value, dict):
        ignored = {
            "status", "stage", "progress", "message", "error", "startedAt", "finishedAt",
            "resultReady", "reportReady", "captionsReady", "updatedAt", "steps",
        }
        return {key: _stable_payload(item) for key, item in sorted(value.items()) if key not in ignored}
    if isinstance(value, list):
        return [_stable_payload(item) for item in value]
    return value


def payload_checksum(state: dict, paths: list[Path] | None = None) -> str:
    digest = hashlib.sha256()
    digest.update(json.dumps(_stable_payload(state), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    for path in sorted(paths or [], key=lambda item: str(item)):
        try:
            stat = path.stat()
            digest.update(str(path.name).encode("utf-8"))
            digest.update(str(stat.st_size).encode("ascii"))
            digest.update(str(stat.st_mtime_ns).encode("ascii"))
        except OSError:
            digest.update(f"missing:{path.name}".encode("utf-8"))
    return digest.hexdigest()


def file_checksum(path: Path | None) -> str | None:
    if path is None or not path.exists() or not path.is_file():
        return None
    settings = rel.get_settings()
    max_bytes = max(1, int(settings.get("checksum.maxFileMb", 4096) or 4096)) * 1024 * 1024
    try:
        if path.stat().st_size > max_bytes:
            return None
    except OSError:
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(4 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def lease_row(job_key: str) -> dict | None:
    return identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,))


def generation_key(prefix: str, identity_key: str, generation: int) -> str:
    return f"v27:{prefix}:{identity_key}:g{max(1, int(generation or 1))}"


def next_generation_if_completed(prefix: str, identity_key: str, generation: int) -> int:
    generation = max(1, int(generation or 1))
    row = lease_row(generation_key(prefix, identity_key, generation))
    if row and row.get("state") == "completed":
        return generation + 1
    return generation


@dataclass
class LeaseHandle:
    job_key: str
    token: str | None
    acquired: bool
    replayed: bool
    reason: str | None
    circuit: str | None
    worker_id: str
    ttl: int
    stop_event: threading.Event | None = None
    heartbeat_thread: threading.Thread | None = None

    def start_heartbeat(self) -> None:
        if not self.acquired or not self.token or self.stop_event is not None:
            return
        stop = threading.Event()
        self.stop_event = stop
        interval = max(5, min(max(5, self.ttl // 3), int(rel.get_settings().get("lease.heartbeatSeconds", 15) or 15)))

        def loop() -> None:
            while not stop.wait(interval):
                try:
                    row = v26._verify_lease_token(self.job_key, self.token or "")
                    if row.get("state") != "active":
                        return
                    expires = _now_ts() + self.ttl
                    identity.execute(
                        "UPDATE v26_job_leases SET heartbeat_at=?,expires_at=?,updated_at=? WHERE job_key=? AND state='active'",
                        (v26._now(), expires, v26._now(), self.job_key),
                    )
                except Exception as exc:
                    rel.event(
                        "managed_worker_heartbeat_failed",
                        severity="warning",
                        job_key=self.job_key,
                        node_id=v26.NODE_ID,
                        details={"workerId": self.worker_id, "error": str(exc)[:500]},
                    )
                    return

        thread = threading.Thread(target=loop, daemon=True, name=f"v27-heartbeat-{self.worker_id[-24:]}")
        self.heartbeat_thread = thread
        thread.start()

    def stop_heartbeat(self) -> None:
        if self.stop_event is not None:
            self.stop_event.set()
        if self.heartbeat_thread is not None and self.heartbeat_thread.is_alive():
            self.heartbeat_thread.join(timeout=1.0)


def acquire(
    *,
    prefix: str,
    identity_key: str,
    generation: int,
    state: dict,
    paths: list[Path] | None = None,
    max_attempts: int | None = None,
    circuit: str | None = None,
) -> LeaseHandle:
    job_key = generation_key(prefix, identity_key, generation)
    ttl = max(20, min(600, int(rel.get_settings().get("lease.ttlSeconds", 60) or 60)))
    worker_id = f"{v26.NODE_ID}:{prefix}"
    checksum = payload_checksum(state, paths)
    payload = {
        "jobKey": job_key,
        "category": f"v27-{prefix}",
        "jobId": identity_key,
        "workerId": worker_id,
        "ttlSeconds": ttl,
        "maxAttempts": max_attempts or int(rel.get_settings().get("retry.maxAttempts", 3) or 3),
        "idempotencyKey": job_key,
        "payloadChecksum": checksum,
        "circuit": circuit,
    }
    try:
        result = v26._acquire_lease(payload)
    except HTTPException as exc:
        return LeaseHandle(job_key, None, False, False, str(exc.detail), circuit, worker_id, ttl)
    handle = LeaseHandle(
        job_key=job_key,
        token=result.get("leaseToken"),
        acquired=bool(result.get("leaseToken")),
        replayed=bool(result.get("replayed")),
        reason=None,
        circuit=circuit,
        worker_id=worker_id,
        ttl=ttl,
    )
    if handle.acquired:
        handle.start_heartbeat()
        rel.event(
            "managed_worker_started",
            job_key=job_key,
            node_id=v26.NODE_ID,
            details={"prefix": prefix, "workerId": worker_id, "payloadChecksum": checksum},
        )
    return handle


def complete(handle: LeaseHandle, result_path: Path | None = None) -> dict | None:
    handle.stop_heartbeat()
    if not handle.acquired or not handle.token:
        return None
    row = v26._verify_lease_token(handle.job_key, handle.token)
    checksum = file_checksum(result_path)
    identity.execute(
        "UPDATE v26_job_leases SET state='completed',result_checksum=?,heartbeat_at=?,expires_at=NULL,lease_token_hash=NULL,updated_at=? WHERE job_key=?",
        (checksum, v26._now(), v26._now(), handle.job_key),
    )
    v26._record_circuit(handle.circuit, True)
    rel.event(
        "managed_worker_completed",
        job_key=handle.job_key,
        node_id=v26.NODE_ID,
        details={"attempt": row.get("attempt"), "resultChecksum": checksum},
    )
    return lease_row(handle.job_key)


def fail(handle: LeaseHandle, error: str, payload: dict | None = None) -> dict | None:
    handle.stop_heartbeat()
    if not handle.acquired or not handle.token:
        return None
    try:
        row = v26._verify_lease_token(handle.job_key, handle.token)
    except HTTPException:
        return lease_row(handle.job_key)
    result = v26._fail_lease(row, error[:2000], payload or {}, handle.circuit)
    rel.event(
        "managed_worker_failed",
        severity="error" if result.get("state") == "dlq" else "warning",
        job_key=handle.job_key,
        node_id=v26.NODE_ID,
        details={"result": result, "error": error[:500]},
    )
    return lease_row(handle.job_key)


def retry_due(row: dict | None) -> bool:
    if not row:
        return True
    state = str(row.get("state") or "")
    if state in {"queued", "new"}:
        return True
    if state == "retry_wait":
        return int(row.get("next_retry_at") or 0) <= _now_ts()
    if state == "active":
        return int(row.get("expires_at") or 0) <= _now_ts()
    return False


def dlq_for(job_key: str) -> dict | None:
    return identity.fetchone(
        "SELECT * FROM v26_dead_letters WHERE job_key=? AND resolved_at IS NULL ORDER BY last_failed_at DESC LIMIT 1",
        (job_key,),
    )


def release_local_scheduled(lock: threading.Lock | threading.RLock, scheduled: set[str], job_id: str) -> None:
    with lock:
        scheduled.discard(job_id)


def patch_state_for_retry(state: dict, *, message: str) -> dict:
    state.update(
        status="queued",
        stage="queued" if "stage" in state else state.get("stage"),
        progress=0,
        startedAt=None,
        finishedAt=None,
        resultReady=False,
        error=None,
        message=message,
    )
    if "reportReady" in state:
        state["reportReady"] = False
    if "captionsReady" in state:
        state["captionsReady"] = False
    if "steps" in state:
        state["steps"] = []
    return state


def managed_counts(prefixes: list[str] | None = None) -> dict:
    rows = identity.fetchall("SELECT category,state,COUNT(*) AS count FROM v26_job_leases GROUP BY category,state")
    output: dict[str, dict[str, int]] = {}
    for row in rows:
        category = str(row.get("category") or "")
        if prefixes and category not in prefixes:
            continue
        output.setdefault(category, {})[str(row.get("state") or "unknown")] = int(row.get("count") or 0)
    return output


def circuit_state(name: str) -> dict:
    return v26._circuit_public(v26._circuit_row(name))


def run_guarded(
    handle: LeaseHandle,
    runner: Callable[[], None],
    *,
    final_state: Callable[[], dict],
    result_path: Callable[[], Path | None],
) -> dict:
    if not handle.acquired:
        return {"executed": False, "replayed": handle.replayed, "reason": handle.reason}
    try:
        runner()
        state = final_state()
        if str(state.get("status")) == "done":
            complete(handle, result_path())
            return {"executed": True, "success": True, "state": state}
        error = str(state.get("error") or state.get("message") or "Managed worker failed")
        lease = fail(handle, error, state)
        return {"executed": True, "success": False, "state": state, "lease": lease}
    except Exception as exc:
        lease = fail(handle, str(exc), {})
        raise
