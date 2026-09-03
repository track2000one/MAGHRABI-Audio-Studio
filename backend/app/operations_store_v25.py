from __future__ import annotations

import json
from datetime import datetime, timezone

from . import identity_store_v24 as identity

LATEST_SCHEMA_VERSION = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _adapt(sql: str) -> str:
    return sql.replace("?", "%s") if identity.mode() == "postgresql" else sql


def _migration_1(conn) -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v25_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v25_settings (
            key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v25_alert_ack (
            alert_key TEXT PRIMARY KEY, acknowledged_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v25_backups (
            id TEXT PRIMARY KEY, label TEXT NOT NULL, file_path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT, status TEXT NOT NULL, manifest_json TEXT NOT NULL
        )""",
    ]
    for statement in statements:
        conn.execute(statement)


def _migration_2(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS v25_events (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, level TEXT NOT NULL, category TEXT NOT NULL,
        message TEXT NOT NULL, request_id TEXT, actor_id TEXT, route TEXT, method TEXT,
        status_code INTEGER, duration_ms REAL, details_json TEXT NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v25_events_created ON v25_events(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v25_events_level ON v25_events(level, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v25_events_category ON v25_events(category, created_at)")


def _migration_3(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS v25_metric_snapshots (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, metric_type TEXT NOT NULL, payload_json TEXT NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v25_metrics_created ON v25_metric_snapshots(created_at)")


MIGRATIONS = [
    (1, "operations_core", _migration_1),
    (2, "structured_events", _migration_2),
    (3, "metric_snapshots", _migration_3),
]


def ensure_schema() -> dict:
    # The migration registry table must exist before we can inspect versions.
    with identity.connection() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS v25_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""")

    applied_rows = identity.fetchall("SELECT version,name,applied_at FROM v25_schema_migrations ORDER BY version")
    applied = {int(row["version"]) for row in applied_rows}
    newly_applied: list[int] = []

    for version, name, fn in MIGRATIONS:
        if version in applied:
            continue
        with identity.connection() as conn:
            fn(conn)
            conn.execute(
                _adapt("INSERT INTO v25_schema_migrations(version,name,applied_at) VALUES(?,?,?)"),
                (version, name, _now()),
            )
        newly_applied.append(version)

    seed_defaults()
    return {
        "current": current_schema_version(),
        "latest": LATEST_SCHEMA_VERSION,
        "newlyApplied": newly_applied,
        "applied": identity.fetchall("SELECT version,name,applied_at FROM v25_schema_migrations ORDER BY version"),
    }


def current_schema_version() -> int:
    row = identity.fetchone("SELECT MAX(version) AS version FROM v25_schema_migrations")
    return int((row or {}).get("version") or 0)


def schema_status() -> dict:
    rows = identity.fetchall("SELECT version,name,applied_at FROM v25_schema_migrations ORDER BY version")
    current = int(rows[-1]["version"]) if rows else 0
    return {
        "current": current,
        "latest": LATEST_SCHEMA_VERSION,
        "pending": max(0, LATEST_SCHEMA_VERSION - current),
        "applied": rows,
        "databaseMode": identity.mode(),
    }


DEFAULT_SETTINGS = {
    "storage.warnPercent": 80,
    "storage.criticalPercent": 90,
    "quota.audioJobsMb": 0,
    "quota.renderQueueMb": 0,
    "quota.proxyQueueMb": 0,
    "quota.pipelineQueueMb": 0,
    "retention.audioJobsDays": 14,
    "retention.renderQueueDays": 14,
    "retention.proxyQueueDays": 7,
    "retention.pipelineQueueDays": 30,
    "retention.autoEnabled": False,
    "retention.intervalHours": 6,
    "backup.autoEnabled": False,
    "backup.intervalHours": 24,
    "backup.keepCount": 10,
    "observability.slowRequestMs": 1500,
    "observability.eventRetentionDays": 30,
}


def seed_defaults() -> None:
    existing = {str(row["key"]) for row in identity.fetchall("SELECT key FROM v25_settings")}
    for key, value in DEFAULT_SETTINGS.items():
        if key in existing:
            continue
        set_setting(key, value)


def get_settings() -> dict:
    values = dict(DEFAULT_SETTINGS)
    for row in identity.fetchall("SELECT key,value_json FROM v25_settings"):
        try:
            values[str(row["key"])] = json.loads(str(row["value_json"]))
        except Exception:
            continue
    return values


def set_setting(key: str, value) -> None:
    payload = json.dumps(value, ensure_ascii=False)
    now = _now()
    if identity.mode() == "postgresql":
        with identity.connection() as conn:
            conn.execute(
                "INSERT INTO v25_settings(key,value_json,updated_at) VALUES(%s,%s,%s) "
                "ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=EXCLUDED.updated_at",
                (key, payload, now),
            )
    else:
        with identity.connection() as conn:
            conn.execute(
                "INSERT INTO v25_settings(key,value_json,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
                (key, payload, now),
            )


def set_settings(values: dict) -> dict:
    allowed = set(DEFAULT_SETTINGS)
    for key, value in values.items():
        if key not in allowed:
            continue
        set_setting(key, value)
    return get_settings()


ensure_schema()
