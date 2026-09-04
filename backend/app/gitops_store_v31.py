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


def _loads(raw, default):
    try:
        return json.loads(str(raw or ""))
    except Exception:
        return default


def _migration_1(conn) -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v31_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v31_releases (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL,
            candidate_ref TEXT NOT NULL, candidate_sha TEXT NOT NULL, base_sha TEXT,
            tag_name TEXT, state TEXT NOT NULL, environment TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, prepared_at TEXT,
            finished_at TEXT, actor_id TEXT, manifest_json TEXT NOT NULL,
            github_json TEXT NOT NULL, notes_json TEXT NOT NULL,
            deployment_json TEXT NOT NULL, rollback_sha TEXT,
            blockers_json TEXT NOT NULL, warnings_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v31_approvals (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, environment TEXT NOT NULL,
            actor_id TEXT NOT NULL, actor_name TEXT, actor_role TEXT,
            decision TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
            signature TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v31_events (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, created_at TEXT NOT NULL,
            event_type TEXT NOT NULL, environment TEXT, actor_id TEXT,
            details_json TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v31_freeze_windows (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, start_at TEXT NOT NULL,
            end_at TEXT NOT NULL, reason TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, actor_id TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v31_deployments (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, environment TEXT NOT NULL,
            action TEXT NOT NULL, target_sha TEXT NOT NULL, state TEXT NOT NULL,
            external INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
            finished_at TEXT, actor_id TEXT, response_json TEXT NOT NULL
        )""",
    ]
    for statement in statements:
        conn.execute(statement)


def _migration_2(conn) -> None:
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_v31_release_updated ON v31_releases(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_v31_approval_release ON v31_approvals(release_id,environment,created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v31_event_release ON v31_events(release_id,created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v31_deploy_release ON v31_deployments(release_id,created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v31_freeze_time ON v31_freeze_windows(start_at,end_at)",
    ]
    for statement in indexes:
        conn.execute(statement)


def _migration_3(conn) -> None:
    # One actor has one current decision per environment. Older rows are retained
    # only when their decision was made under a different release.
    try:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_v31_approval_actor_env ON v31_approvals(release_id,environment,actor_id)")
    except Exception:
        pass


MIGRATIONS = [
    (1, "gitops_release_core", _migration_1),
    (2, "gitops_indexes", _migration_2),
    (3, "approval_uniqueness", _migration_3),
]


def ensure_schema() -> dict:
    with identity.connection() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS v31_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
        )""")
    applied = {int(row["version"]) for row in identity.fetchall("SELECT version FROM v31_schema_migrations")}
    new: list[int] = []
    for version, name, fn in MIGRATIONS:
        if version in applied:
            continue
        with identity.connection() as conn:
            fn(conn)
            conn.execute(_adapt("INSERT INTO v31_schema_migrations(version,name,applied_at) VALUES(?,?,?)"), (version, name, _now()))
        new.append(version)
    return schema_status() | {"newlyApplied": new}


def schema_status() -> dict:
    rows = identity.fetchall("SELECT version,name,applied_at FROM v31_schema_migrations ORDER BY version")
    current = int(rows[-1]["version"]) if rows else 0
    return {"current": current, "latest": LATEST_SCHEMA_VERSION, "pending": max(0, LATEST_SCHEMA_VERSION-current), "databaseMode": identity.mode(), "applied": rows}


def release_public(row: dict) -> dict:
    return {
        "id": row.get("id"), "name": row.get("name"), "repository": row.get("repository"),
        "candidateRef": row.get("candidate_ref"), "candidateSha": row.get("candidate_sha"),
        "baseSha": row.get("base_sha"), "tagName": row.get("tag_name"), "state": row.get("state"),
        "environment": row.get("environment"), "createdAt": row.get("created_at"), "updatedAt": row.get("updated_at"),
        "preparedAt": row.get("prepared_at"), "finishedAt": row.get("finished_at"), "actorId": row.get("actor_id"),
        "manifest": _loads(row.get("manifest_json"), {}), "github": _loads(row.get("github_json"), {}),
        "notes": _loads(row.get("notes_json"), []), "deployment": _loads(row.get("deployment_json"), {}),
        "rollbackSha": row.get("rollback_sha"), "blockers": _loads(row.get("blockers_json"), []),
        "warnings": _loads(row.get("warnings_json"), []),
    }


def create_release(*, name: str, repository: str, candidate_ref: str, candidate_sha: str, base_sha: str | None,
                   tag_name: str | None, manifest: dict, actor_id: str | None) -> dict:
    release_id = uuid.uuid4().hex[:18]
    now = _now()
    identity.execute(
        "INSERT INTO v31_releases(id,name,repository,candidate_ref,candidate_sha,base_sha,tag_name,state,environment,created_at,updated_at,prepared_at,finished_at,actor_id,manifest_json,github_json,notes_json,deployment_json,rollback_sha,blockers_json,warnings_json) "
        "VALUES(?,?,?,?,?,?,?,'draft','none',?,?,NULL,NULL,? ,?,'{}','[]','{}',NULL,'[]','[]')",
        (release_id, name[:140], repository[:180], candidate_ref[:180], candidate_sha[:80], base_sha, tag_name, now, now, actor_id, json.dumps(manifest, ensure_ascii=False)),
    )
    add_event(release_id, "created", "none", actor_id, {"candidateSha": candidate_sha, "candidateRef": candidate_ref})
    return get_release(release_id) or {"id": release_id}


def get_release(release_id: str) -> dict | None:
    row = identity.fetchone("SELECT * FROM v31_releases WHERE id=?", (release_id,))
    return release_public(row) if row else None


def list_releases(limit: int = 30) -> list[dict]:
    return [release_public(row) for row in identity.fetchall("SELECT * FROM v31_releases ORDER BY updated_at DESC LIMIT ?", (max(1,min(100,limit)),))]


def active_release() -> dict | None:
    row = identity.fetchone("SELECT * FROM v31_releases WHERE state NOT IN ('promoted','rolled_back','cancelled','failed') ORDER BY updated_at DESC LIMIT 1")
    return release_public(row) if row else None


def update_release(release_id: str, **values) -> dict:
    mapping = {
        "state":"state", "environment":"environment", "preparedAt":"prepared_at", "finishedAt":"finished_at",
        "github":"github_json", "notes":"notes_json", "deployment":"deployment_json", "rollbackSha":"rollback_sha",
        "blockers":"blockers_json", "warnings":"warnings_json", "baseSha":"base_sha", "tagName":"tag_name",
    }
    sets: list[str] = []; params: list = []
    for key, value in values.items():
        column = mapping.get(key)
        if not column:
            continue
        sets.append(f"{column}=?")
        if key in {"github","notes","deployment","blockers","warnings"}:
            params.append(json.dumps(value, ensure_ascii=False))
        else:
            params.append(value)
    sets.append("updated_at=?"); params.append(_now()); params.append(release_id)
    identity.execute(f"UPDATE v31_releases SET {','.join(sets)} WHERE id=?", tuple(params))
    return get_release(release_id) or {"id": release_id}


def add_event(release_id: str, event_type: str, environment: str | None, actor_id: str | None, details: dict | None = None) -> str:
    event_id = uuid.uuid4().hex[:18]
    identity.execute("INSERT INTO v31_events(id,release_id,created_at,event_type,environment,actor_id,details_json) VALUES(?,?,?,?,?,?,?)",
                     (event_id, release_id, _now(), event_type[:60], environment, actor_id, json.dumps(details or {}, ensure_ascii=False)))
    return event_id


def events(release_id: str, limit: int = 150) -> list[dict]:
    rows = identity.fetchall("SELECT * FROM v31_events WHERE release_id=? ORDER BY created_at DESC LIMIT ?", (release_id,max(1,min(500,limit))))
    return [{"id":r.get("id"),"releaseId":r.get("release_id"),"createdAt":r.get("created_at"),"eventType":r.get("event_type"),"environment":r.get("environment"),"actorId":r.get("actor_id"),"details":_loads(r.get("details_json"),{})} for r in rows]


def upsert_approval(*, release_id: str, environment: str, actor_id: str, actor_name: str | None, actor_role: str | None,
                    decision: str, reason: str, signature: str, created_at: str) -> dict:
    existing = identity.fetchone("SELECT id FROM v31_approvals WHERE release_id=? AND environment=? AND actor_id=?", (release_id,environment,actor_id))
    approval_id = str((existing or {}).get("id") or uuid.uuid4().hex[:18])
    identity.execute("DELETE FROM v31_approvals WHERE release_id=? AND environment=? AND actor_id=?", (release_id,environment,actor_id))
    identity.execute("INSERT INTO v31_approvals(id,release_id,environment,actor_id,actor_name,actor_role,decision,reason,created_at,signature) VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (approval_id,release_id,environment,actor_id,actor_name,actor_role,decision,reason[:800],created_at,signature))
    row = identity.fetchone("SELECT * FROM v31_approvals WHERE id=?", (approval_id,))
    return approval_public(row) if row else {"id":approval_id}


def approval_public(row: dict) -> dict:
    return {"id":row.get("id"),"releaseId":row.get("release_id"),"environment":row.get("environment"),"actorId":row.get("actor_id"),"actorName":row.get("actor_name"),"actorRole":row.get("actor_role"),"decision":row.get("decision"),"reason":row.get("reason"),"createdAt":row.get("created_at"),"signature":row.get("signature")}


def approvals(release_id: str, environment: str | None = None) -> list[dict]:
    if environment:
        rows = identity.fetchall("SELECT * FROM v31_approvals WHERE release_id=? AND environment=? ORDER BY created_at", (release_id,environment))
    else:
        rows = identity.fetchall("SELECT * FROM v31_approvals WHERE release_id=? ORDER BY created_at", (release_id,))
    return [approval_public(row) for row in rows]


def add_deployment(*, release_id: str, environment: str, action: str, target_sha: str, state: str,
                   external: bool, actor_id: str | None, response: dict | None = None, finished_at: str | None = None) -> dict:
    deploy_id = uuid.uuid4().hex[:18]
    identity.execute("INSERT INTO v31_deployments(id,release_id,environment,action,target_sha,state,external,created_at,finished_at,actor_id,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (deploy_id,release_id,environment,action,target_sha,state,int(external),_now(),finished_at,actor_id,json.dumps(response or {},ensure_ascii=False)))
    row = identity.fetchone("SELECT * FROM v31_deployments WHERE id=?", (deploy_id,))
    return deployment_public(row) if row else {"id":deploy_id}


def deployment_public(row: dict) -> dict:
    return {"id":row.get("id"),"releaseId":row.get("release_id"),"environment":row.get("environment"),"action":row.get("action"),"targetSha":row.get("target_sha"),"state":row.get("state"),"external":bool(row.get("external")),"createdAt":row.get("created_at"),"finishedAt":row.get("finished_at"),"actorId":row.get("actor_id"),"response":_loads(row.get("response_json"),{})}


def deployments(release_id: str, limit: int = 50) -> list[dict]:
    return [deployment_public(row) for row in identity.fetchall("SELECT * FROM v31_deployments WHERE release_id=? ORDER BY created_at DESC LIMIT ?",(release_id,max(1,min(200,limit))))]


def add_freeze(*, name: str, start_at: str, end_at: str, reason: str, actor_id: str | None) -> dict:
    freeze_id = uuid.uuid4().hex[:18]
    identity.execute("INSERT INTO v31_freeze_windows(id,name,start_at,end_at,reason,active,created_at,actor_id) VALUES(?,?,?,?,?,1,?,?)",
                     (freeze_id,name[:120],start_at,end_at,reason[:800],_now(),actor_id))
    return get_freeze(freeze_id) or {"id":freeze_id}


def get_freeze(freeze_id: str) -> dict | None:
    row = identity.fetchone("SELECT * FROM v31_freeze_windows WHERE id=?",(freeze_id,))
    return freeze_public(row) if row else None


def freeze_public(row: dict) -> dict:
    return {"id":row.get("id"),"name":row.get("name"),"startAt":row.get("start_at"),"endAt":row.get("end_at"),"reason":row.get("reason"),"active":bool(row.get("active")),"createdAt":row.get("created_at"),"actorId":row.get("actor_id")}


def freezes(limit: int = 50) -> list[dict]:
    return [freeze_public(row) for row in identity.fetchall("SELECT * FROM v31_freeze_windows ORDER BY start_at DESC LIMIT ?",(max(1,min(200,limit)),))]


def delete_freeze(freeze_id: str) -> None:
    identity.execute("DELETE FROM v31_freeze_windows WHERE id=?",(freeze_id,))


ensure_schema()
