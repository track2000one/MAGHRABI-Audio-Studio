from __future__ import annotations

import hashlib
import json
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from . import identity_store_v24 as identity

LATEST_SCHEMA_VERSION = 4
_LOCAL_LOCKS: dict[str, threading.RLock] = {}
_LOCAL_LOCKS_GUARD = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _adapt(sql: str) -> str:
    return sql.replace("?", "%s") if identity.mode() == "postgresql" else sql


def _migration_1(conn) -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v26_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v26_settings (
            key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v26_nodes (
            id TEXT PRIMARY KEY, hostname TEXT NOT NULL, instance_id TEXT,
            deployment_id TEXT, version TEXT NOT NULL, state TEXT NOT NULL,
            started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, stopped_at TEXT,
            metadata_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v26_job_leases (
            job_key TEXT PRIMARY KEY, category TEXT NOT NULL, job_id TEXT NOT NULL,
            state TEXT NOT NULL, owner_node_id TEXT, lease_token_hash TEXT,
            acquired_at TEXT, heartbeat_at TEXT, expires_at INTEGER,
            attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
            next_retry_at INTEGER, idempotency_key TEXT, payload_checksum TEXT,
            result_checksum TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v26_dead_letters (
            id TEXT PRIMARY KEY, job_key TEXT NOT NULL, category TEXT NOT NULL, job_id TEXT NOT NULL,
            attempts INTEGER NOT NULL, payload_json TEXT NOT NULL, error TEXT NOT NULL,
            first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL,
            resolved_at TEXT, resolution TEXT
        )""",
    ]
    for statement in statements:
        conn.execute(statement)


def _migration_2(conn) -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v26_circuit_breakers (
            name TEXT PRIMARY KEY, state TEXT NOT NULL, failure_count INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0, opened_at TEXT, retry_at INTEGER,
            last_failure TEXT, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v26_idempotency (
            key TEXT PRIMARY KEY, scope TEXT NOT NULL, request_hash TEXT NOT NULL,
            status TEXT NOT NULL, response_json TEXT, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, expires_at INTEGER NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v26_media_checksums (
            id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL, verified_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v26_backup_verifications (
            id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, checked_at TEXT NOT NULL,
            ok INTEGER NOT NULL, manifest_hash TEXT, decrypted_bytes INTEGER,
            details_json TEXT NOT NULL
        )""",
    ]
    for statement in statements:
        conn.execute(statement)


def _migration_3(conn) -> None:
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_v26_nodes_heartbeat ON v26_nodes(heartbeat_at)",
        "CREATE INDEX IF NOT EXISTS idx_v26_leases_state ON v26_job_leases(state, expires_at)",
        "CREATE INDEX IF NOT EXISTS idx_v26_leases_owner ON v26_job_leases(owner_node_id, state)",
        "CREATE INDEX IF NOT EXISTS idx_v26_dlq_job ON v26_dead_letters(job_key, resolved_at)",
        "CREATE INDEX IF NOT EXISTS idx_v26_checksums_status ON v26_media_checksums(status, verified_at)",
        "CREATE INDEX IF NOT EXISTS idx_v26_backup_verify ON v26_backup_verifications(backup_id, checked_at)",
    ]
    for statement in indexes:
        conn.execute(statement)


def _migration_4(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS v26_reliability_events (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, event_type TEXT NOT NULL,
        job_key TEXT, node_id TEXT, severity TEXT NOT NULL, details_json TEXT NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v26_rel_events_created ON v26_reliability_events(created_at)")


MIGRATIONS = [
    (1, "nodes_leases_dlq", _migration_1),
    (2, "circuits_idempotency_integrity", _migration_2),
    (3, "reliability_indexes", _migration_3),
    (4, "reliability_events", _migration_4),
]

DEFAULT_SETTINGS = {
    "maintenance.enabled": False,
    "maintenance.reason": "",
    "lease.ttlSeconds": 60,
    "lease.heartbeatSeconds": 15,
    "retry.maxAttempts": 3,
    "retry.baseSeconds": 30,
    "retry.maxSeconds": 900,
    "circuit.failureThreshold": 5,
    "circuit.cooldownSeconds": 120,
    "node.staleSeconds": 90,
    "shutdown.drainSeconds": 20,
    "idempotency.ttlHours": 24,
    "checksum.maxFileMb": 4096,
}


def ensure_schema() -> dict:
    with identity.connection() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS v26_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""")
    rows = identity.fetchall("SELECT version FROM v26_schema_migrations ORDER BY version")
    applied = {int(row["version"]) for row in rows}
    newly_applied: list[int] = []
    for version, name, fn in MIGRATIONS:
        if version in applied:
            continue
        with identity.connection() as conn:
            fn(conn)
            conn.execute(
                _adapt("INSERT INTO v26_schema_migrations(version,name,applied_at) VALUES(?,?,?)"),
                (version, name, _now()),
            )
        newly_applied.append(version)
    seed_defaults()
    return schema_status() | {"newlyApplied": newly_applied}


def schema_status() -> dict:
    rows = identity.fetchall("SELECT version,name,applied_at FROM v26_schema_migrations ORDER BY version")
    current = int(rows[-1]["version"]) if rows else 0
    return {
        "current": current,
        "latest": LATEST_SCHEMA_VERSION,
        "pending": max(0, LATEST_SCHEMA_VERSION - current),
        "databaseMode": identity.mode(),
        "distributedLocks": identity.mode() == "postgresql",
        "applied": rows,
    }


def seed_defaults() -> None:
    existing = {str(row["key"]) for row in identity.fetchall("SELECT key FROM v26_settings")}
    for key, value in DEFAULT_SETTINGS.items():
        if key not in existing:
            set_setting(key, value)


def get_settings() -> dict:
    result = dict(DEFAULT_SETTINGS)
    for row in identity.fetchall("SELECT key,value_json FROM v26_settings"):
        try:
            result[str(row["key"])] = json.loads(str(row["value_json"]))
        except Exception:
            continue
    return result


def set_setting(key: str, value) -> None:
    if key not in DEFAULT_SETTINGS:
        return
    payload = json.dumps(value, ensure_ascii=False)
    now = _now()
    with identity.connection() as conn:
        if identity.mode() == "postgresql":
            conn.execute(
                "INSERT INTO v26_settings(key,value_json,updated_at) VALUES(%s,%s,%s) "
                "ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at",
                (key, payload, now),
            )
        else:
            conn.execute(
                "INSERT INTO v26_settings(key,value_json,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                (key, payload, now),
            )


def set_settings(values: dict) -> dict:
    for key, value in values.items():
        set_setting(str(key), value)
    return get_settings()


def event(event_type: str, *, severity: str = "info", job_key: str | None = None,
          node_id: str | None = None, details: dict | None = None) -> None:
    import uuid
    identity.execute(
        "INSERT INTO v26_reliability_events(id,created_at,event_type,job_key,node_id,severity,details_json) VALUES(?,?,?,?,?,?,?)",
        (uuid.uuid4().hex[:18], _now(), event_type, job_key, node_id, severity,
         json.dumps(details or {}, ensure_ascii=False)),
    )


def _lock_key(name: str) -> int:
    return int.from_bytes(hashlib.sha256(name.encode("utf-8")).digest()[:8], "big", signed=True)


@contextmanager
def distributed_lock(name: str, *, blocking: bool = False):
    """Yield True when the critical-section lock was acquired.

    PostgreSQL uses a real session-scoped advisory lock. SQLite only provides
    an in-process RLock and therefore must not be described as distributed.
    """
    if identity.mode() == "postgresql":
        key = _lock_key(name)
        with identity.connection() as conn:
            if blocking:
                conn.execute("SELECT pg_advisory_lock(%s)", (key,))
                acquired = True
            else:
                row = conn.execute("SELECT pg_try_advisory_lock(%s) AS locked", (key,)).fetchone()
                acquired = bool(dict(row).get("locked")) if row is not None else False
            try:
                yield acquired
            finally:
                if acquired:
                    conn.execute("SELECT pg_advisory_unlock(%s)", (key,))
        return

    with _LOCAL_LOCKS_GUARD:
        lock = _LOCAL_LOCKS.setdefault(name, threading.RLock())
    acquired = lock.acquire(blocking=blocking)
    try:
        yield acquired
    finally:
        if acquired:
            lock.release()


ensure_schema()
