from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from . import identity_store_v24 as identity
from . import reliability_store_v26 as rel
from . import video_tools_v24 as v24
from . import video_tools_v25 as v25
from .main import DATA_DIR

router = APIRouter(prefix="/api/video/v26", tags=["video-studio-v26"])

NODE_ID = (
    os.getenv("RAILWAY_REPLICA_ID")
    or os.getenv("RAILWAY_DEPLOYMENT_ID")
    or f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
)
INSTANCE_ID = os.getenv("RAILWAY_REPLICA_ID") or os.getenv("HOSTNAME") or socket.gethostname()
DEPLOYMENT_ID = os.getenv("RAILWAY_DEPLOYMENT_ID", "")
WORKER_TOKEN = os.getenv("V26_WORKER_TOKEN", "")
STOP_EVENT = threading.Event()
_BACKGROUND_STARTED = False
_BACKGROUND_LOCK = threading.Lock()
_DRAINING = False
_STARTED_AT = datetime.now(timezone.utc).isoformat()

MEDIA_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
    ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg",
    ".png", ".jpg", ".jpeg", ".webp", ".srt", ".ass", ".cube",
}
MEDIA_ROOTS = {
    "audioJobs": DATA_DIR / "jobs",
    "renderQueue": DATA_DIR / "video_queue",
    "proxyQueue": DATA_DIR / "video_proxy_queue",
    "pipelineQueue": DATA_DIR / "video_pipeline_queue",
    "orchestrator": DATA_DIR / "video_orchestrator",
    "reviews": DATA_DIR / "video_review",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ts() -> int:
    return int(time.time())


def _json(value, default=None):
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value or ""))
    except Exception:
        return {} if default is None else default


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _node_metadata() -> dict:
    return {
        "pid": os.getpid(),
        "railwayEnvironment": os.getenv("RAILWAY_ENVIRONMENT_NAME"),
        "railwayService": os.getenv("RAILWAY_SERVICE_NAME"),
        "railwayRegion": os.getenv("RAILWAY_REPLICA_REGION") or os.getenv("RAILWAY_REGION"),
    }


def _register_node(state: str = "ready") -> None:
    existing = identity.fetchone("SELECT id FROM v26_nodes WHERE id=?", (NODE_ID,))
    payload = json.dumps(_node_metadata(), ensure_ascii=False)
    if existing:
        identity.execute(
            "UPDATE v26_nodes SET hostname=?,instance_id=?,deployment_id=?,version='26',state=?,heartbeat_at=?,stopped_at=NULL,metadata_json=? WHERE id=?",
            (socket.gethostname(), INSTANCE_ID, DEPLOYMENT_ID, state, _now(), payload, NODE_ID),
        )
    else:
        identity.execute(
            "INSERT INTO v26_nodes(id,hostname,instance_id,deployment_id,version,state,started_at,heartbeat_at,stopped_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,NULL,?)",
            (NODE_ID, socket.gethostname(), INSTANCE_ID, DEPLOYMENT_ID, "26", state, _STARTED_AT, _now(), payload),
        )
    rel.event("node_registered", node_id=NODE_ID, details={"state": state, "deploymentId": DEPLOYMENT_ID})


def _heartbeat_node(state: str | None = None) -> None:
    if state:
        identity.execute("UPDATE v26_nodes SET heartbeat_at=?,state=? WHERE id=?", (_now(), state, NODE_ID))
    else:
        identity.execute("UPDATE v26_nodes SET heartbeat_at=? WHERE id=?", (_now(), NODE_ID))


def _settings() -> dict:
    return rel.get_settings()


def _maintenance() -> dict:
    settings = _settings()
    return {
        "enabled": bool(settings.get("maintenance.enabled", False)),
        "reason": str(settings.get("maintenance.reason", "") or ""),
        "draining": bool(_DRAINING),
    }


def _worker_actor(request: Request) -> dict:
    supplied = request.headers.get("x-maghrabi-worker-token", "")
    if WORKER_TOKEN and supplied and hmac.compare_digest(supplied, WORKER_TOKEN):
        return {"id": f"worker:{NODE_ID}", "name": NODE_ID, "role": "worker"}
    user, _session = v24._session_by_request(request)
    if user and user.get("role") == "admin":
        v24._csrf(request)
        return user
    legacy = v24._legacy_admin(request)
    if legacy:
        return legacy
    if not WORKER_TOKEN:
        raise HTTPException(status_code=503, detail="V26_WORKER_TOKEN غير مهيأ لخدمات Worker API.")
    raise HTTPException(status_code=401, detail="Worker token غير صالح.")


def _circuit_row(name: str) -> dict:
    row = identity.fetchone("SELECT * FROM v26_circuit_breakers WHERE name=?", (name,))
    if row:
        return row
    identity.execute(
        "INSERT INTO v26_circuit_breakers(name,state,failure_count,success_count,opened_at,retry_at,last_failure,updated_at) VALUES(?, 'closed',0,0,NULL,NULL,NULL,?)",
        (name, _now()),
    )
    return identity.fetchone("SELECT * FROM v26_circuit_breakers WHERE name=?", (name,)) or {}


def _circuit_public(row: dict) -> dict:
    return {
        "name": row.get("name"), "state": row.get("state"),
        "failureCount": int(row.get("failure_count") or 0), "successCount": int(row.get("success_count") or 0),
        "openedAt": row.get("opened_at"), "retryAt": row.get("retry_at"),
        "lastFailure": row.get("last_failure"), "updatedAt": row.get("updated_at"),
    }


def _circuit_allows(name: str | None) -> bool:
    if not name:
        return True
    row = _circuit_row(name)
    state = str(row.get("state") or "closed")
    if state == "closed":
        return True
    retry_at = int(row.get("retry_at") or 0)
    if state == "open" and retry_at and retry_at <= _now_ts():
        identity.execute("UPDATE v26_circuit_breakers SET state='half_open',updated_at=? WHERE name=?", (_now(), name))
        return True
    return state == "half_open"


def _record_circuit(name: str | None, success: bool, error: str | None = None) -> None:
    if not name:
        return
    row = _circuit_row(name)
    settings = _settings()
    threshold = max(1, int(settings.get("circuit.failureThreshold", 5) or 5))
    cooldown = max(10, int(settings.get("circuit.cooldownSeconds", 120) or 120))
    if success:
        identity.execute(
            "UPDATE v26_circuit_breakers SET state='closed',failure_count=0,success_count=?,opened_at=NULL,retry_at=NULL,last_failure=NULL,updated_at=? WHERE name=?",
            (int(row.get("success_count") or 0) + 1, _now(), name),
        )
        rel.event("circuit_success", node_id=NODE_ID, details={"circuit": name})
        return
    failures = int(row.get("failure_count") or 0) + 1
    state = "open" if failures >= threshold or str(row.get("state")) == "half_open" else "closed"
    retry_at = _now_ts() + cooldown if state == "open" else None
    identity.execute(
        "UPDATE v26_circuit_breakers SET state=?,failure_count=?,opened_at=?,retry_at=?,last_failure=?,updated_at=? WHERE name=?",
        (state, failures, _now() if state == "open" else row.get("opened_at"), retry_at, (error or "failure")[:1000], _now(), name),
    )
    rel.event("circuit_failure", severity="warning", node_id=NODE_ID, details={"circuit": name, "state": state, "failures": failures})


def _backoff_seconds(attempt: int) -> int:
    settings = _settings()
    base = max(1, int(settings.get("retry.baseSeconds", 30) or 30))
    maximum = max(base, int(settings.get("retry.maxSeconds", 900) or 900))
    exponent = max(0, min(12, attempt - 1))
    return min(maximum, base * (2 ** exponent))


def _lease_public(row: dict) -> dict:
    return {
        "jobKey": row.get("job_key"), "category": row.get("category"), "jobId": row.get("job_id"),
        "state": row.get("state"), "ownerNodeId": row.get("owner_node_id"),
        "acquiredAt": row.get("acquired_at"), "heartbeatAt": row.get("heartbeat_at"),
        "expiresAt": row.get("expires_at"), "attempt": int(row.get("attempt") or 0),
        "maxAttempts": int(row.get("max_attempts") or 0), "nextRetryAt": row.get("next_retry_at"),
        "idempotencyKey": row.get("idempotency_key"), "payloadChecksum": row.get("payload_checksum"),
        "resultChecksum": row.get("result_checksum"), "lastError": row.get("last_error"),
        "createdAt": row.get("created_at"), "updatedAt": row.get("updated_at"),
    }


def _dlq_public(row: dict) -> dict:
    return {
        "id": row.get("id"), "jobKey": row.get("job_key"), "category": row.get("category"),
        "jobId": row.get("job_id"), "attempts": int(row.get("attempts") or 0),
        "payload": _json(row.get("payload_json"), {}), "error": row.get("error"),
        "firstFailedAt": row.get("first_failed_at"), "lastFailedAt": row.get("last_failed_at"),
        "resolvedAt": row.get("resolved_at"), "resolution": row.get("resolution"),
    }


def _move_to_dlq(row: dict, error: str, payload: dict | None = None) -> dict:
    existing = identity.fetchone(
        "SELECT * FROM v26_dead_letters WHERE job_key=? AND resolved_at IS NULL ORDER BY last_failed_at DESC LIMIT 1",
        (row["job_key"],),
    )
    if existing:
        identity.execute(
            "UPDATE v26_dead_letters SET attempts=?,payload_json=?,error=?,last_failed_at=? WHERE id=?",
            (int(row.get("attempt") or 0), json.dumps(payload or {}, ensure_ascii=False), error[:2000], _now(), existing["id"]),
        )
        dlq_id = existing["id"]
    else:
        dlq_id = uuid.uuid4().hex[:18]
        identity.execute(
            "INSERT INTO v26_dead_letters(id,job_key,category,job_id,attempts,payload_json,error,first_failed_at,last_failed_at,resolved_at,resolution) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)",
            (dlq_id, row["job_key"], row["category"], row["job_id"], int(row.get("attempt") or 0),
             json.dumps(payload or {}, ensure_ascii=False), error[:2000], _now(), _now()),
        )
    identity.execute(
        "UPDATE v26_job_leases SET state='dlq',owner_node_id=NULL,lease_token_hash=NULL,expires_at=NULL,next_retry_at=NULL,last_error=?,updated_at=? WHERE job_key=?",
        (error[:2000], _now(), row["job_key"]),
    )
    rel.event("job_dead_lettered", severity="error", job_key=row["job_key"], node_id=NODE_ID, details={"dlqId": dlq_id, "error": error[:500]})
    return identity.fetchone("SELECT * FROM v26_dead_letters WHERE id=?", (dlq_id,)) or {}


def _fail_lease(row: dict, error: str, payload: dict | None = None, circuit: str | None = None) -> dict:
    attempt = int(row.get("attempt") or 0)
    max_attempts = int(row.get("max_attempts") or 3)
    _record_circuit(circuit, False, error)
    if attempt >= max_attempts:
        return {"state": "dlq", "dlq": _dlq_public(_move_to_dlq(row, error, payload))}
    delay = _backoff_seconds(attempt)
    next_retry = _now_ts() + delay
    identity.execute(
        "UPDATE v26_job_leases SET state='retry_wait',owner_node_id=NULL,lease_token_hash=NULL,expires_at=NULL,next_retry_at=?,last_error=?,updated_at=? WHERE job_key=?",
        (next_retry, error[:2000], _now(), row["job_key"]),
    )
    rel.event("job_retry_scheduled", severity="warning", job_key=row["job_key"], node_id=NODE_ID, details={"attempt": attempt, "nextRetryAt": next_retry})
    return {"state": "retry_wait", "nextRetryAt": next_retry, "delaySeconds": delay}


def _acquire_lease(payload: dict) -> dict:
    maintenance = _maintenance()
    if maintenance["enabled"] or maintenance["draining"]:
        raise HTTPException(status_code=503, detail="الخدمة في Maintenance/Draining ولا تستقبل Leases جديدة.")
    job_key = str(payload.get("jobKey") or "").strip()[:240]
    category = str(payload.get("category") or "managed")[:80]
    job_id = str(payload.get("jobId") or job_key)[:180]
    if not job_key:
        raise HTTPException(status_code=400, detail="jobKey مطلوب.")
    circuit = str(payload.get("circuit") or "").strip()[:100] or None
    if not _circuit_allows(circuit):
        raise HTTPException(status_code=503, detail=f"Circuit {circuit} مفتوح مؤقتًا.")
    settings = _settings()
    ttl = max(15, min(600, int(payload.get("ttlSeconds") or settings.get("lease.ttlSeconds", 60))))
    max_attempts = max(1, min(20, int(payload.get("maxAttempts") or settings.get("retry.maxAttempts", 3))))
    idempotency_key = str(payload.get("idempotencyKey") or "").strip()[:240] or None
    payload_checksum = str(payload.get("payloadChecksum") or "").strip()[:128] or None

    with rel.distributed_lock(f"lease:{job_key}") as acquired:
        if not acquired:
            raise HTTPException(status_code=409, detail="تعذر الحصول على distributed lock لهذه المهمة.")
        row = identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,))
        now = _now_ts()
        if row and row.get("state") == "completed":
            return {"replayed": True, "lease": _lease_public(row), "leaseToken": None}
        if row and row.get("state") == "active" and int(row.get("expires_at") or 0) > now:
            raise HTTPException(status_code=409, detail="المهمة مملوكة حاليًا لـWorker آخر.")
        if row and row.get("state") == "retry_wait" and int(row.get("next_retry_at") or 0) > now:
            raise HTTPException(status_code=425, detail="المهمة تنتظر Retry Backoff.")
        if row and row.get("state") == "dlq":
            raise HTTPException(status_code=409, detail="المهمة موجودة في Dead Letter Queue.")
        if idempotency_key:
            completed = identity.fetchone("SELECT * FROM v26_job_leases WHERE idempotency_key=? AND state='completed' ORDER BY updated_at DESC LIMIT 1", (idempotency_key,))
            if completed:
                return {"replayed": True, "lease": _lease_public(completed), "leaseToken": None}

        token = secrets.token_urlsafe(36)
        attempt = int(row.get("attempt") or 0) + 1 if row else 1
        expires = now + ttl
        if row:
            identity.execute(
                "UPDATE v26_job_leases SET category=?,job_id=?,state='active',owner_node_id=?,lease_token_hash=?,acquired_at=?,heartbeat_at=?,expires_at=?,attempt=?,max_attempts=?,next_retry_at=NULL,idempotency_key=?,payload_checksum=?,last_error=NULL,updated_at=? WHERE job_key=?",
                (category, job_id, NODE_ID, _hash(token), _now(), _now(), expires, attempt, max_attempts,
                 idempotency_key, payload_checksum, _now(), job_key),
            )
        else:
            identity.execute(
                "INSERT INTO v26_job_leases(job_key,category,job_id,state,owner_node_id,lease_token_hash,acquired_at,heartbeat_at,expires_at,attempt,max_attempts,next_retry_at,idempotency_key,payload_checksum,result_checksum,last_error,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?,?,?,?,NULL,?,?,NULL,NULL,?,?)",
                (job_key, category, job_id, NODE_ID, _hash(token), _now(), _now(), expires, attempt, max_attempts,
                 idempotency_key, payload_checksum, _now(), _now()),
            )
        fresh = identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,)) or {}
        rel.event("lease_acquired", job_key=job_key, node_id=NODE_ID, details={"attempt": attempt, "ttl": ttl})
        return {"replayed": False, "lease": _lease_public(fresh), "leaseToken": token}


def _verify_lease_token(job_key: str, token: str) -> dict:
    row = identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,))
    if not row or row.get("state") != "active":
        raise HTTPException(status_code=404, detail="Lease نشطة غير موجودة.")
    if row.get("owner_node_id") != NODE_ID:
        raise HTTPException(status_code=409, detail="هذه Lease مملوكة لـNode أخرى.")
    if not token or not hmac.compare_digest(str(row.get("lease_token_hash") or ""), _hash(token)):
        raise HTTPException(status_code=401, detail="Lease token غير صالح.")
    return row


def _recover_expired_leases() -> dict:
    now = _now_ts()
    rows = identity.fetchall("SELECT * FROM v26_job_leases WHERE state='active' AND expires_at IS NOT NULL AND expires_at<? ORDER BY expires_at LIMIT 100", (now,))
    retried = 0
    dead = 0
    for row in rows:
        with rel.distributed_lock(f"lease:{row['job_key']}") as acquired:
            if not acquired:
                continue
            fresh = identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (row["job_key"],))
            if not fresh or fresh.get("state") != "active" or int(fresh.get("expires_at") or 0) >= _now_ts():
                continue
            result = _fail_lease(fresh, "Lease heartbeat expired")
            if result["state"] == "dlq": dead += 1
            else: retried += 1
    return {"expired": len(rows), "retried": retried, "deadLettered": dead}


def _stale_nodes() -> list[dict]:
    stale_seconds = max(30, int(_settings().get("node.staleSeconds", 90) or 90))
    cutoff = datetime.fromtimestamp(time.time() - stale_seconds, tz=timezone.utc).isoformat()
    rows = identity.fetchall("SELECT * FROM v26_nodes WHERE heartbeat_at<? AND state NOT IN ('stopped','stale') ORDER BY heartbeat_at", (cutoff,))
    for row in rows:
        identity.execute("UPDATE v26_nodes SET state='stale' WHERE id=?", (row["id"],))
    return rows


def _background_loop() -> None:
    interval = max(5, min(30, int(_settings().get("lease.heartbeatSeconds", 15) or 15)))
    while not STOP_EVENT.wait(interval):
        try:
            _heartbeat_node("draining" if _DRAINING else "ready")
            with rel.distributed_lock("v26:housekeeping") as acquired:
                if acquired:
                    recovered = _recover_expired_leases()
                    stale = _stale_nodes()
                    if recovered["expired"] or stale:
                        rel.event("housekeeping", node_id=NODE_ID, details={"recovered": recovered, "staleNodes": len(stale)})
                    cutoff = _now_ts() - max(1, int(_settings().get("idempotency.ttlHours", 24) or 24)) * 3600
                    identity.execute("DELETE FROM v26_idempotency WHERE expires_at<?", (cutoff,))
        except Exception as exc:
            rel.event("housekeeping_error", severity="error", node_id=NODE_ID, details={"error": str(exc)[:1000]})


def _start_background() -> None:
    global _BACKGROUND_STARTED
    with _BACKGROUND_LOCK:
        if _BACKGROUND_STARTED:
            return
        _BACKGROUND_STARTED = True
        STOP_EVENT.clear()
        threading.Thread(target=_background_loop, daemon=True, name="v26-reliability-heartbeat").start()


def _ready_payload() -> dict:
    maintenance = _maintenance()
    schema = rel.schema_status()
    db_ok = True
    db_error = None
    try:
        identity.fetchone("SELECT 1 AS ok")
    except Exception as exc:
        db_ok = False
        db_error = str(exc)[:500]
    data_writable = False
    marker = DATA_DIR / ".v26-ready-check"
    try:
        marker.write_text(_now(), encoding="utf-8")
        marker.unlink(missing_ok=True)
        data_writable = True
    except Exception:
        data_writable = False
    settings = _settings()
    require_postgres = bool(settings.get("deployment.requirePostgresForReady", False))
    postgres_ok = identity.mode() == "postgresql" if require_postgres else True
    ready = db_ok and data_writable and schema["pending"] == 0 and not maintenance["enabled"] and not maintenance["draining"] and postgres_ok
    return {
        "ready": ready,
        "version": "26",
        "nodeId": NODE_ID,
        "maintenance": maintenance,
        "database": {"ok": db_ok, "mode": identity.mode(), "error": db_error},
        "schema": schema,
        "dataWritable": data_writable,
        "distributedSafe": identity.mode() == "postgresql",
        "requirePostgresForReady": require_postgres,
    }


def _legacy_reconciliation() -> dict:
    counts: dict[str, dict[str, int]] = {}
    samples: list[dict] = []
    managed_keys = {str(row["job_key"]) for row in identity.fetchall("SELECT job_key FROM v26_job_leases")}
    for category, path in v25._job_state_files():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        job_id = str(state.get("id") or path.parent.name)
        job_key = f"legacy:{category}:{job_id}"
        status = str(state.get("status") or "unknown").lower()
        bucket = counts.setdefault(category, {"total": 0, "managed": 0, "legacy": 0})
        bucket["total"] += 1
        if job_key in managed_keys:
            bucket["managed"] += 1
        else:
            bucket["legacy"] += 1
            if len(samples) < 50:
                samples.append({"category": category, "jobId": job_id, "status": status, "jobKey": job_key})
    return {"counts": counts, "legacySamples": samples}


def _checksum_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(4 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _relative_media_path(path: Path) -> str:
    resolved = path.resolve()
    data = DATA_DIR.resolve()
    if data != resolved and data not in resolved.parents:
        raise HTTPException(status_code=400, detail="المسار خارج DATA_DIR.")
    return str(resolved.relative_to(data))


def _media_scan(scope: str, limit: int) -> dict:
    root = MEDIA_ROOTS.get(scope)
    if not root:
        raise HTTPException(status_code=400, detail="Media scope غير مدعوم.")
    limit = max(1, min(200, limit))
    max_bytes = max(1, int(_settings().get("checksum.maxFileMb", 4096) or 4096)) * 1024 * 1024
    scanned: list[dict] = []
    skipped = 0
    if not root.exists():
        return {"scope": scope, "scanned": [], "skipped": 0}
    for path in root.rglob("*"):
        if len(scanned) >= limit:
            break
        if not path.is_file() or path.is_symlink() or path.suffix.lower() not in MEDIA_EXTENSIONS:
            continue
        try:
            stat = path.stat()
            if stat.st_size > max_bytes:
                skipped += 1
                continue
            relative = _relative_media_path(path)
            existing = identity.fetchone("SELECT * FROM v26_media_checksums WHERE path=?", (relative,))
            if existing and int(existing.get("size_bytes") or 0) == stat.st_size and int(existing.get("mtime_ns") or 0) == stat.st_mtime_ns:
                scanned.append({"id": existing["id"], "path": relative, "sha256": existing["sha256"], "cached": True, "sizeBytes": stat.st_size})
                continue
            sha = _checksum_file(path)
            item_id = existing["id"] if existing else uuid.uuid4().hex[:18]
            if existing:
                identity.execute("UPDATE v26_media_checksums SET size_bytes=?,mtime_ns=?,sha256=?,status='indexed',created_at=?,verified_at=NULL WHERE id=?", (stat.st_size, stat.st_mtime_ns, sha, _now(), item_id))
            else:
                identity.execute("INSERT INTO v26_media_checksums(id,path,size_bytes,mtime_ns,sha256,status,created_at,verified_at) VALUES(?,?,?,?,?,'indexed',?,NULL)", (item_id, relative, stat.st_size, stat.st_mtime_ns, sha, _now()))
            scanned.append({"id": item_id, "path": relative, "sha256": sha, "cached": False, "sizeBytes": stat.st_size})
        except Exception:
            skipped += 1
    rel.event("media_checksum_scan", node_id=NODE_ID, details={"scope": scope, "count": len(scanned), "skipped": skipped})
    return {"scope": scope, "scanned": scanned, "skipped": skipped}


def _verify_checksum(item_id: str) -> dict:
    row = identity.fetchone("SELECT * FROM v26_media_checksums WHERE id=?", (item_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Checksum record غير موجود.")
    path = (DATA_DIR / str(row["path"])).resolve()
    _relative_media_path(path)
    if not path.exists() or not path.is_file():
        identity.execute("UPDATE v26_media_checksums SET status='missing',verified_at=? WHERE id=?", (_now(), item_id))
        return {"id": item_id, "ok": False, "status": "missing"}
    stat = path.stat()
    sha = _checksum_file(path)
    ok = sha == row.get("sha256") and stat.st_size == int(row.get("size_bytes") or 0)
    status = "verified" if ok else "changed"
    identity.execute("UPDATE v26_media_checksums SET status=?,verified_at=? WHERE id=?", (status, _now(), item_id))
    rel.event("media_checksum_verified" if ok else "media_checksum_mismatch", severity="info" if ok else "error", node_id=NODE_ID, details={"id": item_id, "path": row["path"]})
    return {"id": item_id, "ok": ok, "status": status, "expected": row.get("sha256"), "actual": sha, "path": row.get("path")}


def _verify_backup(backup_id: str) -> dict:
    row = identity.fetchone("SELECT * FROM v25_backups WHERE id=?", (backup_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Backup غير موجود.")
    path = Path(str(row.get("file_path") or "")).resolve()
    backup_root = v25.BACKUP_DIR.resolve()
    if backup_root != path.parent or not path.exists():
        raise HTTPException(status_code=404, detail="Backup file غير موجود أو خارج مجلد النسخ المعتمد.")
    ok = False
    details: dict = {}
    manifest_hash = None
    decrypted_bytes = None
    try:
        encrypted = path.read_bytes()
        raw = v25._backup_fernet().decrypt(encrypted)
        decrypted_bytes = len(raw)
        payload = json.loads(raw.decode("utf-8"))
        tables = payload.get("tables") or {}
        details = {
            "format": payload.get("format"), "formatVersion": payload.get("formatVersion"),
            "createdAt": payload.get("createdAt"), "tableCounts": {name: len(rows) if isinstance(rows, list) else 0 for name, rows in tables.items()},
            "schema": payload.get("schema"), "includesMedia": bool((payload.get("notes") or {}).get("includesMedia", False)),
        }
        manifest_hash = hashlib.sha256(json.dumps(details, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        ok = payload.get("format") == "MAGHRABI-V25-CONTROL-PLANE" and int(payload.get("formatVersion", 0)) == 1 and isinstance(tables, dict)
    except Exception as exc:
        details = {"error": str(exc)[:1000]}
    verification_id = uuid.uuid4().hex[:18]
    identity.execute(
        "INSERT INTO v26_backup_verifications(id,backup_id,checked_at,ok,manifest_hash,decrypted_bytes,details_json) VALUES(?,?,?,?,?,?,?)",
        (verification_id, backup_id, _now(), 1 if ok else 0, manifest_hash, decrypted_bytes, json.dumps(details, ensure_ascii=False)),
    )
    rel.event("backup_verified" if ok else "backup_verification_failed", severity="info" if ok else "error", node_id=NODE_ID, details={"backupId": backup_id, "verificationId": verification_id})
    return {"id": verification_id, "backupId": backup_id, "ok": ok, "manifestHash": manifest_hash, "decryptedBytes": decrypted_bytes, "details": details}


def _pitr_readiness() -> dict:
    if identity.mode() != "postgresql":
        return {
            "eligible": False, "databaseMode": identity.mode(), "verified": False,
            "note": "PITR readiness requires PostgreSQL. SQLite does not provide WAL-based point-in-time recovery for this deployment model.",
        }
    output = {"eligible": True, "databaseMode": "postgresql", "verified": False}
    try:
        wal = identity.fetchone("SHOW wal_level") or {}
        archive = identity.fetchone("SHOW archive_mode") or {}
        recovery = identity.fetchone("SELECT pg_is_in_recovery() AS in_recovery") or {}
        version = identity.fetchone("SHOW server_version") or {}
        lsn = None
        try:
            lsn = identity.fetchone("SELECT pg_current_wal_lsn()::text AS lsn") or {}
        except Exception:
            lsn = {}
        output.update({
            "verified": True,
            "walLevel": next(iter(wal.values()), None),
            "archiveMode": next(iter(archive.values()), None),
            "inRecovery": recovery.get("in_recovery"),
            "serverVersion": next(iter(version.values()), None),
            "currentWalLsn": lsn.get("lsn"),
            "note": "هذه فحوص DB prerequisites فقط. توفر PITR والاحتفاظ بالنسخ التاريخية يعتمد على خدمة/خطة PostgreSQL في Railway ولا يثبت من هذه القيم وحدها.",
        })
    except Exception as exc:
        output.update({"verified": False, "error": str(exc)[:1000], "note": "تعذر قراءة بعض إعدادات PostgreSQL؛ لا يمكن اعتبار PITR جاهزًا من التطبيق وحده."})
    return output


def _overview() -> dict:
    now = _now_ts()
    nodes = identity.fetchall("SELECT * FROM v26_nodes ORDER BY heartbeat_at DESC LIMIT 50")
    leases = identity.fetchall("SELECT * FROM v26_job_leases ORDER BY updated_at DESC LIMIT 200")
    dlq = identity.fetchall("SELECT * FROM v26_dead_letters ORDER BY last_failed_at DESC LIMIT 100")
    circuits = identity.fetchall("SELECT * FROM v26_circuit_breakers ORDER BY name")
    checksums = identity.fetchall("SELECT * FROM v26_media_checksums ORDER BY created_at DESC LIMIT 100")
    verifications = identity.fetchall("SELECT * FROM v26_backup_verifications ORDER BY checked_at DESC LIMIT 50")
    idempotency = identity.fetchone("SELECT COUNT(*) AS total FROM v26_idempotency WHERE expires_at>?", (now,)) or {"total": 0}
    return {
        "version": "26", "generatedAt": _now(), "nodeId": NODE_ID,
        "schema": rel.schema_status(), "settings": _settings(), "maintenance": _maintenance(),
        "readiness": _ready_payload(), "pitr": _pitr_readiness(),
        "nodes": [{
            "id": row.get("id"), "hostname": row.get("hostname"), "instanceId": row.get("instance_id"),
            "deploymentId": row.get("deployment_id"), "state": row.get("state"), "startedAt": row.get("started_at"),
            "heartbeatAt": row.get("heartbeat_at"), "stoppedAt": row.get("stopped_at"), "metadata": _json(row.get("metadata_json"), {}),
        } for row in nodes],
        "leases": [_lease_public(row) for row in leases],
        "deadLetters": [_dlq_public(row) for row in dlq],
        "circuits": [_circuit_public(row) for row in circuits],
        "legacy": _legacy_reconciliation(),
        "checksums": [{
            "id": row.get("id"), "path": row.get("path"), "sizeBytes": row.get("size_bytes"),
            "sha256": row.get("sha256"), "status": row.get("status"), "createdAt": row.get("created_at"), "verifiedAt": row.get("verified_at"),
        } for row in checksums],
        "backupVerifications": [{
            "id": row.get("id"), "backupId": row.get("backup_id"), "checkedAt": row.get("checked_at"),
            "ok": bool(row.get("ok")), "manifestHash": row.get("manifest_hash"), "decryptedBytes": row.get("decrypted_bytes"),
            "details": _json(row.get("details_json"), {}),
        } for row in verifications],
        "idempotencyActive": int(idempotency.get("total") or 0),
        "workerTokenConfigured": bool(WORKER_TOKEN),
    }


def install_reliability(app) -> None:
    if getattr(app.state, "v26_reliability_installed", False):
        return
    app.state.v26_reliability_installed = True

    @app.middleware("http")
    async def v26_maintenance_middleware(request: Request, call_next):
        maintenance = _maintenance()
        path = request.url.path
        method = request.method.upper()
        production_mutation = False
        match = re.match(r"^/api/video/v(\d+)(?:/|$)", path)
        if match and int(match.group(1)) <= 21 and method not in {"GET", "HEAD", "OPTIONS"}:
            production_mutation = True
        if path.startswith("/api/tools") and method not in {"GET", "HEAD", "OPTIONS"}:
            production_mutation = True
        if path in {"/api/jobs", "/api/upload"} and method not in {"GET", "HEAD", "OPTIONS"}:
            production_mutation = True
        if production_mutation and (maintenance["enabled"] or maintenance["draining"]):
            return JSONResponse(
                status_code=503,
                content={"detail": "Production processing is temporarily unavailable during Maintenance/Draining.", "maintenance": maintenance},
                headers={"Retry-After": "30", "X-MAGHRABI-MAINTENANCE": "true"},
            )
        response = await call_next(request)
        if maintenance["enabled"]:
            response.headers["X-MAGHRABI-MAINTENANCE"] = "true"
        return response

    async def startup() -> None:
        rel.ensure_schema()
        _register_node("ready")
        _start_background()

    async def shutdown() -> None:
        global _DRAINING
        _DRAINING = True
        STOP_EVENT.set()
        try:
            _heartbeat_node("draining")
        except Exception:
            pass
        drain_seconds = max(0, min(120, int(_settings().get("shutdown.drainSeconds", 20) or 20)))
        deadline = time.time() + drain_seconds
        while time.time() < deadline:
            active = identity.fetchone("SELECT COUNT(*) AS count FROM v26_job_leases WHERE owner_node_id=? AND state='active'", (NODE_ID,)) or {"count": 0}
            if int(active.get("count") or 0) == 0:
                break
            await __import__("asyncio").sleep(0.5)
        try:
            identity.execute("UPDATE v26_nodes SET state='stopped',stopped_at=?,heartbeat_at=? WHERE id=?", (_now(), _now(), NODE_ID))
            rel.event("node_stopped", node_id=NODE_ID, details={"drainSeconds": drain_seconds})
        except Exception:
            pass

    app.add_event_handler("startup", startup)
    app.add_event_handler("shutdown", shutdown)


@router.get("/health/live")
async def live_v26() -> dict:
    return {"live": True, "version": "26", "nodeId": NODE_ID, "deploymentId": DEPLOYMENT_ID, "startedAt": _STARTED_AT}


@router.get("/health/ready")
async def ready_v26() -> JSONResponse:
    payload = _ready_payload()
    return JSONResponse(payload, status_code=200 if payload["ready"] else 503)


@router.get("/admin/overview")
async def overview_v26(admin: dict = Depends(v24.require_admin)) -> dict:
    return _overview()


@router.get("/admin/events")
async def events_v26(limit: int = Query(200, ge=1, le=1000), severity: str | None = Query(None), admin: dict = Depends(v24.require_admin)) -> dict:
    if severity:
        rows = identity.fetchall("SELECT * FROM v26_reliability_events WHERE severity=? ORDER BY created_at DESC LIMIT ?", (severity, limit))
    else:
        rows = identity.fetchall("SELECT * FROM v26_reliability_events ORDER BY created_at DESC LIMIT ?", (limit,))
    return {"events": [{
        "id": row.get("id"), "createdAt": row.get("created_at"), "eventType": row.get("event_type"),
        "jobKey": row.get("job_key"), "nodeId": row.get("node_id"), "severity": row.get("severity"),
        "details": _json(row.get("details_json"), {}),
    } for row in rows]}


@router.post("/admin/settings")
async def settings_v26(payload: dict = Body(...), admin: dict = Depends(v24.require_admin_write)) -> dict:
    values = dict(payload.get("settings") or payload)
    if "lease.ttlSeconds" in values: values["lease.ttlSeconds"] = max(15, min(600, int(values["lease.ttlSeconds"])))
    if "lease.heartbeatSeconds" in values: values["lease.heartbeatSeconds"] = max(5, min(120, int(values["lease.heartbeatSeconds"])))
    if "retry.maxAttempts" in values: values["retry.maxAttempts"] = max(1, min(20, int(values["retry.maxAttempts"])))
    if "shutdown.drainSeconds" in values: values["shutdown.drainSeconds"] = max(0, min(120, int(values["shutdown.drainSeconds"])))
    result = rel.set_settings(values)
    rel.event("reliability_settings_updated", node_id=NODE_ID, details={"keys": list(values)})
    return {"settings": result}


@router.post("/admin/maintenance")
async def maintenance_v26(payload: dict = Body(...), admin: dict = Depends(v24.require_admin_write)) -> dict:
    enabled = bool(payload.get("enabled"))
    reason = str(payload.get("reason") or "")[:500]
    with rel.distributed_lock("v26:maintenance", blocking=True) as acquired:
        if not acquired:
            raise HTTPException(status_code=409, detail="تعذر قفل حالة Maintenance.")
        rel.set_setting("maintenance.enabled", enabled)
        rel.set_setting("maintenance.reason", reason)
    rel.event("maintenance_enabled" if enabled else "maintenance_disabled", severity="warning" if enabled else "info", node_id=NODE_ID, details={"reason": reason, "actor": admin.get("id")})
    return _maintenance()


@router.post("/admin/reconcile")
async def reconcile_v26(admin: dict = Depends(v24.require_admin_write)) -> dict:
    recovered = _recover_expired_leases()
    stale = _stale_nodes()
    legacy = _legacy_reconciliation()
    rel.event("manual_reconcile", node_id=NODE_ID, details={"recovered": recovered, "staleNodes": len(stale)})
    return {"recovered": recovered, "staleNodes": len(stale), "legacy": legacy}


@router.post("/admin/circuits/{name}/reset")
async def reset_circuit_v26(name: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    name = name[:100]
    _circuit_row(name)
    identity.execute("UPDATE v26_circuit_breakers SET state='closed',failure_count=0,opened_at=NULL,retry_at=NULL,last_failure=NULL,updated_at=? WHERE name=?", (_now(), name))
    rel.event("circuit_reset", node_id=NODE_ID, details={"circuit": name})
    return _circuit_public(_circuit_row(name))


@router.post("/admin/circuits/{name}/open")
async def open_circuit_v26(name: str, payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    name = name[:100]
    cooldown = max(10, int(payload.get("cooldownSeconds") or _settings().get("circuit.cooldownSeconds", 120)))
    _circuit_row(name)
    identity.execute("UPDATE v26_circuit_breakers SET state='open',opened_at=?,retry_at=?,last_failure=?,updated_at=? WHERE name=?", (_now(), _now_ts() + cooldown, "Manually opened by admin", _now(), name))
    rel.event("circuit_opened_manual", severity="warning", node_id=NODE_ID, details={"circuit": name, "cooldown": cooldown})
    return _circuit_public(_circuit_row(name))


@router.post("/admin/dlq/{dlq_id}/retry")
async def retry_dlq_v26(dlq_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    row = identity.fetchone("SELECT * FROM v26_dead_letters WHERE id=?", (dlq_id,))
    if not row or row.get("resolved_at"):
        raise HTTPException(status_code=404, detail="DLQ item غير موجود أو تمت معالجته.")
    with rel.distributed_lock(f"lease:{row['job_key']}", blocking=True):
        identity.execute("UPDATE v26_job_leases SET state='retry_wait',attempt=0,next_retry_at=?,last_error=NULL,updated_at=? WHERE job_key=?", (_now_ts(), _now(), row["job_key"]))
        identity.execute("UPDATE v26_dead_letters SET resolved_at=?,resolution='retry_requested' WHERE id=?", (_now(), dlq_id))
    rel.event("dlq_retry_requested", job_key=row["job_key"], node_id=NODE_ID, details={"dlqId": dlq_id})
    return {"ok": True, "jobKey": row["job_key"]}


@router.post("/admin/dlq/{dlq_id}/resolve")
async def resolve_dlq_v26(dlq_id: str, payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    row = identity.fetchone("SELECT * FROM v26_dead_letters WHERE id=?", (dlq_id,))
    if not row or row.get("resolved_at"):
        raise HTTPException(status_code=404, detail="DLQ item غير موجود أو تمت معالجته.")
    resolution = str(payload.get("resolution") or "manually_resolved")[:500]
    identity.execute("UPDATE v26_dead_letters SET resolved_at=?,resolution=? WHERE id=?", (_now(), resolution, dlq_id))
    rel.event("dlq_resolved", job_key=row["job_key"], node_id=NODE_ID, details={"resolution": resolution})
    return {"ok": True}


@router.post("/admin/media/scan")
async def media_scan_v26(payload: dict = Body(...), admin: dict = Depends(v24.require_admin_write)) -> dict:
    return _media_scan(str(payload.get("scope") or "renderQueue"), int(payload.get("limit") or 25))


@router.post("/admin/media/{item_id}/verify")
async def media_verify_v26(item_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    return _verify_checksum(item_id)


@router.post("/admin/backups/{backup_id}/verify")
async def backup_verify_v26(backup_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    return _verify_backup(backup_id)


@router.get("/admin/pitr-readiness")
async def pitr_v26(admin: dict = Depends(v24.require_admin)) -> dict:
    return _pitr_readiness()


@router.post("/worker/leases/acquire")
async def acquire_v26(request: Request, payload: dict = Body(...)) -> dict:
    _worker_actor(request)
    return _acquire_lease(payload)


@router.post("/worker/leases/{job_key}/heartbeat")
async def heartbeat_v26(job_key: str, request: Request, payload: dict = Body(...)) -> dict:
    _worker_actor(request)
    token = str(payload.get("leaseToken") or "")
    row = _verify_lease_token(job_key, token)
    ttl = max(15, min(600, int(payload.get("ttlSeconds") or _settings().get("lease.ttlSeconds", 60))))
    expires = _now_ts() + ttl
    identity.execute("UPDATE v26_job_leases SET heartbeat_at=?,expires_at=?,updated_at=? WHERE job_key=?", (_now(), expires, _now(), job_key))
    return {"ok": True, "expiresAt": expires, "lease": _lease_public(identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,)) or row)}


@router.post("/worker/leases/{job_key}/complete")
async def complete_v26(job_key: str, request: Request, payload: dict = Body(...)) -> dict:
    _worker_actor(request)
    token = str(payload.get("leaseToken") or "")
    row = _verify_lease_token(job_key, token)
    result_checksum = str(payload.get("resultChecksum") or "").strip()[:128] or None
    circuit = str(payload.get("circuit") or "").strip()[:100] or None
    identity.execute("UPDATE v26_job_leases SET state='completed',result_checksum=?,heartbeat_at=?,expires_at=NULL,lease_token_hash=NULL,updated_at=? WHERE job_key=?", (result_checksum, _now(), _now(), job_key))
    _record_circuit(circuit, True)
    rel.event("job_completed", job_key=job_key, node_id=NODE_ID, details={"attempt": row.get("attempt"), "resultChecksum": result_checksum})
    return {"ok": True, "lease": _lease_public(identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,)) or row)}


@router.post("/worker/leases/{job_key}/fail")
async def fail_v26(job_key: str, request: Request, payload: dict = Body(...)) -> dict:
    _worker_actor(request)
    token = str(payload.get("leaseToken") or "")
    row = _verify_lease_token(job_key, token)
    error = str(payload.get("error") or "Worker failed")[:2000]
    circuit = str(payload.get("circuit") or "").strip()[:100] or None
    return _fail_lease(row, error, dict(payload.get("jobPayload") or {}), circuit)


@router.post("/worker/idempotency/begin")
async def idempotency_begin_v26(request: Request, payload: dict = Body(...)) -> dict:
    _worker_actor(request)
    key = str(payload.get("key") or "").strip()[:240]
    scope = str(payload.get("scope") or "default")[:100]
    request_hash = str(payload.get("requestHash") or "").strip()[:128]
    if not key or not request_hash:
        raise HTTPException(status_code=400, detail="key و requestHash مطلوبان.")
    settings = _settings()
    expires = _now_ts() + max(1, int(settings.get("idempotency.ttlHours", 24) or 24)) * 3600
    with rel.distributed_lock(f"idempotency:{key}") as acquired:
        if not acquired:
            raise HTTPException(status_code=409, detail="Idempotency lock مشغول.")
        row = identity.fetchone("SELECT * FROM v26_idempotency WHERE key=?", (key,))
        if row and int(row.get("expires_at") or 0) > _now_ts():
            if row.get("request_hash") != request_hash:
                raise HTTPException(status_code=409, detail="نفس Idempotency Key استُخدم مع طلب مختلف.")
            return {"replayed": row.get("status") == "completed", "status": row.get("status"), "response": _json(row.get("response_json"), None)}
        identity.execute("DELETE FROM v26_idempotency WHERE key=?", (key,))
        identity.execute("INSERT INTO v26_idempotency(key,scope,request_hash,status,response_json,created_at,updated_at,expires_at) VALUES(?,?,?,'running',NULL,?,?,?)", (key, scope, request_hash, _now(), _now(), expires))
        return {"replayed": False, "status": "running", "expiresAt": expires}


@router.post("/worker/idempotency/{key}/complete")
async def idempotency_complete_v26(key: str, request: Request, payload: dict = Body(...)) -> dict:
    _worker_actor(request)
    row = identity.fetchone("SELECT * FROM v26_idempotency WHERE key=?", (key,))
    if not row:
        raise HTTPException(status_code=404, detail="Idempotency record غير موجود.")
    response_payload = payload.get("response")
    identity.execute("UPDATE v26_idempotency SET status='completed',response_json=?,updated_at=? WHERE key=?", (json.dumps(response_payload, ensure_ascii=False), _now(), key))
    return {"ok": True}


@router.post("/worker/circuits/{name}/success")
async def circuit_success_v26(name: str, request: Request) -> dict:
    _worker_actor(request); _record_circuit(name[:100], True); return _circuit_public(_circuit_row(name[:100]))


@router.post("/worker/circuits/{name}/failure")
async def circuit_failure_v26(name: str, request: Request, payload: dict = Body(default={})) -> dict:
    _worker_actor(request); _record_circuit(name[:100], False, str(payload.get("error") or "failure")); return _circuit_public(_circuit_row(name[:100]))
