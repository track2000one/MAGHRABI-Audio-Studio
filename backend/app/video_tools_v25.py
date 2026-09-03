from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse

from . import identity_store_v24 as identity
from . import operations_store_v25 as ops
from . import video_tools_v24 as v24
from .main import AUTH_SECRET, DATA_DIR

router = APIRouter(prefix="/api/video/v25", tags=["video-studio-v25"])

OPS_DIR = DATA_DIR / "video_ops"
BACKUP_DIR = OPS_DIR / "backups"
BACKUP_DIR.mkdir(parents=True, exist_ok=True)

STARTED_MONOTONIC = time.monotonic()
_BACKGROUND_STARTED = False
_BACKGROUND_LOCK = threading.Lock()
_LAST_METRIC_AT = 0.0
_LAST_RETENTION_AT = 0.0
_LAST_BACKUP_CHECK_AT = 0.0

TERMINAL_STATUSES = {"done", "completed", "failed", "cancelled", "partial", "success"}
RETENTION_ROOTS = {
    "audioJobs": (DATA_DIR / "jobs", "retention.audioJobsDays"),
    "renderQueue": (DATA_DIR / "video_queue", "retention.renderQueueDays"),
    "proxyQueue": (DATA_DIR / "video_proxy_queue", "retention.proxyQueueDays"),
    "pipelineQueue": (DATA_DIR / "video_pipeline_queue", "retention.pipelineQueueDays"),
}
STORAGE_CATEGORIES = {
    "audioJobs": (DATA_DIR / "jobs", "quota.audioJobsMb"),
    "renderQueue": (DATA_DIR / "video_queue", "quota.renderQueueMb"),
    "proxyQueue": (DATA_DIR / "video_proxy_queue", "quota.proxyQueueMb"),
    "pipelineQueue": (DATA_DIR / "video_pipeline_queue", "quota.pipelineQueueMb"),
    "orchestrator": (DATA_DIR / "video_orchestrator", None),
    "reviews": (DATA_DIR / "video_review", None),
    "operations": (OPS_DIR, None),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: Any) -> float | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(text).timestamp()
    except Exception:
        return None


def _backup_fernet() -> Fernet:
    if not AUTH_SECRET or len(AUTH_SECRET) < 32:
        raise HTTPException(status_code=503, detail="AUTH_SECRET يجب أن يكون مهيأ قبل إنشاء Backup مشفّر.")
    key = base64.urlsafe_b64encode(hashlib.sha256(AUTH_SECRET.encode("utf-8") + b"|v25-backup|").digest())
    return Fernet(key)


def _dir_size(path: Path) -> int:
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    if not path.exists():
        return 0
    total = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(root) / name).is_symlink()]
        for name in files:
            target = Path(root) / name
            try:
                if not target.is_symlink():
                    total += target.stat().st_size
            except OSError:
                continue
    return total


def _data_mount_info() -> dict:
    target = str(DATA_DIR.resolve())
    exact = False
    filesystem = None
    source = None
    try:
        for line in Path("/proc/mounts").read_text(encoding="utf-8", errors="ignore").splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[1] == target:
                exact = True
                source, _mount, filesystem = parts[:3]
                break
    except Exception:
        pass
    return {"path": target, "dedicatedMount": exact, "source": source, "filesystem": filesystem}


def _memory_info() -> dict:
    values: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8", errors="ignore").splitlines():
            if ":" not in line:
                continue
            key, raw = line.split(":", 1)
            first = raw.strip().split()[0]
            if first.isdigit():
                values[key] = int(first) * 1024
    except Exception:
        pass
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    return {
        "totalBytes": total,
        "availableBytes": available,
        "usedBytes": max(0, total - available),
        "usedPercent": round((max(0, total - available) / total * 100), 2) if total else None,
    }


def _system_uptime() -> float | None:
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except Exception:
        return None


def _ffmpeg_processes() -> list[dict]:
    results: list[dict] = []
    proc = Path("/proc")
    try:
        clock_ticks = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
        page_size = os.sysconf("SC_PAGE_SIZE")
        uptime = _system_uptime() or 0.0
    except Exception:
        clock_ticks, page_size, uptime = 100, 4096, 0.0

    for child in proc.iterdir() if proc.exists() else []:
        if not child.name.isdigit():
            continue
        try:
            cmdline_raw = (child / "cmdline").read_bytes()
            if not cmdline_raw:
                continue
            parts = [item.decode("utf-8", errors="replace") for item in cmdline_raw.split(b"\0") if item]
            executable = Path(parts[0]).name.lower() if parts else ""
            if executable not in {"ffmpeg", "ffprobe"}:
                continue
            stat_parts = (child / "stat").read_text().split()
            utime = int(stat_parts[13]); stime = int(stat_parts[14]); start_ticks = int(stat_parts[21])
            elapsed = max(0.0, uptime - start_ticks / clock_ticks) if uptime else 0.0
            rss_pages = int((child / "statm").read_text().split()[1])
            command = " ".join(parts)
            if len(command) > 500:
                command = command[:497] + "..."
            results.append({
                "pid": int(child.name),
                "kind": executable,
                "elapsedSeconds": round(elapsed, 1),
                "cpuSeconds": round((utime + stime) / clock_ticks, 2),
                "rssBytes": rss_pages * page_size,
                "command": command,
            })
        except Exception:
            continue
    return sorted(results, key=lambda item: item["elapsedSeconds"], reverse=True)


def _job_state_files() -> list[tuple[str, Path]]:
    roots = {
        "audio": DATA_DIR / "jobs",
        "render": DATA_DIR / "video_queue",
        "proxy": DATA_DIR / "video_proxy_queue",
        "pipeline": DATA_DIR / "video_pipeline_queue",
        "orchestrator": DATA_DIR / "video_orchestrator" / "projects",
    }
    output: list[tuple[str, Path]] = []
    for category, root in roots.items():
        if not root.exists():
            continue
        pattern = "*/project.json" if category == "orchestrator" else "*/job.json"
        for path in root.glob(pattern):
            output.append((category, path))
    return output


def _job_metrics() -> dict:
    counts: dict[str, dict[str, int]] = {}
    recent_failures: list[dict] = []
    durations: list[float] = []
    now = time.time()
    for category, path in _job_state_files():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        status = str(state.get("status") or "unknown").lower()
        bucket = counts.setdefault(category, {})
        bucket[status] = bucket.get(status, 0) + 1
        duration = state.get("elapsed_seconds", state.get("elapsedSeconds"))
        if isinstance(duration, (int, float)) and duration >= 0:
            durations.append(float(duration))
        finished = (
            _parse_iso(state.get("finishedAt"))
            or _parse_iso(state.get("updatedAt"))
            or _parse_iso(state.get("createdAt"))
            or path.stat().st_mtime
        )
        if status in {"failed", "error"} and now - finished <= 24 * 3600:
            recent_failures.append({
                "category": category,
                "id": state.get("id") or path.parent.name,
                "message": state.get("error") or state.get("message") or "Job failed",
                "at": datetime.fromtimestamp(finished, tz=timezone.utc).isoformat(),
            })
    return {
        "counts": counts,
        "recentFailures24h": recent_failures[:100],
        "averageRecordedDurationSeconds": round(sum(durations) / len(durations), 2) if durations else None,
        "recordedDurationSamples": len(durations),
    }


def _storage_info() -> dict:
    settings = ops.get_settings()
    usage = shutil.disk_usage(DATA_DIR)
    categories = []
    for name, (path, quota_key) in STORAGE_CATEGORIES.items():
        size = _dir_size(path)
        quota_mb = float(settings.get(quota_key, 0) or 0) if quota_key else 0
        quota_bytes = int(quota_mb * 1024 * 1024) if quota_mb > 0 else 0
        categories.append({
            "name": name,
            "path": str(path),
            "bytes": size,
            "quotaBytes": quota_bytes or None,
            "quotaPercent": round(size / quota_bytes * 100, 2) if quota_bytes else None,
            "overQuota": bool(quota_bytes and size > quota_bytes),
        })
    used = usage.total - usage.free
    return {
        "disk": {
            "totalBytes": usage.total,
            "usedBytes": used,
            "freeBytes": usage.free,
            "usedPercent": round(used / usage.total * 100, 2) if usage.total else 0,
        },
        "mount": _data_mount_info(),
        "categories": categories,
    }


def _db_health() -> dict:
    started = time.perf_counter()
    try:
        row = identity.fetchone("SELECT 1 AS ok")
        return {
            "ok": bool(row and int(row.get("ok", 0)) == 1),
            "mode": identity.mode(),
            "databaseUrlConfigured": identity.configured_postgres(),
            "latencyMs": round((time.perf_counter() - started) * 1000, 2),
        }
    except Exception as exc:
        return {
            "ok": False,
            "mode": identity.mode(),
            "databaseUrlConfigured": identity.configured_postgres(),
            "latencyMs": round((time.perf_counter() - started) * 1000, 2),
            "error": str(exc)[:500],
        }


def _overview_payload() -> dict:
    storage = _storage_info()
    jobs = _job_metrics()
    ffmpeg = _ffmpeg_processes()
    try:
        load = list(os.getloadavg())
    except Exception:
        load = []
    return {
        "version": "25",
        "generatedAt": _now(),
        "serviceUptimeSeconds": round(time.monotonic() - STARTED_MONOTONIC, 1),
        "systemUptimeSeconds": _system_uptime(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "loadAverage": load,
        "memory": _memory_info(),
        "database": _db_health(),
        "schema": ops.schema_status(),
        "storage": storage,
        "jobs": jobs,
        "ffmpeg": {"active": len(ffmpeg), "processes": ffmpeg[:12]},
        "settings": ops.get_settings(),
    }


def _event(
    level: str,
    category: str,
    message: str,
    *,
    request_id: str | None = None,
    actor_id: str | None = None,
    route: str | None = None,
    method: str | None = None,
    status_code: int | None = None,
    duration_ms: float | None = None,
    details: dict | None = None,
) -> None:
    try:
        identity.execute(
            "INSERT INTO v25_events(id,created_at,level,category,message,request_id,actor_id,route,method,status_code,duration_ms,details_json) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                uuid.uuid4().hex[:18], _now(), level, category, message[:1000], request_id, actor_id,
                route, method, status_code, duration_ms, json.dumps(details or {}, ensure_ascii=False),
            ),
        )
    except Exception as exc:
        print(json.dumps({"level": "error", "category": "v25-event-store", "message": str(exc)[:500]}), flush=True)


def _public_event(row: dict) -> dict:
    try:
        details = json.loads(str(row.get("details_json") or "{}"))
    except Exception:
        details = {}
    return {
        "id": row.get("id"), "createdAt": row.get("created_at"), "level": row.get("level"),
        "category": row.get("category"), "message": row.get("message"), "requestId": row.get("request_id"),
        "actorId": row.get("actor_id"), "route": row.get("route"), "method": row.get("method"),
        "statusCode": row.get("status_code"), "durationMs": row.get("duration_ms"), "details": details,
    }


def _actor_from_request(request: Request) -> dict | None:
    try:
        user, _session = v24._session_by_request(request)
        if user:
            return user
        return v24._legacy_admin(request)
    except Exception:
        return None


def install_observability(app) -> None:
    if getattr(app.state, "v25_observability_installed", False):
        return
    app.state.v25_observability_installed = True

    @app.middleware("http")
    async def v25_observability_middleware(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:20]
        started = time.perf_counter()
        status_code = 500
        response = None
        error: Exception | None = None
        try:
            response = await call_next(request)
            status_code = int(response.status_code)
            return response
        except Exception as exc:
            error = exc
            raise
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            if response is not None:
                response.headers["X-Request-ID"] = request_id
            path = request.url.path
            settings = ops.get_settings()
            slow_ms = float(settings.get("observability.slowRequestMs", 1500) or 1500)
            should_record = (
                path.startswith("/api/")
                and (
                    request.method.upper() not in {"GET", "HEAD", "OPTIONS"}
                    or status_code >= 400
                    or duration_ms >= slow_ms
                    or error is not None
                )
            )
            if should_record:
                actor = _actor_from_request(request)
                level = "error" if status_code >= 500 or error else "warning" if status_code >= 400 or duration_ms >= slow_ms else "info"
                message = "Unhandled request error" if error else f"{request.method} {path} -> {status_code}"
                payload = {
                    "ts": _now(), "level": level, "category": "http", "requestId": request_id,
                    "method": request.method, "route": path, "statusCode": status_code,
                    "durationMs": duration_ms, "actorId": actor.get("id") if actor else None,
                }
                if error:
                    payload["error"] = str(error)[:1000]
                print(json.dumps(payload, ensure_ascii=False), flush=True)
                _event(
                    level, "http", message, request_id=request_id,
                    actor_id=str(actor.get("id")) if actor else None, route=path, method=request.method,
                    status_code=status_code, duration_ms=duration_ms,
                    details={"error": str(error)[:1000]} if error else {},
                )


def _candidate_timestamp(state: dict, path: Path) -> float:
    for key in ("finishedAt", "finished_at", "updatedAt", "updated_at", "createdAt", "created_at"):
        value = _parse_iso(state.get(key))
        if value:
            return value
    try:
        return path.stat().st_mtime
    except OSError:
        return time.time()


def _retention_candidates() -> dict:
    settings = ops.get_settings()
    now = time.time()
    groups: dict[str, dict] = {}
    for name, (root, setting_key) in RETENTION_ROOTS.items():
        days = max(0, int(settings.get(setting_key, 0) or 0))
        cutoff = now - days * 86400
        candidates: list[dict] = []
        if days > 0 and root.exists():
            for folder in root.iterdir():
                if not folder.is_dir():
                    continue
                state_file = folder / "job.json"
                if not state_file.exists():
                    continue
                try:
                    state = json.loads(state_file.read_text(encoding="utf-8"))
                except Exception:
                    continue
                status = str(state.get("status") or "").lower()
                at = _candidate_timestamp(state, state_file)
                if status not in TERMINAL_STATUSES or at > cutoff:
                    continue
                candidates.append({
                    "id": str(state.get("id") or folder.name),
                    "status": status,
                    "path": str(folder),
                    "bytes": _dir_size(folder),
                    "ageDays": round((now - at) / 86400, 1),
                })
        groups[name] = {
            "days": days,
            "count": len(candidates),
            "bytes": sum(item["bytes"] for item in candidates),
            "items": candidates[:200],
        }
    return groups


def _run_retention(actor: dict | None = None) -> dict:
    preview = _retention_candidates()
    removed = 0
    freed = 0
    errors: list[str] = []
    for group in preview.values():
        for item in group["items"]:
            target = Path(item["path"])
            try:
                # Defense in depth: only immediate children of explicitly approved roots are removable.
                if not any(target.parent.resolve() == root.resolve() for root, _key in RETENTION_ROOTS.values()):
                    continue
                shutil.rmtree(target)
                removed += 1
                freed += int(item["bytes"])
            except Exception as exc:
                errors.append(f"{target.name}: {str(exc)[:300]}")
    _event(
        "warning" if errors else "info", "retention", "Retention policy executed",
        actor_id=str(actor.get("id")) if actor else None,
        details={"removed": removed, "freedBytes": freed, "errors": errors[:20]},
    )
    return {"removed": removed, "freedBytes": freed, "errors": errors, "preview": preview}


def _backup_tables() -> dict:
    table_queries = {
        "v24_users": "SELECT * FROM v24_users",
        "v24_teams": "SELECT * FROM v24_teams",
        "v24_team_members": "SELECT * FROM v24_team_members",
        "v24_acl": "SELECT * FROM v24_acl",
        "v24_invites": "SELECT * FROM v24_invites",
        "v24_audit": "SELECT * FROM v24_audit ORDER BY created_at DESC LIMIT 5000",
        "v25_settings": "SELECT * FROM v25_settings",
        "v25_alert_ack": "SELECT * FROM v25_alert_ack",
    }
    return {name: identity.fetchall(query) for name, query in table_queries.items()}


def _create_backup(actor: dict, label: str = "Control Plane Backup", automatic: bool = False) -> dict:
    backup_id = uuid.uuid4().hex[:16]
    created_at = _now()
    payload = {
        "format": "MAGHRABI-V25-CONTROL-PLANE",
        "formatVersion": 1,
        "createdAt": created_at,
        "schema": ops.schema_status(),
        "databaseMode": identity.mode(),
        "tables": _backup_tables(),
        "notes": {
            "encrypted": True,
            "includesMedia": False,
            "excludes": ["sessions", "password_reset_tokens", "login_rate_buckets", "video_media"],
        },
    }
    encrypted = _backup_fernet().encrypt(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    path = BACKUP_DIR / f"{backup_id}.mgbackup"
    path.write_bytes(encrypted)
    manifest = {
        "formatVersion": 1, "automatic": automatic, "includesMedia": False,
        "databaseMode": identity.mode(), "schemaVersion": ops.current_schema_version(),
    }
    identity.execute(
        "INSERT INTO v25_backups(id,label,file_path,size_bytes,created_at,actor_id,actor_name,status,manifest_json) VALUES(?,?,?,?,?,?,?,?,?)",
        (backup_id, label[:160], str(path), len(encrypted), created_at, actor.get("id"), actor.get("name"), "ready", json.dumps(manifest)),
    )
    _event("info", "backup", "Encrypted control-plane backup created", actor_id=str(actor.get("id")), details={"backupId": backup_id, "automatic": automatic})
    return {"id": backup_id, "label": label[:160], "sizeBytes": len(encrypted), "createdAt": created_at, "manifest": manifest}


def _list_backups() -> list[dict]:
    output = []
    for row in identity.fetchall("SELECT * FROM v25_backups ORDER BY created_at DESC LIMIT 100"):
        path = Path(str(row.get("file_path") or ""))
        try:
            manifest = json.loads(str(row.get("manifest_json") or "{}"))
        except Exception:
            manifest = {}
        output.append({
            "id": row.get("id"), "label": row.get("label"), "sizeBytes": row.get("size_bytes"),
            "createdAt": row.get("created_at"), "actorName": row.get("actor_name"), "status": row.get("status"),
            "fileExists": path.exists(), "manifest": manifest,
        })
    return output


def _insert_rows(conn, table: str, rows: list[dict]) -> None:
    if not rows:
        return
    columns = list(rows[0].keys())
    placeholders = ",".join(["%s" if identity.mode() == "postgresql" else "?"] * len(columns))
    sql = f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders})"
    for row in rows:
        conn.execute(sql, tuple(row.get(column) for column in columns))


def _restore_backup(backup_id: str, actor: dict) -> dict:
    row = identity.fetchone("SELECT * FROM v25_backups WHERE id=?", (backup_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Backup غير موجود.")
    path = Path(str(row.get("file_path") or ""))
    if not path.exists():
        raise HTTPException(status_code=404, detail="ملف Backup غير موجود على التخزين.")
    try:
        raw = _backup_fernet().decrypt(path.read_bytes())
        payload = json.loads(raw.decode("utf-8"))
    except (InvalidToken, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=409, detail="تعذر فك تشفير Backup. تأكد أن AUTH_SECRET لم يتغير.") from exc
    if payload.get("format") != "MAGHRABI-V25-CONTROL-PLANE" or int(payload.get("formatVersion", 0)) != 1:
        raise HTTPException(status_code=409, detail="صيغة Backup غير مدعومة.")

    # Safety snapshot before destructive control-plane restore.
    _create_backup(actor, f"Pre-restore safety snapshot {backup_id}", automatic=True)
    tables = payload.get("tables") or {}
    restore_order = ["v24_team_members", "v24_acl", "v24_teams", "v24_invites", "v24_audit", "v24_users", "v25_settings", "v25_alert_ack"]
    delete_order = ["v24_sessions", "v24_password_resets", "v24_login_buckets", "v24_team_members", "v24_acl", "v24_teams", "v24_invites", "v24_audit", "v24_users", "v25_settings", "v25_alert_ack"]
    with identity.connection() as conn:
        for table in delete_order:
            conn.execute(f"DELETE FROM {table}")
        # Insert users before membership/ACL references even though FK constraints are not currently enforced.
        insert_order = ["v24_users", "v24_teams", "v24_team_members", "v24_acl", "v24_invites", "v24_audit", "v25_settings", "v25_alert_ack"]
        for table in insert_order:
            _insert_rows(conn, table, list(tables.get(table) or []))
    ops.seed_defaults()
    _event("warning", "backup", "Control-plane backup restored; sessions revoked", actor_id=str(actor.get("id")), details={"backupId": backup_id})
    return {"ok": True, "backupId": backup_id, "sessionsRevoked": True, "mediaRestored": False}


def _alerts() -> list[dict]:
    overview = _overview_payload()
    settings = overview["settings"]
    alerts: list[dict] = []

    def add(key: str, severity: str, title: str, message: str, details: dict | None = None):
        alerts.append({"key": key, "severity": severity, "title": title, "message": message, "details": details or {}})

    disk = overview["storage"]["disk"]
    used_percent = float(disk["usedPercent"])
    critical = float(settings.get("storage.criticalPercent", 90))
    warn = float(settings.get("storage.warnPercent", 80))
    if used_percent >= critical:
        add("storage.disk.critical", "critical", "Storage critical", f"/data usage reached {used_percent}%.", disk)
    elif used_percent >= warn:
        add("storage.disk.warning", "warning", "Storage warning", f"/data usage reached {used_percent}%.", disk)
    if int(disk["freeBytes"]) < 2 * 1024**3:
        add("storage.free.low", "critical", "Low free space", "Less than 2 GB remains on /data.", disk)
    for category in overview["storage"]["categories"]:
        if category.get("overQuota"):
            add(f"quota.{category['name']}", "warning", "Category quota exceeded", f"{category['name']} exceeded its configured quota.", category)
    if not overview["storage"]["mount"]["dedicatedMount"]:
        add("storage.volume.unverified", "warning", "Persistent volume not verified", "/data is not visible as a dedicated mount in /proc/mounts. Verify Railway Volume configuration.")
    if overview["database"]["mode"] == "sqlite":
        add("database.sqlite", "warning", "SQLite fallback active", "Enterprise identity is running on SQLite. Configure DATABASE_URL for PostgreSQL.")
    if not overview["database"]["ok"]:
        add("database.unhealthy", "critical", "Database check failed", "The identity/operations database health query failed.", overview["database"])
    if overview["schema"]["pending"]:
        add("schema.pending", "critical", "Schema migrations pending", f"{overview['schema']['pending']} V25 migration(s) are pending.", overview["schema"])
    failures = overview["jobs"]["recentFailures24h"]
    if len(failures) >= 10:
        add("jobs.failures.critical", "critical", "High job failure rate", f"{len(failures)} failed jobs were detected in the last 24 hours.")
    elif len(failures) >= 3:
        add("jobs.failures.warning", "warning", "Job failures detected", f"{len(failures)} failed jobs were detected in the last 24 hours.")
    if overview["ffmpeg"]["active"] > 1:
        add("ffmpeg.concurrent", "warning", "Concurrent FFmpeg processes", f"{overview['ffmpeg']['active']} FFmpeg/FFprobe processes are active; CPU contention may increase render time.")
    for category in overview["storage"]["categories"]:
        if category.get("quotaPercent") is not None and float(category["quotaPercent"]) >= 90:
            add(f"quota.near.{category['name']}", "warning", "Quota nearly full", f"{category['name']} is at {category['quotaPercent']}% of its quota.")

    acknowledgements = {row["alert_key"]: row for row in identity.fetchall("SELECT * FROM v25_alert_ack")}
    for alert in alerts:
        ack = acknowledgements.get(alert["key"])
        alert["acknowledged"] = bool(ack)
        alert["acknowledgedAt"] = ack.get("acknowledged_at") if ack else None
        alert["acknowledgedBy"] = ack.get("actor_name") if ack else None
    order = {"critical": 0, "warning": 1, "info": 2}
    alerts.sort(key=lambda item: (order.get(item["severity"], 9), item["key"]))
    return alerts


def _diagnostics() -> dict:
    checks: list[dict] = []

    def check(name: str, ok: bool, message: str, severity: str = "critical", details: dict | None = None):
        checks.append({"name": name, "ok": ok, "message": message, "severity": severity, "details": details or {}})

    db = _db_health()
    check("database", bool(db.get("ok")), f"Database mode: {db.get('mode')}; latency {db.get('latencyMs')} ms", details=db)
    schema = ops.ensure_schema()
    check("schema", schema["current"] == schema["latest"], f"Schema {schema['current']}/{schema['latest']}", details=schema)

    probe = OPS_DIR / ".write-test"
    try:
        OPS_DIR.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok", encoding="utf-8"); probe.unlink(missing_ok=True)
        check("data-write", True, f"{DATA_DIR} is writable.")
    except Exception as exc:
        check("data-write", False, f"{DATA_DIR} write test failed: {exc}")

    for binary in ("ffmpeg", "ffprobe"):
        try:
            result = subprocess.run([binary, "-version"], capture_output=True, text=True, timeout=8)
            first = (result.stdout or result.stderr).splitlines()[0] if (result.stdout or result.stderr) else "unknown"
            check(binary, result.returncode == 0, first[:500])
        except Exception as exc:
            check(binary, False, str(exc)[:500])

    filters: set[str] = set()
    try:
        result = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, timeout=10)
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] and parts[0][0] in "TSC. A V":
                filters.add(parts[1])
        required = ["loudnorm", "subtitles"]
        optional = ["zscale", "tonemap", "vidstabdetect", "vidstabtransform", "deshake", "afftdn", "deesser"]
        for name in required:
            check(f"filter:{name}", name in filters, f"FFmpeg filter {name}: {'available' if name in filters else 'missing'}")
        for name in optional:
            check(f"filter:{name}", name in filters, f"FFmpeg optional filter {name}: {'available' if name in filters else 'missing'}", severity="warning")
    except Exception as exc:
        check("ffmpeg-filters", False, f"Unable to inspect FFmpeg filters: {exc}")

    mount = _data_mount_info()
    check("data-volume", bool(mount["dedicatedMount"]), "Dedicated /data mount detected." if mount["dedicatedMount"] else "Dedicated /data mount was not detected; verify Railway Volume.", severity="warning", details=mount)
    storage = _storage_info()["disk"]
    check("free-space", int(storage["freeBytes"]) >= 2 * 1024**3, f"Free space: {round(int(storage['freeBytes']) / 1024**3, 2)} GB", details=storage)
    check("auth-secret", bool(AUTH_SECRET and len(AUTH_SECRET) >= 32), "AUTH_SECRET is configured with sufficient length." if AUTH_SECRET and len(AUTH_SECRET) >= 32 else "AUTH_SECRET is missing or too short.")

    critical_failed = sum(1 for item in checks if not item["ok"] and item["severity"] == "critical")
    warnings = sum(1 for item in checks if not item["ok"] and item["severity"] == "warning")
    report = {"generatedAt": _now(), "ok": critical_failed == 0, "criticalFailures": critical_failed, "warnings": warnings, "checks": checks}
    _event("error" if critical_failed else "warning" if warnings else "info", "diagnostics", "System diagnostics completed", details={"criticalFailures": critical_failed, "warnings": warnings})
    return report


def _prune_events() -> None:
    settings = ops.get_settings()
    days = max(1, int(settings.get("observability.eventRetentionDays", 30) or 30))
    cutoff = datetime.fromtimestamp(time.time() - days * 86400, tz=timezone.utc).isoformat()
    try:
        identity.execute("DELETE FROM v25_events WHERE created_at < ?", (cutoff,))
        identity.execute("DELETE FROM v25_metric_snapshots WHERE created_at < ?", (datetime.fromtimestamp(time.time() - 7 * 86400, tz=timezone.utc).isoformat(),))
    except Exception:
        pass


def _record_metric_snapshot() -> None:
    payload = _overview_payload()
    compact = {
        "diskUsedPercent": payload["storage"]["disk"]["usedPercent"],
        "memoryUsedPercent": payload["memory"].get("usedPercent"),
        "ffmpegActive": payload["ffmpeg"]["active"],
        "jobCounts": payload["jobs"]["counts"],
        "recentFailures24h": len(payload["jobs"]["recentFailures24h"]),
        "dbLatencyMs": payload["database"].get("latencyMs"),
    }
    identity.execute(
        "INSERT INTO v25_metric_snapshots(id,created_at,metric_type,payload_json) VALUES(?,?,?,?)",
        (uuid.uuid4().hex[:18], _now(), "system", json.dumps(compact, ensure_ascii=False)),
    )


def _background_loop() -> None:
    global _LAST_METRIC_AT, _LAST_RETENTION_AT, _LAST_BACKUP_CHECK_AT
    while True:
        try:
            now_mono = time.monotonic()
            settings = ops.get_settings()
            if now_mono - _LAST_METRIC_AT >= 300:
                _record_metric_snapshot(); _prune_events(); _LAST_METRIC_AT = now_mono
            interval = max(1, int(settings.get("retention.intervalHours", 6) or 6)) * 3600
            if bool(settings.get("retention.autoEnabled")) and now_mono - _LAST_RETENTION_AT >= interval:
                _run_retention(None); _LAST_RETENTION_AT = now_mono
            if now_mono - _LAST_BACKUP_CHECK_AT >= 3600:
                _LAST_BACKUP_CHECK_AT = now_mono
                if bool(settings.get("backup.autoEnabled")):
                    hours = max(1, int(settings.get("backup.intervalHours", 24) or 24))
                    latest = identity.fetchone("SELECT created_at FROM v25_backups WHERE status='ready' ORDER BY created_at DESC LIMIT 1")
                    latest_ts = _parse_iso(latest.get("created_at")) if latest else None
                    if not latest_ts or time.time() - latest_ts >= hours * 3600:
                        _create_backup({"id": "system", "name": "V25 Scheduler", "role": "system"}, "Automatic control-plane backup", automatic=True)
                    keep = max(1, min(100, int(settings.get("backup.keepCount", 10) or 10)))
                    backups = identity.fetchall("SELECT id,file_path FROM v25_backups ORDER BY created_at DESC")
                    for row in backups[keep:]:
                        try:
                            Path(str(row.get("file_path") or "")).unlink(missing_ok=True)
                        except Exception:
                            pass
                        identity.execute("DELETE FROM v25_backups WHERE id=?", (row["id"],))
        except Exception as exc:
            _event("error", "scheduler", "V25 background scheduler error", details={"error": str(exc)[:1000]})
        time.sleep(30)


def start_background_tasks() -> None:
    global _BACKGROUND_STARTED
    with _BACKGROUND_LOCK:
        if _BACKGROUND_STARTED:
            return
        _BACKGROUND_STARTED = True
        thread = threading.Thread(target=_background_loop, name="v25-operations-scheduler", daemon=True)
        thread.start()


@router.get("/health/public")
async def health_public_v25() -> dict:
    db = _db_health()
    return {"ok": bool(db.get("ok")), "version": "25", "databaseMode": db.get("mode")}


@router.get("/overview")
async def overview_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    payload = _overview_payload()
    payload["alerts"] = _alerts()
    payload["backups"] = _list_backups()[:10]
    payload["metricHistory"] = [
        {"createdAt": row.get("created_at"), "payload": json.loads(str(row.get("payload_json") or "{}"))}
        for row in identity.fetchall("SELECT created_at,payload_json FROM v25_metric_snapshots ORDER BY created_at DESC LIMIT 72")
    ]
    return payload


@router.get("/schema")
async def schema_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    return ops.schema_status()


@router.post("/schema/apply")
async def apply_schema_v25(admin: dict = Depends(v24.require_admin_write)) -> dict:
    result = ops.ensure_schema()
    _event("info", "schema", "V25 schema migrations checked/applied", actor_id=str(admin.get("id")), details=result)
    return result


@router.get("/storage")
async def storage_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    return _storage_info()


@router.get("/jobs")
async def jobs_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    return {"jobs": _job_metrics(), "ffmpeg": _ffmpeg_processes()}


@router.get("/telemetry/ffmpeg")
async def ffmpeg_telemetry_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    processes = _ffmpeg_processes()
    return {"active": len(processes), "processes": processes, "generatedAt": _now()}


@router.get("/events")
async def events_v25(
    level: str | None = Query(None), category: str | None = Query(None), limit: int = Query(200, ge=1, le=1000),
    _admin: dict = Depends(v24.require_admin),
) -> dict:
    clauses = []
    params: list[Any] = []
    if level:
        clauses.append("level=?"); params.append(level)
    if category:
        clauses.append("category=?"); params.append(category)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    rows = identity.fetchall(f"SELECT * FROM v25_events{where} ORDER BY created_at DESC LIMIT {int(limit)}", params)
    return {"events": [_public_event(row) for row in rows]}


@router.get("/settings")
async def settings_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    return ops.get_settings()


@router.post("/settings")
async def update_settings_v25(payload: dict = Body(...), admin: dict = Depends(v24.require_admin_write)) -> dict:
    settings = ops.set_settings(payload)
    _event("info", "settings", "Operations settings updated", actor_id=str(admin.get("id")), details={"keys": list(payload.keys())})
    return settings


@router.get("/alerts")
async def alerts_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    values = _alerts()
    return {"alerts": values, "critical": sum(1 for item in values if item["severity"] == "critical" and not item["acknowledged"]), "warning": sum(1 for item in values if item["severity"] == "warning" and not item["acknowledged"])}


@router.post("/alerts/{alert_key}/ack")
async def ack_alert_v25(alert_key: str, payload: dict = Body(...), admin: dict = Depends(v24.require_admin_write)) -> dict:
    acknowledged = bool(payload.get("acknowledged", True))
    if acknowledged:
        if identity.mode() == "postgresql":
            with identity.connection() as conn:
                conn.execute(
                    "INSERT INTO v25_alert_ack(alert_key,acknowledged_at,actor_id,actor_name) VALUES(%s,%s,%s,%s) "
                    "ON CONFLICT(alert_key) DO UPDATE SET acknowledged_at=EXCLUDED.acknowledged_at,actor_id=EXCLUDED.actor_id,actor_name=EXCLUDED.actor_name",
                    (alert_key, _now(), admin.get("id"), admin.get("name")),
                )
        else:
            with identity.connection() as conn:
                conn.execute(
                    "INSERT INTO v25_alert_ack(alert_key,acknowledged_at,actor_id,actor_name) VALUES(?,?,?,?) "
                    "ON CONFLICT(alert_key) DO UPDATE SET acknowledged_at=excluded.acknowledged_at,actor_id=excluded.actor_id,actor_name=excluded.actor_name",
                    (alert_key, _now(), admin.get("id"), admin.get("name")),
                )
    else:
        identity.execute("DELETE FROM v25_alert_ack WHERE alert_key=?", (alert_key,))
    _event("info", "alerts", "Alert acknowledgement changed", actor_id=str(admin.get("id")), details={"alertKey": alert_key, "acknowledged": acknowledged})
    return {"ok": True, "alertKey": alert_key, "acknowledged": acknowledged}


@router.get("/retention/preview")
async def retention_preview_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    return {"groups": _retention_candidates()}


@router.post("/retention/run")
async def retention_run_v25(admin: dict = Depends(v24.require_admin_write)) -> dict:
    return _run_retention(admin)


@router.get("/backups")
async def backups_v25(_admin: dict = Depends(v24.require_admin)) -> dict:
    return {"backups": _list_backups(), "scope": "encrypted-control-plane", "includesMedia": False}


@router.post("/backups")
async def create_backup_v25(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    label = str(payload.get("label") or "Manual Control Plane Backup")[:160]
    return _create_backup(admin, label, automatic=False)


@router.get("/backups/{backup_id}/download")
async def download_backup_v25(backup_id: str, _admin: dict = Depends(v24.require_admin)) -> FileResponse:
    row = identity.fetchone("SELECT * FROM v25_backups WHERE id=?", (backup_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Backup غير موجود.")
    path = Path(str(row.get("file_path") or ""))
    if not path.exists():
        raise HTTPException(status_code=404, detail="ملف Backup غير موجود.")
    return FileResponse(path, media_type="application/octet-stream", filename=f"MAGHRABI-v25-{backup_id}.mgbackup")


@router.post("/backups/{backup_id}/restore")
async def restore_backup_v25(backup_id: str, payload: dict = Body(...), admin: dict = Depends(v24.require_admin_write)) -> dict:
    if str(payload.get("confirm") or "") != "RESTORE":
        raise HTTPException(status_code=400, detail="للتأكيد أرسل confirm بقيمة RESTORE. الاستعادة تلغي جميع Sessions الحالية.")
    return _restore_backup(backup_id, admin)


@router.delete("/backups/{backup_id}")
async def delete_backup_v25(backup_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    row = identity.fetchone("SELECT * FROM v25_backups WHERE id=?", (backup_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Backup غير موجود.")
    try:
        Path(str(row.get("file_path") or "")).unlink(missing_ok=True)
    except Exception:
        pass
    identity.execute("DELETE FROM v25_backups WHERE id=?", (backup_id,))
    _event("warning", "backup", "Backup deleted", actor_id=str(admin.get("id")), details={"backupId": backup_id})
    return {"ok": True}


@router.post("/diagnostics/run")
async def diagnostics_v25(admin: dict = Depends(v24.require_admin_write)) -> dict:
    report = _diagnostics()
    _event("info" if report["ok"] else "error", "diagnostics", "Diagnostics requested by admin", actor_id=str(admin.get("id")), details={"ok": report["ok"], "criticalFailures": report["criticalFailures"]})
    return report


ops.ensure_schema()
start_background_tasks()
