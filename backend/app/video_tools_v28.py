from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse, PlainTextResponse

from . import identity_store_v24 as identity
from . import reliability_store_v26 as rel26
from . import reliability_store_v28 as store
from . import video_tools_v24 as v24
from . import video_tools_v27 as v27
from .video_tools_v26_runtime import base as v26

router = APIRouter(prefix="/api/video/v28", tags=["video-studio-v28"])

_STOP = threading.Event()
_STARTED = False
_START_LOCK = threading.Lock()
_DRILL_LOCK = threading.Lock()
_LAST_LEADER: dict = {}


def _now() -> str:
    return v26._now()


def _lease(job_key: str) -> dict | None:
    return identity.fetchone("SELECT * FROM v26_job_leases WHERE job_key=?", (job_key,))


def _active_for_node(node_id: str) -> list[dict]:
    return identity.fetchall("SELECT * FROM v26_job_leases WHERE owner_node_id=? AND state='active' ORDER BY acquired_at", (node_id,))


def _spawn_heartbeat_worker(*, drill_id: str, job_key: str, token: str, worker_id: str, ttl: int, phase: str, work_seconds: float = 3.0) -> subprocess.Popen:
    env = os.environ.copy()
    env.update({
        "V28_MODE": "heartbeat",
        "V28_DRILL_ID": drill_id,
        "V28_JOB_KEY": job_key,
        "V28_LEASE_TOKEN": token,
        "V28_WORKER_ID": worker_id,
        "V28_TTL": str(ttl),
        "V28_PHASE": phase,
        "V28_WORK_SECONDS": str(work_seconds),
    })
    return subprocess.Popen(
        [sys.executable, "-m", "app.chaos_worker_v28"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _acquire_drill(job_key: str, drill_id: str, worker_id: str, *, ttl: int, max_attempts: int = 3) -> dict:
    checksum = hashlib.sha256(f"{job_key}:{drill_id}".encode("utf-8")).hexdigest()
    return v26._acquire_lease({
        "jobKey": job_key,
        "category": "v28-real-chaos",
        "jobId": drill_id,
        "workerId": worker_id,
        "ttlSeconds": ttl,
        "maxAttempts": max_attempts,
        "idempotencyKey": job_key,
        "payloadChecksum": checksum,
    })


def _complete_token(job_key: str, token: str) -> None:
    v26._verify_lease_token(job_key, token)
    identity.execute(
        "UPDATE v26_job_leases SET state='completed',heartbeat_at=?,expires_at=NULL,lease_token_hash=NULL,next_retry_at=NULL,updated_at=? WHERE job_key=?",
        (_now(), _now(), job_key),
    )
    rel26.event("v28_drill_lease_completed", job_key=job_key, node_id=v26.NODE_ID, details={})


def _wait_until(predicate, timeout: float, interval: float = .25) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _real_kill_drill(drill_id: str, fast: bool) -> None:
    primary: subprocess.Popen | None = None
    replacement: subprocess.Popen | None = None
    token1: str | None = None
    token2: str | None = None
    try:
        ttl = 15
        job_key = f"v28:real-kill:{drill_id}"
        primary_worker = f"{v26.NODE_ID}:chaos-primary:{drill_id}"
        replacement_worker = f"{v26.NODE_ID}:chaos-replacement:{drill_id}"
        store.update_drill(drill_id, state="acquiring", jobKey=job_key, details={"fast": fast, "ttlSeconds": ttl, "policyBackoff": not fast})

        result1 = _acquire_drill(job_key, drill_id, primary_worker, ttl=ttl, max_attempts=3)
        token1 = result1.get("leaseToken")
        if not token1:
            raise RuntimeError("تعذر الحصول على Lease للـPrimary chaos worker.")
        row1 = _lease(job_key) or {}
        store.update_drill(drill_id, state="primary-running", leaseAttempt=int(row1.get("attempt") or 1))

        primary = _spawn_heartbeat_worker(
            drill_id=drill_id, job_key=job_key, token=token1,
            worker_id=primary_worker, ttl=ttl, phase="primary",
        )
        store.update_drill(drill_id, primaryPid=primary.pid)
        started = _wait_until(lambda: any(item["phase"] == "heartbeat" for item in store.marks(drill_id)), 8)
        if not started:
            raise RuntimeError("Primary subprocess لم يبدأ Heartbeat ضمن المهلة.")

        time.sleep(1.0)
        primary.kill()  # SIGKILL on Railway/Linux; API process remains alive.
        primary.wait(timeout=5)
        killed_at = _now()
        killed_mono = time.monotonic()
        store.mark(drill_id, primary_worker, "process_sigkill", {"pid": primary.pid, "returnCode": primary.returncode})
        store.update_drill(drill_id, state="waiting-lease-expiry", killedAt=killed_at)

        # V26 recovery uses expires_at < now, so wait until the TTL is strictly
        # behind the current second rather than merely equal to it.
        expired = _wait_until(lambda: int((_lease(job_key) or {}).get("expires_at") or 0) < int(time.time()), ttl + 10, .5)
        if not expired:
            raise RuntimeError("Lease لم تنتهِ بعد قتل Primary worker.")
        v26._recover_expired_leases()
        row = _lease(job_key) or {}
        if row.get("state") != "retry_wait":
            raise RuntimeError(f"الحالة بعد Lease expiry غير متوقعة: {row.get('state')}")

        if fast:
            identity.execute("UPDATE v26_job_leases SET next_retry_at=?,updated_at=? WHERE job_key=? AND state='retry_wait'", (int(time.time()) + 1, _now(), job_key))
            store.mark(drill_id, "controller", "backoff_accelerated", {"reason": "fast lab drill"})

        store.update_drill(drill_id, state="retry-backoff")
        due = _wait_until(lambda: int((_lease(job_key) or {}).get("next_retry_at") or 0) <= int(time.time()), 45 if fast else 180, .5)
        if not due:
            raise RuntimeError("Retry Backoff لم ينتهِ ضمن المهلة.")

        result2 = _acquire_drill(job_key, drill_id, replacement_worker, ttl=ttl, max_attempts=3)
        token2 = result2.get("leaseToken")
        if not token2:
            raise RuntimeError("Replacement worker لم يستطع الاستحواذ على Lease.")
        takeover_at = _now()
        takeover_mono = time.monotonic()
        row2 = _lease(job_key) or {}
        rto_ms = int((takeover_mono - killed_mono) * 1000)
        store.update_drill(drill_id, state="replacement-running", takeoverAt=takeover_at, rtoMs=rto_ms, leaseAttempt=int(row2.get("attempt") or 2))

        replacement = _spawn_heartbeat_worker(
            drill_id=drill_id, job_key=job_key, token=token2,
            worker_id=replacement_worker, ttl=ttl, phase="replacement", work_seconds=2.0,
        )
        store.update_drill(drill_id, replacementPid=replacement.pid)
        try:
            replacement.wait(timeout=15)
        except subprocess.TimeoutExpired:
            replacement.kill()
            replacement.wait(timeout=5)
            raise RuntimeError("Replacement worker تجاوز مهلة التنفيذ.")
        if replacement.returncode != 0:
            raise RuntimeError(f"Replacement worker فشل برمز {replacement.returncode}.")

        _complete_token(job_key, token2)
        commits = store.commit_count(drill_id)
        duplicates = max(0, commits - 1)
        completed_at = _now()
        recovery_ms = int((time.monotonic() - killed_mono) * 1000)
        passed = commits == 1 and duplicates == 0 and int(row2.get("attempt") or 0) >= 2
        store.update_drill(
            drill_id,
            state="passed" if passed else "failed",
            finishedAt=completed_at,
            completedAt=completed_at,
            recoveryMs=recovery_ms,
            duplicateCount=duplicates,
            details={
                "fast": fast, "ttlSeconds": ttl, "commitCount": commits,
                "primaryReturnCode": primary.returncode if primary else None,
                "replacementReturnCode": replacement.returncode if replacement else None,
                "leaseState": (_lease(job_key) or {}).get("state"),
                "rtoDefinition": "time from SIGKILL to replacement lease takeover",
                "recoveryDefinition": "time from SIGKILL to replacement result committed",
            },
        )
        rel26.event("v28_real_worker_kill_drill", severity="info" if passed else "error", node_id=v26.NODE_ID, job_key=job_key, details={"drillId": drill_id, "passed": passed, "rtoMs": rto_ms, "recoveryMs": recovery_ms, "duplicates": duplicates})
    except Exception as exc:
        for process in (primary, replacement):
            if process is not None and process.poll() is None:
                try:
                    process.kill(); process.wait(timeout=3)
                except Exception:
                    pass
        store.update_drill(drill_id, state="failed", finishedAt=_now(), error=str(exc)[:2000], details={"fast": fast})
        rel26.event("v28_real_worker_kill_drill_failed", severity="error", node_id=v26.NODE_ID, details={"drillId": drill_id, "error": str(exc)[:1000]})
    finally:
        _DRILL_LOCK.release()


def _duplicate_contest(drill_id: str, contenders: int) -> None:
    processes: list[subprocess.Popen] = []
    try:
        job_key = f"v28:duplicate:{drill_id}"
        start_at = time.time() + 1.25
        store.update_drill(drill_id, state="contending", jobKey=job_key, details={"contenders": contenders})
        for index in range(contenders):
            env = os.environ.copy()
            env.update({
                "V28_MODE": "contend", "V28_DRILL_ID": drill_id, "V28_JOB_KEY": job_key,
                "V28_WORKER_ID": f"{v26.NODE_ID}:contender:{index}:{drill_id}", "V28_START_AT": str(start_at),
            })
            processes.append(subprocess.Popen(
                [sys.executable, "-m", "app.chaos_worker_v28"], env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            ))
        for process in processes:
            process.wait(timeout=15)
        marks = store.marks(drill_id)
        winners = sum(1 for item in marks if item["phase"] == "lease_won")
        rejected = sum(1 for item in marks if item["phase"] in {"lease_rejected", "lease_replayed"})
        commits = store.commit_count(drill_id)
        duplicates = max(0, commits - 1)
        passed = winners == 1 and commits == 1 and duplicates == 0 and winners + rejected >= contenders
        store.update_drill(
            drill_id, state="passed" if passed else "failed", finishedAt=_now(), completedAt=_now(),
            duplicateCount=duplicates, details={"contenders": contenders, "winners": winners, "rejectedOrReplayed": rejected, "commitCount": commits},
        )
        rel26.event("v28_duplicate_contest", severity="info" if passed else "error", node_id=v26.NODE_ID, job_key=job_key, details={"drillId": drill_id, "passed": passed, "winners": winners, "commits": commits})
    except Exception as exc:
        for process in processes:
            if process.poll() is None:
                try:
                    process.kill(); process.wait(timeout=2)
                except Exception:
                    pass
        store.update_drill(drill_id, state="failed", finishedAt=_now(), error=str(exc)[:2000])
    finally:
        _DRILL_LOCK.release()


def _leader_loop() -> None:
    global _LAST_LEADER
    while not _STOP.wait(4.0):
        try:
            _LAST_LEADER = store.leader_tick(v26.NODE_ID, scope="production", ttl=15)
        except Exception as exc:
            rel26.event("v28_leader_tick_failed", severity="error", node_id=v26.NODE_ID, details={"error": str(exc)[:500]})


def _recover_interrupted_drills() -> None:
    rows = identity.fetchall("SELECT id,state FROM v28_drills WHERE state NOT IN ('passed','failed','interrupted')")
    for row in rows:
        store.update_drill(str(row["id"]), state="interrupted", finishedAt=_now(), error="Service restarted while drill was running.")


def install_v28(app) -> None:
    global _STARTED, _LAST_LEADER
    with _START_LOCK:
        if _STARTED:
            return
        _STARTED = True

    async def startup() -> None:
        _STOP.clear()
        _recover_interrupted_drills()
        try:
            _LAST_LEADER = store.leader_tick(v26.NODE_ID, scope="production", ttl=15)
        except Exception:
            pass
        threading.Thread(target=_leader_loop, daemon=True, name="v28-leader-election").start()

    async def shutdown() -> None:
        _STOP.set()
        try:
            store.release_leader(v26.NODE_ID, scope="production")
        except Exception:
            pass

    app.add_event_handler("startup", startup)
    app.add_event_handler("shutdown", shutdown)


def _overview() -> dict:
    nodes = store.live_nodes(int(rel26.get_settings().get("node.staleSeconds", 90) or 90))
    leader = store.leader_public(identity.fetchone("SELECT * FROM v28_leaders WHERE scope='production'"), v26.NODE_ID)
    drills = store.list_drills(30)
    kill_drills = [item for item in drills if item["kind"] == "worker-kill"]
    passed_kills = [item for item in kill_drills if item["state"] == "passed"]
    last_rto = passed_kills[0].get("rtoMs") if passed_kills else None
    v27_overview = v27._overview()
    multi = len(nodes) >= 2
    distributed = identity.mode() == "postgresql"
    leader_healthy = bool(leader.get("nodeId")) and int(leader.get("expiresAt") or 0) > int(time.time())
    ready = bool(v27_overview.get("managedReady")) and store.schema_status()["pending"] == 0 and leader_healthy
    return {
        "version": "28", "generatedAt": _now(), "nodeId": v26.NODE_ID,
        "ready": ready, "databaseMode": identity.mode(), "distributedSafe": distributed,
        "multiReplicaObserved": multi, "replicaCount": len(nodes), "nodes": nodes,
        "leader": leader, "schema": store.schema_status(), "v27": {
            "managedReady": v27_overview.get("managedReady"),
            "coverage": v27_overview.get("coverage"),
        },
        "drills": drills, "lastRtoMs": last_rto, "drainChecks": store.latest_drain_checks(),
        "capabilities": {
            "realWorkerSigkill": os.name == "posix",
            "duplicateProcessContest": True,
            "leaderElection": True,
            "multiReplicaValidation": distributed,
            "drainSimulation": distributed and multi,
        },
        "targets": {"rtoMs": 60000, "duplicateCommits": 0, "leaderTtlSeconds": 15},
    }


@router.get("/health/live")
async def live_v28() -> dict:
    return {"live": True, "version": "28", "nodeId": v26.NODE_ID}


@router.get("/health/ready")
async def ready_v28() -> JSONResponse:
    payload = _overview()
    return JSONResponse(payload, status_code=200 if payload["ready"] else 503)


@router.get("/admin/overview")
async def overview_v28(admin: dict = Depends(v24.require_admin)) -> dict:
    return _overview()


@router.post("/admin/worker-kill-drill")
async def worker_kill_drill_v28(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    if os.name != "posix":
        raise HTTPException(status_code=501, detail="SIGKILL drill يحتاج Linux/POSIX runtime.")
    if not _DRILL_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="يوجد Chaos Drill آخر قيد التنفيذ على هذه Replica.")
    fast = bool(payload.get("fast", False))
    drill = store.create_drill("worker-kill", v26.NODE_ID, {"fast": fast, "actor": admin.get("id")})
    threading.Thread(target=_real_kill_drill, args=(str(drill["id"]), fast), daemon=True, name=f"v28-kill-{drill['id']}").start()
    return store.get_drill(str(drill["id"])) or drill


@router.post("/admin/duplicate-contest")
async def duplicate_contest_v28(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    if not _DRILL_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="يوجد Chaos Drill آخر قيد التنفيذ على هذه Replica.")
    contenders = max(2, min(8, int(payload.get("contenders", 4) or 4)))
    drill = store.create_drill("duplicate-contest", v26.NODE_ID, {"contenders": contenders, "actor": admin.get("id")})
    threading.Thread(target=_duplicate_contest, args=(str(drill["id"]), contenders), daemon=True, name=f"v28-duplicate-{drill['id']}").start()
    return store.get_drill(str(drill["id"])) or drill


@router.post("/admin/drain-simulation")
def drain_simulation_v28(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    nodes = store.live_nodes(int(rel26.get_settings().get("node.staleSeconds", 90) or 90))
    if identity.mode() != "postgresql":
        raise HTTPException(status_code=409, detail="Drain simulation المتعددة تحتاج PostgreSQL Distributed State.")
    if len(nodes) < 2:
        raise HTTPException(status_code=409, detail="يلزم وجود Replica ثانية حية قبل Drain Simulation حتى لا نقطع الخدمة الوحيدة.")
    seconds = max(3, min(20, int(payload.get("seconds", 10) or 10)))
    before = len(_active_for_node(v26.NODE_ID))
    check_id = store.create_drain_check(v26.NODE_ID, before, {"actor": admin.get("id"), "seconds": seconds})
    started = time.monotonic()
    old = bool(v26._DRAINING)
    try:
        v26._DRAINING = True
        v26._heartbeat_node("draining")
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and _active_for_node(v26.NODE_ID):
            time.sleep(.25)
        after = len(_active_for_node(v26.NODE_ID))
        state = "passed" if after == 0 else "timeout"
        duration = int((time.monotonic() - started) * 1000)
        store.finish_drain_check(check_id, state, after, duration, {"before": before, "after": after, "maxSeconds": seconds})
        rel26.event("v28_drain_simulation", severity="info" if after == 0 else "warning", node_id=v26.NODE_ID, details={"checkId": check_id, "before": before, "after": after, "durationMs": duration})
        return {"id": check_id, "state": state, "activeBefore": before, "activeAfter": after, "durationMs": duration}
    finally:
        v26._DRAINING = old
        v26._heartbeat_node("draining" if old else "ready")


def _runbook_markdown() -> str:
    overview = _overview()
    leader = overview["leader"]
    return f"""# MAGHRABI Video Studio V28 Disaster Recovery Runbook

Generated: {overview['generatedAt']}

## Current readiness
- V28 ready: {overview['ready']}
- Database: {overview['databaseMode']}
- Distributed safe: {overview['distributedSafe']}
- Live replicas: {overview['replicaCount']}
- Leader: {leader.get('nodeId') or 'none'}
- Leader epoch: {leader.get('epoch', 0)}
- V27 managed ready: {overview['v27'].get('managedReady')}
- Last measured worker-kill RTO: {overview.get('lastRtoMs') or 'not measured'} ms

## Incident sequence
1. Check `/api/video/v28/health/ready` and `/api/video/v26/health/ready`.
2. Confirm PostgreSQL is healthy and Distributed Safe is true before multi-replica recovery.
3. Inspect V27 managed leases, Retry Wait and DLQ.
4. Confirm exactly one V28 leader and review leader epoch/heartbeat.
5. If a worker died, wait for lease expiry and automatic Retry; do not manually duplicate the job.
6. If retries are exhausted, inspect DLQ, fix the cause, then retry the individual job.
7. Verify output checksum/media integrity before approving recovered delivery.
8. During deployment, drain one replica at a time; never drain the only live replica.
9. Run Backup Verification from V26/V25 before any destructive restore.
10. Record RTO, duplicate count, affected job ids and final validation in the incident report.

## Acceptance targets
- Duplicate committed outputs: 0
- Managed active-unmanaged jobs: 0
- Leader count: 1
- Worker kill recovery RTO target: <= 60000 ms
- Final recovered media checksum: verified when baseline exists

## Railway configuration prerequisites
- Persistent `/data` volume for state/media that must survive redeploys.
- PostgreSQL `DATABASE_URL` for distributed locks and multi-replica coordination.
- Health check should use `/api/video/v28/health/ready` after V28 runtime validation.
- Keep `AUTH_SECRET` stable across replicas/deployments.
"""


@router.get("/admin/runbook")
async def runbook_v28(admin: dict = Depends(v24.require_admin)) -> PlainTextResponse:
    return PlainTextResponse(
        _runbook_markdown(),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="MAGHRABI-V28-DR-Runbook.md"'},
    )
