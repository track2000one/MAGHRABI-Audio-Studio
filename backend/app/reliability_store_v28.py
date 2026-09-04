from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone

from . import identity_store_v24 as identity
from . import reliability_store_v26 as rel

LATEST_SCHEMA_VERSION = 2


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ts() -> int:
    return int(time.time())


def _adapt(sql: str) -> str:
    return sql.replace("?", "%s") if identity.mode() == "postgresql" else sql


def ensure_schema() -> dict:
    with identity.connection() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS v28_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""")
    applied = {int(row["version"]) for row in identity.fetchall("SELECT version FROM v28_schema_migrations")}
    migrations = [
        (1, "chaos_runs_and_leader", _migration_1),
        (2, "chaos_indexes", _migration_2),
    ]
    new: list[int] = []
    for version, name, fn in migrations:
        if version in applied:
            continue
        with identity.connection() as conn:
            fn(conn)
            conn.execute(_adapt("INSERT INTO v28_schema_migrations(version,name,applied_at) VALUES(?,?,?)"), (version, name, _now()))
        new.append(version)
    return schema_status() | {"newlyApplied": new}


def _migration_1(conn) -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v28_leaders (
            scope TEXT PRIMARY KEY, node_id TEXT NOT NULL, epoch INTEGER NOT NULL,
            acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
            expires_at INTEGER NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v28_drills (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
            node_id TEXT NOT NULL, job_key TEXT, started_at TEXT NOT NULL,
            finished_at TEXT, primary_pid INTEGER, replacement_pid INTEGER,
            killed_at TEXT, takeover_at TEXT, completed_at TEXT,
            rto_ms INTEGER, recovery_ms INTEGER, duplicate_count INTEGER NOT NULL DEFAULT 0,
            lease_attempt INTEGER NOT NULL DEFAULT 0, error TEXT, details_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v28_execution_marks (
            id TEXT PRIMARY KEY, drill_id TEXT NOT NULL, worker_id TEXT NOT NULL,
            phase TEXT NOT NULL, created_at TEXT NOT NULL, details_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v28_commits (
            drill_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, committed_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v28_drain_checks (
            id TEXT PRIMARY KEY, node_id TEXT NOT NULL, state TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT, active_before INTEGER NOT NULL,
            active_after INTEGER, duration_ms INTEGER, details_json TEXT NOT NULL
        )""",
    ]
    for statement in statements:
        conn.execute(statement)


def _migration_2(conn) -> None:
    statements = [
        "CREATE INDEX IF NOT EXISTS idx_v28_drills_started ON v28_drills(started_at)",
        "CREATE INDEX IF NOT EXISTS idx_v28_drills_state ON v28_drills(state, started_at)",
        "CREATE INDEX IF NOT EXISTS idx_v28_marks_drill ON v28_execution_marks(drill_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v28_drain_started ON v28_drain_checks(started_at)",
    ]
    for statement in statements:
        conn.execute(statement)


def schema_status() -> dict:
    rows = identity.fetchall("SELECT version,name,applied_at FROM v28_schema_migrations ORDER BY version")
    current = int(rows[-1]["version"]) if rows else 0
    return {
        "current": current,
        "latest": LATEST_SCHEMA_VERSION,
        "pending": max(0, LATEST_SCHEMA_VERSION - current),
        "databaseMode": identity.mode(),
        "distributedSafe": identity.mode() == "postgresql",
        "applied": rows,
    }


def leader_tick(node_id: str, *, scope: str = "production", ttl: int = 15) -> dict:
    ttl = max(8, min(60, int(ttl)))
    now = _now_ts()
    with rel.distributed_lock(f"v28:leader:{scope}") as acquired:
        if not acquired:
            row = identity.fetchone("SELECT * FROM v28_leaders WHERE scope=?", (scope,))
            return leader_public(row, node_id)
        row = identity.fetchone("SELECT * FROM v28_leaders WHERE scope=?", (scope,))
        if not row:
            identity.execute(
                "INSERT INTO v28_leaders(scope,node_id,epoch,acquired_at,heartbeat_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (scope, node_id, 1, _now(), _now(), now + ttl, _now()),
            )
        elif str(row.get("node_id")) == node_id:
            identity.execute(
                "UPDATE v28_leaders SET heartbeat_at=?,expires_at=?,updated_at=? WHERE scope=?",
                (_now(), now + ttl, _now(), scope),
            )
        elif int(row.get("expires_at") or 0) <= now:
            identity.execute(
                "UPDATE v28_leaders SET node_id=?,epoch=?,acquired_at=?,heartbeat_at=?,expires_at=?,updated_at=? WHERE scope=?",
                (node_id, int(row.get("epoch") or 0) + 1, _now(), _now(), now + ttl, _now(), scope),
            )
        fresh = identity.fetchone("SELECT * FROM v28_leaders WHERE scope=?", (scope,))
        return leader_public(fresh, node_id)


def leader_public(row: dict | None, local_node_id: str | None = None) -> dict:
    if not row:
        return {"scope": "production", "nodeId": None, "epoch": 0, "expiresAt": None, "isLeader": False}
    return {
        "scope": row.get("scope"),
        "nodeId": row.get("node_id"),
        "epoch": int(row.get("epoch") or 0),
        "acquiredAt": row.get("acquired_at"),
        "heartbeatAt": row.get("heartbeat_at"),
        "expiresAt": row.get("expires_at"),
        "isLeader": bool(local_node_id and row.get("node_id") == local_node_id and int(row.get("expires_at") or 0) > _now_ts()),
    }


def release_leader(node_id: str, *, scope: str = "production") -> None:
    with rel.distributed_lock(f"v28:leader:{scope}") as acquired:
        if not acquired:
            return
        row = identity.fetchone("SELECT * FROM v28_leaders WHERE scope=?", (scope,))
        if row and str(row.get("node_id")) == node_id:
            identity.execute("UPDATE v28_leaders SET expires_at=?,heartbeat_at=?,updated_at=? WHERE scope=?", (_now_ts() - 1, _now(), _now(), scope))


def create_drill(kind: str, node_id: str, details: dict | None = None) -> dict:
    drill_id = uuid.uuid4().hex[:18]
    identity.execute(
        "INSERT INTO v28_drills(id,kind,state,node_id,job_key,started_at,finished_at,primary_pid,replacement_pid,killed_at,takeover_at,completed_at,rto_ms,recovery_ms,duplicate_count,lease_attempt,error,details_json) VALUES(?,?, 'queued', ?, NULL, ?, NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,NULL,?)",
        (drill_id, kind[:60], node_id, _now(), json.dumps(details or {}, ensure_ascii=False)),
    )
    return get_drill(drill_id) or {"id": drill_id}


def update_drill(drill_id: str, **values) -> dict:
    mapping = {
        "state": "state", "jobKey": "job_key", "finishedAt": "finished_at",
        "primaryPid": "primary_pid", "replacementPid": "replacement_pid",
        "killedAt": "killed_at", "takeoverAt": "takeover_at", "completedAt": "completed_at",
        "rtoMs": "rto_ms", "recoveryMs": "recovery_ms", "duplicateCount": "duplicate_count",
        "leaseAttempt": "lease_attempt", "error": "error", "details": "details_json",
    }
    assignments: list[str] = []
    params: list = []
    for key, value in values.items():
        column = mapping.get(key)
        if not column:
            continue
        assignments.append(f"{column}=?")
        params.append(json.dumps(value, ensure_ascii=False) if key == "details" else value)
    if assignments:
        params.append(drill_id)
        identity.execute(f"UPDATE v28_drills SET {','.join(assignments)} WHERE id=?", tuple(params))
    return get_drill(drill_id) or {"id": drill_id}


def _loads(value, default):
    try:
        return json.loads(str(value or ""))
    except Exception:
        return default


def drill_public(row: dict) -> dict:
    return {
        "id": row.get("id"), "kind": row.get("kind"), "state": row.get("state"),
        "nodeId": row.get("node_id"), "jobKey": row.get("job_key"),
        "startedAt": row.get("started_at"), "finishedAt": row.get("finished_at"),
        "primaryPid": row.get("primary_pid"), "replacementPid": row.get("replacement_pid"),
        "killedAt": row.get("killed_at"), "takeoverAt": row.get("takeover_at"),
        "completedAt": row.get("completed_at"), "rtoMs": row.get("rto_ms"),
        "recoveryMs": row.get("recovery_ms"), "duplicateCount": int(row.get("duplicate_count") or 0),
        "leaseAttempt": int(row.get("lease_attempt") or 0), "error": row.get("error"),
        "details": _loads(row.get("details_json"), {}),
    }


def get_drill(drill_id: str) -> dict | None:
    row = identity.fetchone("SELECT * FROM v28_drills WHERE id=?", (drill_id,))
    return drill_public(row) if row else None


def list_drills(limit: int = 30) -> list[dict]:
    rows = identity.fetchall("SELECT * FROM v28_drills ORDER BY started_at DESC LIMIT ?", (max(1, min(100, limit)),))
    return [drill_public(row) for row in rows]


def mark(drill_id: str, worker_id: str, phase: str, details: dict | None = None) -> None:
    identity.execute(
        "INSERT INTO v28_execution_marks(id,drill_id,worker_id,phase,created_at,details_json) VALUES(?,?,?,?,?,?)",
        (uuid.uuid4().hex[:18], drill_id, worker_id[:180], phase[:80], _now(), json.dumps(details or {}, ensure_ascii=False)),
    )


def marks(drill_id: str) -> list[dict]:
    rows = identity.fetchall("SELECT * FROM v28_execution_marks WHERE drill_id=? ORDER BY created_at", (drill_id,))
    return [{
        "id": row.get("id"), "drillId": row.get("drill_id"), "workerId": row.get("worker_id"),
        "phase": row.get("phase"), "createdAt": row.get("created_at"), "details": _loads(row.get("details_json"), {}),
    } for row in rows]


def try_commit(drill_id: str, worker_id: str) -> bool:
    try:
        identity.execute("INSERT INTO v28_commits(drill_id,worker_id,committed_at) VALUES(?,?,?)", (drill_id, worker_id[:180], _now()))
        return True
    except Exception:
        return False


def commit_count(drill_id: str) -> int:
    return int(identity.scalar("SELECT COUNT(*) AS count FROM v28_commits WHERE drill_id=?", (drill_id,), 0) or 0)


def live_nodes(stale_seconds: int = 90) -> list[dict]:
    cutoff = datetime.fromtimestamp(time.time() - max(30, stale_seconds), tz=timezone.utc).isoformat()
    rows = identity.fetchall("SELECT * FROM v26_nodes WHERE heartbeat_at>=? AND state NOT IN ('stopped','stale') ORDER BY heartbeat_at DESC", (cutoff,))
    return [{
        "id": row.get("id"), "state": row.get("state"), "heartbeatAt": row.get("heartbeat_at"),
        "deploymentId": row.get("deployment_id"), "instanceId": row.get("instance_id"),
        "hostname": row.get("hostname"),
    } for row in rows]


def create_drain_check(node_id: str, active_before: int, details: dict | None = None) -> str:
    check_id = uuid.uuid4().hex[:18]
    identity.execute(
        "INSERT INTO v28_drain_checks(id,node_id,state,started_at,finished_at,active_before,active_after,duration_ms,details_json) VALUES(?,?, 'running', ?,NULL,?,NULL,NULL,?)",
        (check_id, node_id, _now(), active_before, json.dumps(details or {}, ensure_ascii=False)),
    )
    return check_id


def finish_drain_check(check_id: str, state: str, active_after: int, duration_ms: int, details: dict | None = None) -> None:
    identity.execute(
        "UPDATE v28_drain_checks SET state=?,finished_at=?,active_after=?,duration_ms=?,details_json=? WHERE id=?",
        (state, _now(), active_after, duration_ms, json.dumps(details or {}, ensure_ascii=False), check_id),
    )


def latest_drain_checks(limit: int = 10) -> list[dict]:
    rows = identity.fetchall("SELECT * FROM v28_drain_checks ORDER BY started_at DESC LIMIT ?", (max(1, min(50, limit)),))
    return [{
        "id": row.get("id"), "nodeId": row.get("node_id"), "state": row.get("state"),
        "startedAt": row.get("started_at"), "finishedAt": row.get("finished_at"),
        "activeBefore": int(row.get("active_before") or 0), "activeAfter": row.get("active_after"),
        "durationMs": row.get("duration_ms"), "details": _loads(row.get("details_json"), {}),
    } for row in rows]


ensure_schema()
