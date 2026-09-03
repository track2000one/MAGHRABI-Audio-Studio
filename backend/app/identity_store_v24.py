from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

try:
    import psycopg
    from psycopg.rows import dict_row
except Exception:  # pragma: no cover - sqlite fallback remains available
    psycopg = None
    dict_row = None

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
SQLITE_PATH = DATA_DIR / "video_identity_v24.sqlite3"
V23_DIR = DATA_DIR / "video_identity"
_LOCK = threading.RLock()


def mode() -> str:
    return "postgresql" if DATABASE_URL and psycopg is not None else "sqlite"


def configured_postgres() -> bool:
    return bool(DATABASE_URL)


def _adapt(sql: str) -> str:
    return sql.replace("?", "%s") if mode() == "postgresql" else sql


@contextmanager
def connection():
    if mode() == "postgresql":
        assert psycopg is not None
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False)
    else:
        SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(SQLITE_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def execute(sql: str, params: tuple | list = ()) -> None:
    with _LOCK, connection() as conn:
        conn.execute(_adapt(sql), tuple(params))


def executemany(sql: str, rows: list[tuple]) -> None:
    if not rows:
        return
    with _LOCK, connection() as conn:
        conn.executemany(_adapt(sql), rows)


def fetchone(sql: str, params: tuple | list = ()) -> dict | None:
    with _LOCK, connection() as conn:
        row = conn.execute(_adapt(sql), tuple(params)).fetchone()
        return dict(row) if row is not None else None


def fetchall(sql: str, params: tuple | list = ()) -> list[dict]:
    with _LOCK, connection() as conn:
        rows = conn.execute(_adapt(sql), tuple(params)).fetchall()
        return [dict(row) for row in rows]


def scalar(sql: str, params: tuple | list = (), default=0):
    row = fetchone(sql, params)
    if not row:
        return default
    return next(iter(row.values()), default)


def init_schema() -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v24_meta (
            key TEXT PRIMARY KEY, value TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v24_users (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL, status TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            password_salt TEXT, password_hash TEXT, auth_version INTEGER NOT NULL DEFAULT 1,
            mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, last_login_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v24_teams (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v24_team_members (
            team_id TEXT NOT NULL, user_id TEXT NOT NULL,
            PRIMARY KEY (team_id, user_id)
        )""",
        """CREATE TABLE IF NOT EXISTS v24_acl (
            id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
            principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, permission TEXT NOT NULL,
            owner_user_id TEXT, created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v24_invites (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE, token_last4 TEXT NOT NULL, created_at TEXT NOT NULL,
            expires_at INTEGER NOT NULL, used_at TEXT, revoked_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v24_audit (
            id TEXT PRIMARY KEY, actor_id TEXT, actor_name TEXT, actor_role TEXT,
            action TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v24_sessions (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
            csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL,
            last_seen_at TEXT NOT NULL, ip TEXT, user_agent TEXT, revoked_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v24_password_resets (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL,
            used_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v24_login_buckets (
            bucket_key TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL,
            window_started INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0
        )""",
    ]
    with _LOCK, connection() as conn:
        for statement in statements:
            conn.execute(statement)
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_v24_sessions_user ON v24_sessions(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_v24_acl_resource ON v24_acl(resource_type, resource_id)",
            "CREATE INDEX IF NOT EXISTS idx_v24_audit_created ON v24_audit(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_v24_invites_email ON v24_invites(email)",
        ]
        for statement in indexes:
            conn.execute(statement)


def meta_get(key: str) -> str | None:
    row = fetchone("SELECT value FROM v24_meta WHERE key=?", (key,))
    return str(row["value"]) if row else None


def meta_set(key: str, value: str) -> None:
    with _LOCK, connection() as conn:
        if mode() == "postgresql":
            conn.execute(
                "INSERT INTO v24_meta(key,value) VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
                (key, value),
            )
        else:
            conn.execute(
                "INSERT INTO v24_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )


def _json_file(name: str, default):
    path = V23_DIR / name
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def migrate_v23_if_empty(now_iso: str) -> dict:
    if meta_get("v23_migration_complete") == "1":
        return {"performed": False, "reason": "already_migrated"}
    if scalar("SELECT COUNT(*) AS count FROM v24_users", default=0):
        meta_set("v23_migration_complete", "1")
        return {"performed": False, "reason": "v24_not_empty"}

    users = _json_file("users.json", [])
    teams = _json_file("teams.json", [])
    acl = _json_file("acl.json", [])
    audit = _json_file("audit.json", [])
    migrated = {"users": 0, "teams": 0, "acl": 0, "audit": 0}

    with _LOCK, connection() as conn:
        for user in users if isinstance(users, list) else []:
            if not user.get("id") or not user.get("email"):
                continue
            conn.execute(_adapt("""INSERT INTO v24_users(
                id,name,email,role,status,active,password_salt,password_hash,auth_version,
                mfa_secret,mfa_enabled,created_at,last_login_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"""), (
                str(user.get("id")), str(user.get("name") or "User"), str(user.get("email")).lower(),
                str(user.get("role") or "viewer"), str(user.get("status") or "active"), 1 if user.get("active", True) else 0,
                user.get("passwordSalt"), user.get("passwordHash"), int(user.get("authVersion", 1)),
                None, 0, str(user.get("createdAt") or now_iso), user.get("lastLoginAt"),
            ))
            migrated["users"] += 1

        for team in teams if isinstance(teams, list) else []:
            team_id = str(team.get("id") or "")
            if not team_id:
                continue
            conn.execute(_adapt("INSERT INTO v24_teams(id,name,created_at,updated_at) VALUES(?,?,?,?)"), (
                team_id, str(team.get("name") or "Team"), str(team.get("createdAt") or now_iso), str(team.get("updatedAt") or now_iso),
            ))
            for user_id in team.get("memberIds", []) or []:
                try:
                    if mode() == "postgresql":
                        conn.execute("INSERT INTO v24_team_members(team_id,user_id) VALUES(%s,%s) ON CONFLICT DO NOTHING", (team_id, str(user_id)))
                    else:
                        conn.execute("INSERT OR IGNORE INTO v24_team_members(team_id,user_id) VALUES(?,?)", (team_id, str(user_id)))
                except Exception:
                    pass
            migrated["teams"] += 1

        for entry in acl if isinstance(acl, list) else []:
            if not entry.get("id"):
                continue
            conn.execute(_adapt("""INSERT INTO v24_acl(
                id,resource_type,resource_id,principal_type,principal_id,permission,owner_user_id,created_at
            ) VALUES(?,?,?,?,?,?,?,?)"""), (
                str(entry.get("id")), str(entry.get("resourceType") or ""), str(entry.get("resourceId") or ""),
                str(entry.get("principalType") or "user"), str(entry.get("principalId") or ""), str(entry.get("permission") or "view"),
                entry.get("ownerUserId"), str(entry.get("createdAt") or now_iso),
            ))
            migrated["acl"] += 1

        for event in (audit if isinstance(audit, list) else [])[-2000:]:
            conn.execute(_adapt("""INSERT INTO v24_audit(
                id,actor_id,actor_name,actor_role,action,details_json,created_at
            ) VALUES(?,?,?,?,?,?,?)"""), (
                str(event.get("id") or f"legacy-{migrated['audit']}"), event.get("actorId"), event.get("actorName"),
                event.get("actorRole"), str(event.get("action") or "legacy_event"),
                json.dumps(event.get("details") or {}, ensure_ascii=False), str(event.get("createdAt") or now_iso),
            ))
            migrated["audit"] += 1

    meta_set("v23_migration_complete", "1")
    meta_set("v23_migration_summary", json.dumps(migrated, ensure_ascii=False))
    return {"performed": True, **migrated}


init_schema()
