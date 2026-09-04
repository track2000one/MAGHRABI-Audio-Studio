from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from . import identity_store_v24 as db

LATEST_SCHEMA = 4


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
        "CREATE TABLE IF NOT EXISTS v33_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        """CREATE TABLE IF NOT EXISTS v33_assessments (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, candidate_sha TEXT NOT NULL,
            locks_json TEXT NOT NULL, build_json TEXT NOT NULL, artifact_sbom_json TEXT NOT NULL,
            oci_json TEXT NOT NULL, attestation_json TEXT NOT NULL, opa_json TEXT NOT NULL,
            policy_json TEXT NOT NULL, gate_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v33_attestations (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, candidate_sha TEXT NOT NULL,
            environment TEXT NOT NULL, subject_name TEXT NOT NULL, digest_sha256 TEXT NOT NULL,
            mode TEXT NOT NULL, issuer TEXT, identity TEXT, bundle_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v33_oci_evidence (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, candidate_sha TEXT NOT NULL,
            image_ref TEXT NOT NULL, digest_sha256 TEXT NOT NULL, status TEXT NOT NULL,
            verifier TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v33_events (
            id TEXT PRIMARY KEY, release_id TEXT, action TEXT NOT NULL,
            actor_id TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL
        )""",
    ]
    for sql in statements:
        db.execute(sql)
    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_v33_assess_release ON v33_assessments(release_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v33_assess_sha ON v33_assessments(candidate_sha)",
        "CREATE INDEX IF NOT EXISTS idx_v33_attest_release ON v33_attestations(release_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v33_oci_release ON v33_oci_evidence(release_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v33_events_created ON v33_events(created_at)",
    ]:
        db.execute(sql)
    set_meta("schema_version", str(LATEST_SCHEMA))


def set_meta(key: str, value: str) -> None:
    if db.mode() == "postgresql":
        db.execute("INSERT INTO v33_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", (key, value))
    else:
        db.execute("INSERT INTO v33_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def get_meta(key: str, default: str | None = None) -> str | None:
    row = db.fetchone("SELECT value FROM v33_meta WHERE key=?", (key,))
    return str(row["value"]) if row else default


def schema_status() -> dict:
    current = int(get_meta("schema_version", "0") or 0)
    return {"current": current, "latest": LATEST_SCHEMA, "pending": max(0, LATEST_SCHEMA-current), "databaseMode": db.mode()}


def policy() -> dict:
    default = {
        "enforceStaging": False,
        "requireFrontendLock": True,
        "requireLockIntegrity": True,
        "requireExactBackendPins": True,
        "requireReproducibleBuildForProduction": True,
        "requireBuildEvidenceForProduction": True,
        "requireGithubOidcAttestationForProduction": False,
        "requireExternalAttestationForProduction": False,
        "requireOciDigestForProduction": False,
        "requireOpaAllowForProduction": True,
        "requireV32ProductionGate": True,
        "blockDependencyLockDrift": False,
        "maxAssessmentAgeMinutes": 120,
    }
    saved = _json(get_meta("policy_json"), {})
    return {**default, **saved}


def save_policy(value: dict) -> dict:
    merged = {**policy(), **value}
    merged["maxAssessmentAgeMinutes"] = max(5, min(1440, int(merged.get("maxAssessmentAgeMinutes", 120) or 120)))
    set_meta("policy_json", json.dumps(merged, ensure_ascii=False, separators=(",", ":")))
    return merged


def _assessment(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "id": row["id"], "releaseId": row["release_id"], "candidateSha": row["candidate_sha"],
        "locks": _json(row["locks_json"], {}), "build": _json(row["build_json"], {}),
        "artifactSbom": _json(row["artifact_sbom_json"], {}), "oci": _json(row["oci_json"], {}),
        "attestation": _json(row["attestation_json"], {}), "opa": _json(row["opa_json"], {}),
        "policy": _json(row["policy_json"], {}), "gate": _json(row["gate_json"], {}),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def create_assessment(*, release_id: str, candidate_sha: str, locks: dict, build: dict,
                      artifact_sbom: dict, oci: dict, attestation: dict, opa: dict,
                      policy_value: dict, gate: dict) -> dict:
    aid = uuid.uuid4().hex[:20]
    now = _now()
    db.execute("""INSERT INTO v33_assessments(
        id,release_id,candidate_sha,locks_json,build_json,artifact_sbom_json,oci_json,
        attestation_json,opa_json,policy_json,gate_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        aid, release_id, candidate_sha, json.dumps(locks,ensure_ascii=False), json.dumps(build,ensure_ascii=False),
        json.dumps(artifact_sbom,ensure_ascii=False), json.dumps(oci,ensure_ascii=False),
        json.dumps(attestation,ensure_ascii=False), json.dumps(opa,ensure_ascii=False),
        json.dumps(policy_value,ensure_ascii=False), json.dumps(gate,ensure_ascii=False), now, now,
    ))
    return get_assessment(aid) or {}


def get_assessment(assessment_id: str) -> dict | None:
    return _assessment(db.fetchone("SELECT * FROM v33_assessments WHERE id=?", (assessment_id,)))


def latest_assessment(release_id: str, candidate_sha: str | None = None) -> dict | None:
    if candidate_sha:
        row = db.fetchone("SELECT * FROM v33_assessments WHERE release_id=? AND candidate_sha=? ORDER BY created_at DESC LIMIT 1", (release_id,candidate_sha))
    else:
        row = db.fetchone("SELECT * FROM v33_assessments WHERE release_id=? ORDER BY created_at DESC LIMIT 1", (release_id,))
    return _assessment(row)


def list_assessments(limit: int = 40) -> list[dict]:
    return [_assessment(row) for row in db.fetchall("SELECT * FROM v33_assessments ORDER BY created_at DESC LIMIT ?", (max(1,min(limit,200)),)) if row]


def add_attestation(*, release_id: str, candidate_sha: str, environment: str, subject_name: str,
                    digest_sha256: str, mode: str, issuer: str | None, identity: str | None, bundle: dict) -> dict:
    item_id = uuid.uuid4().hex[:20]; now = _now()
    db.execute("INSERT INTO v33_attestations(id,release_id,candidate_sha,environment,subject_name,digest_sha256,mode,issuer,identity,bundle_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
               (item_id,release_id,candidate_sha,environment,subject_name,digest_sha256.lower(),mode,issuer,identity,json.dumps(bundle,ensure_ascii=False),now))
    return attestation(item_id) or {}


def attestation(item_id: str) -> dict | None:
    row = db.fetchone("SELECT * FROM v33_attestations WHERE id=?", (item_id,))
    if not row: return None
    return {"id":row["id"],"releaseId":row["release_id"],"candidateSha":row["candidate_sha"],"environment":row["environment"],
            "subjectName":row["subject_name"],"digestSha256":row["digest_sha256"],"mode":row["mode"],"issuer":row.get("issuer"),
            "identity":row.get("identity"),"bundle":_json(row["bundle_json"],{}),"createdAt":row["created_at"]}


def attestations(release_id: str, candidate_sha: str | None = None, limit: int = 50) -> list[dict]:
    if candidate_sha:
        rows=db.fetchall("SELECT id FROM v33_attestations WHERE release_id=? AND candidate_sha=? ORDER BY created_at DESC LIMIT ?",(release_id,candidate_sha,max(1,min(limit,100))))
    else:
        rows=db.fetchall("SELECT id FROM v33_attestations WHERE release_id=? ORDER BY created_at DESC LIMIT ?",(release_id,max(1,min(limit,100))))
    return [x for row in rows if (x:=attestation(row["id"]))]


def add_oci(*, release_id: str, candidate_sha: str, image_ref: str, digest_sha256: str,
            status: str, verifier: str, metadata: dict) -> dict:
    item_id=uuid.uuid4().hex[:20]; now=_now()
    db.execute("INSERT INTO v33_oci_evidence(id,release_id,candidate_sha,image_ref,digest_sha256,status,verifier,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
               (item_id,release_id,candidate_sha,image_ref,digest_sha256.lower(),status,verifier,json.dumps(metadata,ensure_ascii=False),now))
    return oci(item_id) or {}


def oci(item_id: str) -> dict | None:
    row=db.fetchone("SELECT * FROM v33_oci_evidence WHERE id=?",(item_id,))
    if not row: return None
    return {"id":row["id"],"releaseId":row["release_id"],"candidateSha":row["candidate_sha"],"imageRef":row["image_ref"],
            "digestSha256":row["digest_sha256"],"status":row["status"],"verifier":row["verifier"],"metadata":_json(row["metadata_json"],{}),"createdAt":row["created_at"]}


def latest_oci(release_id: str, candidate_sha: str) -> dict | None:
    row=db.fetchone("SELECT id FROM v33_oci_evidence WHERE release_id=? AND candidate_sha=? ORDER BY created_at DESC LIMIT 1",(release_id,candidate_sha))
    return oci(row["id"]) if row else None


def event(action: str, *, release_id: str | None = None, actor_id: str | None = None, details: dict | None = None) -> None:
    db.execute("INSERT INTO v33_events(id,release_id,action,actor_id,details_json,created_at) VALUES(?,?,?,?,?,?)",
               (uuid.uuid4().hex[:20],release_id,action,actor_id,json.dumps(details or {},ensure_ascii=False),_now()))


def events(limit: int = 100) -> list[dict]:
    rows=db.fetchall("SELECT * FROM v33_events ORDER BY created_at DESC LIMIT ?",(max(1,min(limit,500)),))
    return [{"id":r["id"],"releaseId":r.get("release_id"),"action":r["action"],"actorId":r.get("actor_id"),"details":_json(r["details_json"],{}),"createdAt":r["created_at"]} for r in rows]


ensure_schema()
