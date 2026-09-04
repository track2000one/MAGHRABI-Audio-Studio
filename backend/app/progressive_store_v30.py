from __future__ import annotations

import json
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
        """CREATE TABLE IF NOT EXISTS v30_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v30_releases (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version TEXT NOT NULL,
            candidate_version TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
            desired_percent INTEGER NOT NULL DEFAULT 0, applied_percent INTEGER NOT NULL DEFAULT 0,
            auto_promote INTEGER NOT NULL DEFAULT 0, auto_rollback INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
            last_evaluated_at TEXT, actor_id TEXT, manifest_json TEXT NOT NULL,
            blockers_json TEXT NOT NULL, warnings_json TEXT NOT NULL, metrics_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v30_stage_events (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, created_at TEXT NOT NULL,
            event_type TEXT NOT NULL, from_percent INTEGER, to_percent INTEGER,
            state TEXT NOT NULL, actor_id TEXT, details_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v30_feature_flags (
            key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0, rollout_percent INTEGER NOT NULL DEFAULT 0,
            variant_on TEXT NOT NULL DEFAULT 'on', variant_off TEXT NOT NULL DEFAULT 'off',
            salt TEXT NOT NULL, updated_at TEXT NOT NULL, actor_id TEXT
        )""",
    ]
    for statement in statements:
        conn.execute(statement)


def _migration_2(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS v30_cohort_samples (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, release_id TEXT,
        cohort TEXT NOT NULL, route TEXT NOT NULL, method TEXT NOT NULL,
        status_code INTEGER NOT NULL, duration_ms REAL NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v30_cohort_created ON v30_cohort_samples(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v30_cohort_release ON v30_cohort_samples(release_id,cohort,created_at)")


def _migration_3(conn) -> None:
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v30_release_updated ON v30_releases(updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_v30_stage_release ON v30_stage_events(release_id,created_at)")


MIGRATIONS = [
    (1, "progressive_release_core", _migration_1),
    (2, "cohort_slo_samples", _migration_2),
    (3, "progressive_indexes", _migration_3),
]


def ensure_schema() -> dict:
    with identity.connection() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS v30_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""")
    applied = {int(row["version"]) for row in identity.fetchall("SELECT version FROM v30_schema_migrations")}
    new: list[int] = []
    for version, name, fn in MIGRATIONS:
        if version in applied:
            continue
        with identity.connection() as conn:
            fn(conn)
            conn.execute(_adapt("INSERT INTO v30_schema_migrations(version,name,applied_at) VALUES(?,?,?)"), (version, name, _now()))
        new.append(version)
    return schema_status() | {"newlyApplied": new}


def schema_status() -> dict:
    rows = identity.fetchall("SELECT version,name,applied_at FROM v30_schema_migrations ORDER BY version")
    current = int(rows[-1]["version"]) if rows else 0
    return {
        "current": current, "latest": LATEST_SCHEMA_VERSION,
        "pending": max(0, LATEST_SCHEMA_VERSION - current),
        "databaseMode": identity.mode(), "applied": rows,
    }


def _loads(raw, default):
    try:
        return json.loads(str(raw or ""))
    except Exception:
        return default


def release_public(row: dict) -> dict:
    return {
        "id": row.get("id"), "name": row.get("name"),
        "currentVersion": row.get("current_version"), "candidateVersion": row.get("candidate_version"),
        "state": row.get("state"), "stageIndex": int(row.get("stage_index") or 0),
        "desiredPercent": int(row.get("desired_percent") or 0), "appliedPercent": int(row.get("applied_percent") or 0),
        "autoPromote": bool(row.get("auto_promote")), "autoRollback": bool(row.get("auto_rollback")),
        "createdAt": row.get("created_at"), "updatedAt": row.get("updated_at"),
        "startedAt": row.get("started_at"), "finishedAt": row.get("finished_at"),
        "lastEvaluatedAt": row.get("last_evaluated_at"), "actorId": row.get("actor_id"),
        "manifest": _loads(row.get("manifest_json"), {}),
        "blockers": _loads(row.get("blockers_json"), []), "warnings": _loads(row.get("warnings_json"), []),
        "metrics": _loads(row.get("metrics_json"), {}),
    }


def create_release(*, name: str, current_version: str, candidate_version: str, manifest: dict,
                   auto_promote: bool, auto_rollback: bool, actor_id: str | None) -> dict:
    release_id = uuid.uuid4().hex[:18]
    now = _now()
    identity.execute(
        "INSERT INTO v30_releases(id,name,current_version,candidate_version,state,stage_index,desired_percent,applied_percent,auto_promote,auto_rollback,created_at,updated_at,started_at,finished_at,last_evaluated_at,actor_id,manifest_json,blockers_json,warnings_json,metrics_json) "
        "VALUES(?,?,?,?, 'draft',0,0,0,?,?,?,?,NULL,NULL,NULL,?,?, '[]','[]','{}')",
        (release_id, name[:120], current_version[:120], candidate_version[:120], int(auto_promote), int(auto_rollback), now, now, actor_id, json.dumps(manifest, ensure_ascii=False)),
    )
    add_stage_event(release_id, "created", None, 0, "draft", actor_id, {"manifest": manifest})
    return get_release(release_id) or {"id": release_id}


def get_release(release_id: str) -> dict | None:
    row = identity.fetchone("SELECT * FROM v30_releases WHERE id=?", (release_id,))
    return release_public(row) if row else None


def list_releases(limit: int = 30) -> list[dict]:
    return [release_public(row) for row in identity.fetchall(
        "SELECT * FROM v30_releases ORDER BY updated_at DESC LIMIT ?", (max(1, min(100, limit)),)
    )]


def active_release() -> dict | None:
    row = identity.fetchone("SELECT * FROM v30_releases WHERE state IN ('canary','promoting','paused') ORDER BY updated_at DESC LIMIT 1")
    return release_public(row) if row else None


def update_release(release_id: str, **values) -> dict:
    mapping = {
        "state": "state", "stageIndex": "stage_index", "desiredPercent": "desired_percent",
        "appliedPercent": "applied_percent", "startedAt": "started_at", "finishedAt": "finished_at",
        "lastEvaluatedAt": "last_evaluated_at", "blockers": "blockers_json", "warnings": "warnings_json",
        "metrics": "metrics_json", "autoPromote": "auto_promote", "autoRollback": "auto_rollback",
    }
    sets: list[str] = []
    params: list = []
    for key, value in values.items():
        column = mapping.get(key)
        if not column:
            continue
        sets.append(f"{column}=?")
        if key in {"blockers", "warnings", "metrics"}:
            params.append(json.dumps(value, ensure_ascii=False))
        elif key in {"autoPromote", "autoRollback"}:
            params.append(int(bool(value)))
        else:
            params.append(value)
    sets.append("updated_at=?"); params.append(_now()); params.append(release_id)
    identity.execute(f"UPDATE v30_releases SET {','.join(sets)} WHERE id=?", tuple(params))
    return get_release(release_id) or {"id": release_id}


def add_stage_event(release_id: str, event_type: str, from_percent: int | None, to_percent: int | None,
                    state: str, actor_id: str | None, details: dict | None = None) -> str:
    event_id = uuid.uuid4().hex[:18]
    identity.execute(
        "INSERT INTO v30_stage_events(id,release_id,created_at,event_type,from_percent,to_percent,state,actor_id,details_json) VALUES(?,?,?,?,?,?,?,?,?)",
        (event_id, release_id, _now(), event_type[:50], from_percent, to_percent, state[:30], actor_id, json.dumps(details or {}, ensure_ascii=False)),
    )
    return event_id


def stage_events(release_id: str, limit: int = 80) -> list[dict]:
    rows = identity.fetchall("SELECT * FROM v30_stage_events WHERE release_id=? ORDER BY created_at DESC LIMIT ?", (release_id, max(1, min(300, limit))))
    return [{
        "id": row.get("id"), "releaseId": row.get("release_id"), "createdAt": row.get("created_at"),
        "eventType": row.get("event_type"), "fromPercent": row.get("from_percent"), "toPercent": row.get("to_percent"),
        "state": row.get("state"), "actorId": row.get("actor_id"), "details": _loads(row.get("details_json"), {}),
    } for row in rows]


def add_cohort_sample(release_id: str | None, cohort: str, route: str, method: str, status_code: int, duration_ms: float) -> None:
    identity.execute(
        "INSERT INTO v30_cohort_samples(id,created_at,release_id,cohort,route,method,status_code,duration_ms) VALUES(?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex[:18], _now(), release_id, cohort[:20], route[:240], method[:12], int(status_code), float(duration_ms)),
    )


def cohort_rows(release_id: str, since_iso: str) -> list[dict]:
    return identity.fetchall(
        "SELECT cohort,status_code,duration_ms,created_at FROM v30_cohort_samples WHERE release_id=? AND created_at>=? ORDER BY created_at",
        (release_id, since_iso),
    )


def upsert_flag(*, key: str, name: str, description: str, enabled: bool, rollout_percent: int,
                variant_on: str, variant_off: str, actor_id: str | None) -> dict:
    key = key.strip().lower().replace(" ", "-")[:80]
    if not key:
        raise ValueError("feature flag key is required")
    existing = identity.fetchone("SELECT * FROM v30_feature_flags WHERE key=?", (key,))
    salt = str((existing or {}).get("salt") or uuid.uuid4().hex)
    now = _now()
    params = (key, name[:120], description[:500], int(enabled), max(0, min(100, int(rollout_percent))), variant_on[:80], variant_off[:80], salt, now, actor_id)
    if identity.mode() == "postgresql":
        with identity.connection() as conn:
            conn.execute(
                "INSERT INTO v30_feature_flags(key,name,description,enabled,rollout_percent,variant_on,variant_off,salt,updated_at,actor_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,enabled=EXCLUDED.enabled,rollout_percent=EXCLUDED.rollout_percent,variant_on=EXCLUDED.variant_on,variant_off=EXCLUDED.variant_off,updated_at=EXCLUDED.updated_at,actor_id=EXCLUDED.actor_id",
                params,
            )
    else:
        with identity.connection() as conn:
            conn.execute(
                "INSERT INTO v30_feature_flags(key,name,description,enabled,rollout_percent,variant_on,variant_off,salt,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET name=excluded.name,description=excluded.description,enabled=excluded.enabled,rollout_percent=excluded.rollout_percent,variant_on=excluded.variant_on,variant_off=excluded.variant_off,updated_at=excluded.updated_at,actor_id=excluded.actor_id",
                params,
            )
    return get_flag(key) or {"key": key}


def _flag_public(row: dict) -> dict:
    return {
        "key": row.get("key"), "name": row.get("name"), "description": row.get("description"),
        "enabled": bool(row.get("enabled")), "rolloutPercent": int(row.get("rollout_percent") or 0),
        "variantOn": row.get("variant_on"), "variantOff": row.get("variant_off"), "salt": row.get("salt"),
        "updatedAt": row.get("updated_at"), "actorId": row.get("actor_id"),
    }


def get_flag(key: str) -> dict | None:
    row = identity.fetchone("SELECT * FROM v30_feature_flags WHERE key=?", (key,))
    return _flag_public(row) if row else None


def list_flags() -> list[dict]:
    return [_flag_public(row) for row in identity.fetchall("SELECT * FROM v30_feature_flags ORDER BY key")]


def delete_flag(key: str) -> None:
    identity.execute("DELETE FROM v30_feature_flags WHERE key=?", (key,))


ensure_schema()
