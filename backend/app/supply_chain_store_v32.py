from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from . import identity_store_v24 as db

LATEST_SCHEMA = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value, default):
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value or "")
    except Exception:
        return default


def ensure_schema() -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS v32_meta (
            key TEXT PRIMARY KEY, value TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v32_scans (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, repository TEXT NOT NULL,
            candidate_sha TEXT NOT NULL, status TEXT NOT NULL,
            sbom_json TEXT NOT NULL, vulnerabilities_json TEXT NOT NULL,
            signatures_json TEXT NOT NULL, rules_json TEXT NOT NULL,
            drift_json TEXT NOT NULL, licenses_json TEXT NOT NULL,
            artifact_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
            policy_json TEXT NOT NULL, gate_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v32_artifacts (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, environment TEXT NOT NULL,
            name TEXT NOT NULL, digest_sha256 TEXT NOT NULL, size_bytes INTEGER,
            source TEXT NOT NULL, metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL, verified_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v32_config_baselines (
            id TEXT PRIMARY KEY, environment TEXT NOT NULL UNIQUE,
            fingerprints_json TEXT NOT NULL, names_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v32_events (
            id TEXT PRIMARY KEY, release_id TEXT, action TEXT NOT NULL,
            actor_id TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL
        )""",
    ]
    for sql in statements:
        db.execute(sql)
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_v32_scans_release ON v32_scans(release_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v32_scans_sha ON v32_scans(candidate_sha)",
        "CREATE INDEX IF NOT EXISTS idx_v32_artifacts_release ON v32_artifacts(release_id, environment)",
        "CREATE INDEX IF NOT EXISTS idx_v32_events_created ON v32_events(created_at)",
    ]
    for sql in indexes:
        db.execute(sql)
    set_meta("schema_version", str(LATEST_SCHEMA))


def set_meta(key: str, value: str) -> None:
    if db.mode() == "postgresql":
        db.execute("INSERT INTO v32_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", (key, value))
    else:
        db.execute("INSERT INTO v32_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def get_meta(key: str, default: str | None = None) -> str | None:
    row = db.fetchone("SELECT value FROM v32_meta WHERE key=?", (key,))
    return str(row["value"]) if row else default


def schema_status() -> dict:
    current = int(get_meta("schema_version", "0") or 0)
    return {"current": current, "latest": LATEST_SCHEMA, "pending": max(0, LATEST_SCHEMA-current), "databaseMode": db.mode()}


def policy() -> dict:
    default = {
        "blockCritical": True,
        "blockHigh": True,
        "warnUnknownVulnerabilitySeverity": True,
        "requireVerifiedCommitForProduction": False,
        "requireProtectedBranchForProduction": False,
        "requireArtifactDigestForProduction": False,
        "requireConfigBaselineForProduction": False,
        "blockConfigDriftForProduction": True,
        "deniedLicenses": ["AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0"],
        "warnLicenses": ["GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later"],
        "maxScanAgeMinutes": 120,
    }
    saved = _json(get_meta("policy_json"), {})
    return {**default, **saved}


def save_policy(value: dict) -> dict:
    merged = {**policy(), **value}
    merged["maxScanAgeMinutes"] = max(5, min(1440, int(merged.get("maxScanAgeMinutes", 120) or 120)))
    merged["deniedLicenses"] = [str(x)[:80] for x in (merged.get("deniedLicenses") or [])][:50]
    merged["warnLicenses"] = [str(x)[:80] for x in (merged.get("warnLicenses") or [])][:50]
    set_meta("policy_json", json.dumps(merged, ensure_ascii=False, separators=(",", ":")))
    return merged


def _scan(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "id": row["id"], "releaseId": row["release_id"], "repository": row["repository"],
        "candidateSha": row["candidate_sha"], "status": row["status"],
        "sbom": _json(row["sbom_json"], {}), "vulnerabilities": _json(row["vulnerabilities_json"], {}),
        "signatures": _json(row["signatures_json"], {}), "rules": _json(row["rules_json"], {}),
        "drift": _json(row["drift_json"], {}), "licenses": _json(row["licenses_json"], {}),
        "artifact": _json(row["artifact_json"], {}), "provenance": _json(row["provenance_json"], {}),
        "policy": _json(row["policy_json"], {}), "gate": _json(row["gate_json"], {}),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def create_scan(*, release_id: str, repository: str, candidate_sha: str, status: str,
                sbom: dict, vulnerabilities: dict, signatures: dict, rules: dict,
                drift: dict, licenses: dict, artifact: dict, provenance: dict,
                policy_value: dict, gate: dict) -> dict:
    sid = uuid.uuid4().hex[:20]
    now = _now()
    db.execute("""INSERT INTO v32_scans(
        id,release_id,repository,candidate_sha,status,sbom_json,vulnerabilities_json,
        signatures_json,rules_json,drift_json,licenses_json,artifact_json,provenance_json,
        policy_json,gate_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        sid,release_id,repository,candidate_sha,status,
        json.dumps(sbom,ensure_ascii=False),json.dumps(vulnerabilities,ensure_ascii=False),
        json.dumps(signatures,ensure_ascii=False),json.dumps(rules,ensure_ascii=False),
        json.dumps(drift,ensure_ascii=False),json.dumps(licenses,ensure_ascii=False),
        json.dumps(artifact,ensure_ascii=False),json.dumps(provenance,ensure_ascii=False),
        json.dumps(policy_value,ensure_ascii=False),json.dumps(gate,ensure_ascii=False),now,now,
    ))
    return get_scan(sid) or {}


def get_scan(scan_id: str) -> dict | None:
    return _scan(db.fetchone("SELECT * FROM v32_scans WHERE id=?", (scan_id,)))


def latest_scan(release_id: str, candidate_sha: str | None = None) -> dict | None:
    if candidate_sha:
        row = db.fetchone("SELECT * FROM v32_scans WHERE release_id=? AND candidate_sha=? ORDER BY created_at DESC LIMIT 1", (release_id,candidate_sha))
    else:
        row = db.fetchone("SELECT * FROM v32_scans WHERE release_id=? ORDER BY created_at DESC LIMIT 1", (release_id,))
    return _scan(row)


def list_scans(limit: int = 30) -> list[dict]:
    return [_scan(row) for row in db.fetchall("SELECT * FROM v32_scans ORDER BY created_at DESC LIMIT ?", (max(1,min(200,limit)),)) if row]


def register_artifact(*, release_id: str, environment: str, name: str, digest_sha256: str,
                      size_bytes: int | None, source: str, metadata: dict) -> dict:
    aid = uuid.uuid4().hex[:20]
    now = _now()
    db.execute("INSERT INTO v32_artifacts(id,release_id,environment,name,digest_sha256,size_bytes,source,metadata_json,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
               (aid,release_id,environment,name,digest_sha256.lower(),size_bytes,source,json.dumps(metadata,ensure_ascii=False),now,now))
    return artifact(aid) or {}


def artifact(artifact_id: str) -> dict | None:
    row = db.fetchone("SELECT * FROM v32_artifacts WHERE id=?", (artifact_id,))
    if not row: return None
    return {"id":row["id"],"releaseId":row["release_id"],"environment":row["environment"],"name":row["name"],
            "digestSha256":row["digest_sha256"],"sizeBytes":row.get("size_bytes"),"source":row["source"],
            "metadata":_json(row["metadata_json"],{}),"createdAt":row["created_at"],"verifiedAt":row.get("verified_at")}


def latest_artifact(release_id: str, environment: str | None = None) -> dict | None:
    if environment:
        row = db.fetchone("SELECT id FROM v32_artifacts WHERE release_id=? AND environment=? ORDER BY created_at DESC LIMIT 1", (release_id,environment))
    else:
        row = db.fetchone("SELECT id FROM v32_artifacts WHERE release_id=? ORDER BY created_at DESC LIMIT 1", (release_id,))
    return artifact(row["id"]) if row else None


def artifacts(release_id: str, limit: int = 30) -> list[dict]:
    rows = db.fetchall("SELECT id FROM v32_artifacts WHERE release_id=? ORDER BY created_at DESC LIMIT ?", (release_id,max(1,min(limit,100))))
    return [x for row in rows if (x:=artifact(row["id"]))]


def save_baseline(environment: str, fingerprints: dict, names: list[str]) -> dict:
    now = _now(); existing = db.fetchone("SELECT id FROM v32_config_baselines WHERE environment=?", (environment,))
    if existing:
        db.execute("UPDATE v32_config_baselines SET fingerprints_json=?,names_json=?,updated_at=? WHERE environment=?",
                   (json.dumps(fingerprints,sort_keys=True),json.dumps(names),now,environment))
    else:
        db.execute("INSERT INTO v32_config_baselines(id,environment,fingerprints_json,names_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                   (uuid.uuid4().hex[:20],environment,json.dumps(fingerprints,sort_keys=True),json.dumps(names),now,now))
    return baseline(environment) or {}


def baseline(environment: str) -> dict | None:
    row = db.fetchone("SELECT * FROM v32_config_baselines WHERE environment=?", (environment,))
    if not row: return None
    return {"id":row["id"],"environment":row["environment"],"fingerprints":_json(row["fingerprints_json"],{}),
            "names":_json(row["names_json"],[]),"createdAt":row["created_at"],"updatedAt":row["updated_at"]}


def baselines() -> list[dict]:
    return [x for row in db.fetchall("SELECT environment FROM v32_config_baselines ORDER BY environment") if (x:=baseline(row["environment"]))]


def event(action: str, *, release_id: str | None = None, actor_id: str | None = None, details: dict | None = None) -> None:
    db.execute("INSERT INTO v32_events(id,release_id,action,actor_id,details_json,created_at) VALUES(?,?,?,?,?,?)",
               (uuid.uuid4().hex[:20],release_id,action,actor_id,json.dumps(details or {},ensure_ascii=False),_now()))


def events(limit: int = 100) -> list[dict]:
    rows = db.fetchall("SELECT * FROM v32_events ORDER BY created_at DESC LIMIT ?", (max(1,min(limit,500)),))
    return [{"id":r["id"],"releaseId":r.get("release_id"),"action":r["action"],"actorId":r.get("actor_id"),"details":_json(r["details_json"],{}),"createdAt":r["created_at"]} for r in rows]


ensure_schema()
