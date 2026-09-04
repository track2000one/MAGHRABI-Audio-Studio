from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone

from . import identity_store_v24 as identity

LATEST_SCHEMA_VERSION = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _adapt(sql: str) -> str:
    return sql.replace("?", "%s") if identity.mode() == "postgresql" else sql


def _migration_1(conn) -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v29_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v29_settings (
            key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v29_capacity_samples (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, replica_count INTEGER NOT NULL,
            ffmpeg_active INTEGER NOT NULL, active_leases INTEGER NOT NULL, queued_jobs INTEGER NOT NULL,
            load1 REAL, cpu_count INTEGER NOT NULL, memory_percent REAL, disk_percent REAL,
            saturation_percent REAL NOT NULL, payload_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v29_load_tests (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT, duration_seconds REAL NOT NULL,
            concurrency INTEGER NOT NULL, operations INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0, p50_ms REAL, p95_ms REAL, p99_ms REAL,
            ops_per_second REAL, details_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v29_release_gates (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, version_label TEXT NOT NULL,
            state TEXT NOT NULL, score INTEGER NOT NULL, actor_id TEXT,
            blockers_json TEXT NOT NULL, warnings_json TEXT NOT NULL, metrics_json TEXT NOT NULL
        )""",
    ]
    for statement in statements:
        conn.execute(statement)


def _migration_2(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS v29_api_samples (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, route TEXT NOT NULL,
        method TEXT NOT NULL, status_code INTEGER NOT NULL, duration_ms REAL NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v29_api_created ON v29_api_samples(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v29_api_route ON v29_api_samples(route,created_at)")


def _migration_3(conn) -> None:
    statements = [
        "CREATE INDEX IF NOT EXISTS idx_v29_capacity_created ON v29_capacity_samples(created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v29_load_started ON v29_load_tests(started_at)",
        "CREATE INDEX IF NOT EXISTS idx_v29_gate_created ON v29_release_gates(created_at)",
    ]
    for statement in statements:
        conn.execute(statement)


MIGRATIONS = [
    (1, "slo_capacity_core", _migration_1),
    (2, "api_latency_samples", _migration_2),
    (3, "capacity_indexes", _migration_3),
]


DEFAULT_SETTINGS = {
    "window.hours": 24,
    "availability.targetPct": 99.5,
    "jobs.successTargetPct": 98.0,
    "jobs.renderP95Seconds": 900,
    "jobs.queueP95Seconds": 120,
    "api.p95Ms": 2500,
    "rto.targetMs": 60000,
    "samples.minJobs": 5,
    "samples.minApi": 20,
    "burn.fastThreshold": 2.0,
    "burn.slowThreshold": 1.0,
    "capacity.warnSaturationPct": 85,
    "capacity.blockSaturationPct": 95,
    "release.requireDistributedSafe": False,
    "release.requireMultiReplica": False,
    "retention.apiDays": 14,
    "retention.capacityDays": 30,
}


def ensure_schema() -> dict:
    with identity.connection() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS v29_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""")
    applied = {int(row["version"]) for row in identity.fetchall("SELECT version FROM v29_schema_migrations")}
    new: list[int] = []
    for version, name, fn in MIGRATIONS:
        if version in applied:
            continue
        with identity.connection() as conn:
            fn(conn)
            conn.execute(_adapt("INSERT INTO v29_schema_migrations(version,name,applied_at) VALUES(?,?,?)"), (version, name, _now()))
        new.append(version)
    seed_defaults()
    return schema_status() | {"newlyApplied": new}


def schema_status() -> dict:
    rows = identity.fetchall("SELECT version,name,applied_at FROM v29_schema_migrations ORDER BY version")
    current = int(rows[-1]["version"]) if rows else 0
    return {
        "current": current,
        "latest": LATEST_SCHEMA_VERSION,
        "pending": max(0, LATEST_SCHEMA_VERSION - current),
        "databaseMode": identity.mode(),
        "applied": rows,
    }


def seed_defaults() -> None:
    existing = {str(row["key"]) for row in identity.fetchall("SELECT key FROM v29_settings")}
    for key, value in DEFAULT_SETTINGS.items():
        if key not in existing:
            set_setting(key, value)


def set_setting(key: str, value) -> None:
    payload = json.dumps(value, ensure_ascii=False)
    now = _now()
    if identity.mode() == "postgresql":
        with identity.connection() as conn:
            conn.execute(
                "INSERT INTO v29_settings(key,value_json,updated_at) VALUES(%s,%s,%s) "
                "ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at",
                (key, payload, now),
            )
    else:
        with identity.connection() as conn:
            conn.execute(
                "INSERT INTO v29_settings(key,value_json,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                (key, payload, now),
            )


def get_settings() -> dict:
    values = dict(DEFAULT_SETTINGS)
    for row in identity.fetchall("SELECT key,value_json FROM v29_settings"):
        try:
            values[str(row["key"])] = json.loads(str(row["value_json"]))
        except Exception:
            pass
    return values


def set_settings(values: dict) -> dict:
    for key, value in values.items():
        if key in DEFAULT_SETTINGS:
            set_setting(key, value)
    return get_settings()


def add_api_sample(route: str, method: str, status_code: int, duration_ms: float) -> None:
    identity.execute(
        "INSERT INTO v29_api_samples(id,created_at,route,method,status_code,duration_ms) VALUES(?,?,?,?,?,?)",
        (uuid.uuid4().hex[:18], _now(), route[:240], method[:12], int(status_code), float(duration_ms)),
    )


def add_capacity_sample(payload: dict) -> str:
    sample_id = uuid.uuid4().hex[:18]
    identity.execute(
        "INSERT INTO v29_capacity_samples(id,created_at,replica_count,ffmpeg_active,active_leases,queued_jobs,load1,cpu_count,memory_percent,disk_percent,saturation_percent,payload_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            sample_id, _now(), int(payload.get("replicaCount") or 1), int(payload.get("ffmpegActive") or 0),
            int(payload.get("activeLeases") or 0), int(payload.get("queuedJobs") or 0), payload.get("load1"),
            int(payload.get("cpuCount") or 1), payload.get("memoryPercent"), payload.get("diskPercent"),
            float(payload.get("saturationPercent") or 0), json.dumps(payload, ensure_ascii=False),
        ),
    )
    return sample_id


def capacity_history(limit: int = 120) -> list[dict]:
    rows = identity.fetchall("SELECT * FROM v29_capacity_samples ORDER BY created_at DESC LIMIT ?", (max(1, min(500, limit)),))
    output = []
    for row in rows:
        try:
            payload = json.loads(str(row.get("payload_json") or "{}"))
        except Exception:
            payload = {}
        payload.update({"id": row.get("id"), "createdAt": row.get("created_at")})
        output.append(payload)
    return output


def create_load_test(kind: str, duration_seconds: float, concurrency: int, details: dict | None = None) -> dict:
    test_id = uuid.uuid4().hex[:18]
    identity.execute(
        "INSERT INTO v29_load_tests(id,kind,state,started_at,finished_at,duration_seconds,concurrency,operations,errors,p50_ms,p95_ms,p99_ms,ops_per_second,details_json) "
        "VALUES(?,?, 'running', ?,NULL,?,?,0,0,NULL,NULL,NULL,NULL,?)",
        (test_id, kind[:20], _now(), float(duration_seconds), int(concurrency), json.dumps(details or {}, ensure_ascii=False)),
    )
    return get_load_test(test_id) or {"id": test_id}


def finish_load_test(test_id: str, *, state: str, operations: int, errors: int, p50_ms: float | None, p95_ms: float | None,
                     p99_ms: float | None, ops_per_second: float | None, details: dict | None = None) -> dict:
    identity.execute(
        "UPDATE v29_load_tests SET state=?,finished_at=?,operations=?,errors=?,p50_ms=?,p95_ms=?,p99_ms=?,ops_per_second=?,details_json=? WHERE id=?",
        (state, _now(), int(operations), int(errors), p50_ms, p95_ms, p99_ms, ops_per_second, json.dumps(details or {}, ensure_ascii=False), test_id),
    )
    return get_load_test(test_id) or {"id": test_id}


def _load_public(row: dict) -> dict:
    try:
        details = json.loads(str(row.get("details_json") or "{}"))
    except Exception:
        details = {}
    return {
        "id": row.get("id"), "kind": row.get("kind"), "state": row.get("state"),
        "startedAt": row.get("started_at"), "finishedAt": row.get("finished_at"),
        "durationSeconds": float(row.get("duration_seconds") or 0), "concurrency": int(row.get("concurrency") or 0),
        "operations": int(row.get("operations") or 0), "errors": int(row.get("errors") or 0),
        "p50Ms": row.get("p50_ms"), "p95Ms": row.get("p95_ms"), "p99Ms": row.get("p99_ms"),
        "opsPerSecond": row.get("ops_per_second"), "details": details,
    }


def get_load_test(test_id: str) -> dict | None:
    row = identity.fetchone("SELECT * FROM v29_load_tests WHERE id=?", (test_id,))
    return _load_public(row) if row else None


def list_load_tests(limit: int = 20) -> list[dict]:
    return [_load_public(row) for row in identity.fetchall("SELECT * FROM v29_load_tests ORDER BY started_at DESC LIMIT ?", (max(1, min(100, limit)),))]


def add_release_gate(version_label: str, state: str, score: int, actor_id: str | None, blockers: list, warnings: list, metrics: dict) -> dict:
    gate_id = uuid.uuid4().hex[:18]
    identity.execute(
        "INSERT INTO v29_release_gates(id,created_at,version_label,state,score,actor_id,blockers_json,warnings_json,metrics_json) VALUES(?,?,?,?,?,?,?,?,?)",
        (gate_id, _now(), version_label[:100], state[:20], int(score), actor_id,
         json.dumps(blockers, ensure_ascii=False), json.dumps(warnings, ensure_ascii=False), json.dumps(metrics, ensure_ascii=False)),
    )
    return get_release_gate(gate_id) or {"id": gate_id}


def _gate_public(row: dict) -> dict:
    def load(name: str, default):
        try:
            return json.loads(str(row.get(name) or ""))
        except Exception:
            return default
    return {
        "id": row.get("id"), "createdAt": row.get("created_at"), "versionLabel": row.get("version_label"),
        "state": row.get("state"), "score": int(row.get("score") or 0), "actorId": row.get("actor_id"),
        "blockers": load("blockers_json", []), "warnings": load("warnings_json", []), "metrics": load("metrics_json", {}),
    }


def get_release_gate(gate_id: str) -> dict | None:
    row = identity.fetchone("SELECT * FROM v29_release_gates WHERE id=?", (gate_id,))
    return _gate_public(row) if row else None


def release_gate_history(limit: int = 20) -> list[dict]:
    return [_gate_public(row) for row in identity.fetchall("SELECT * FROM v29_release_gates ORDER BY created_at DESC LIMIT ?", (max(1, min(100, limit)),))]


def cleanup(retention_api_days: int, retention_capacity_days: int) -> dict:
    from datetime import timedelta
    api_cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, retention_api_days))).isoformat()
    capacity_cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, retention_capacity_days))).isoformat()
    api_before = int(identity.scalar("SELECT COUNT(*) AS count FROM v29_api_samples", default=0) or 0)
    cap_before = int(identity.scalar("SELECT COUNT(*) AS count FROM v29_capacity_samples", default=0) or 0)
    identity.execute("DELETE FROM v29_api_samples WHERE created_at<?", (api_cutoff,))
    identity.execute("DELETE FROM v29_capacity_samples WHERE created_at<?", (capacity_cutoff,))
    api_after = int(identity.scalar("SELECT COUNT(*) AS count FROM v29_api_samples", default=0) or 0)
    cap_after = int(identity.scalar("SELECT COUNT(*) AS count FROM v29_capacity_samples", default=0) or 0)
    return {"apiDeleted": max(0, api_before - api_after), "capacityDeleted": max(0, cap_before - cap_after)}


ensure_schema()
