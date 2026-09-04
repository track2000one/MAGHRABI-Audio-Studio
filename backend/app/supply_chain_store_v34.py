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
    try: return json.loads(value or "")
    except Exception: return default


def ensure_schema() -> None:
    for sql in [
        "CREATE TABLE IF NOT EXISTS v34_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        """CREATE TABLE IF NOT EXISTS v34_assessments (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, candidate_sha TEXT NOT NULL,
            python_lock_json TEXT NOT NULL, workflow_json TEXT NOT NULL,
            github_attestation_json TEXT NOT NULL, v33_json TEXT NOT NULL,
            policy_json TEXT NOT NULL, gate_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS v34_waivers (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL, candidate_sha TEXT NOT NULL,
            blocker_code TEXT NOT NULL, reason TEXT NOT NULL, approver_id TEXT NOT NULL,
            expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS v34_events (
            id TEXT PRIMARY KEY, release_id TEXT, action TEXT NOT NULL,
            actor_id TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL
        )""",
    ]: db.execute(sql)
    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_v34_assess_release ON v34_assessments(release_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_v34_assess_sha ON v34_assessments(candidate_sha)",
        "CREATE INDEX IF NOT EXISTS idx_v34_waiver_release ON v34_waivers(release_id, candidate_sha, expires_at)",
        "CREATE INDEX IF NOT EXISTS idx_v34_events_created ON v34_events(created_at)",
    ]: db.execute(sql)
    set_meta("schema_version", str(LATEST_SCHEMA))


def set_meta(key: str, value: str) -> None:
    if db.mode() == "postgresql":
        db.execute("INSERT INTO v34_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", (key,value))
    else:
        db.execute("INSERT INTO v34_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key,value))


def get_meta(key: str, default: str | None=None) -> str | None:
    row=db.fetchone("SELECT value FROM v34_meta WHERE key=?",(key,)); return str(row["value"]) if row else default


def schema_status() -> dict:
    current=int(get_meta("schema_version","0") or 0)
    return {"current":current,"latest":LATEST_SCHEMA,"pending":max(0,LATEST_SCHEMA-current),"databaseMode":db.mode()}


def policy() -> dict:
    default={
        "requirePythonHashLock":True,
        "requireTorchCpuPins":True,
        "requireCrossRunnerReproducible":True,
        "requireSyftArtifactSbom":True,
        "requireArtifactScanner":True,
        "requireCriticalScanGate":True,
        "requireGithubOidcStep":True,
        "requireGithubAttestationApi":False,
        "requireV33ProductionGate":True,
        "requirePostgresForProduction":False,
        "allowTemporaryWaivers":True,
        "waiverMaxHours":168,
        "maxEvidenceAgeMinutes":120,
    }
    saved=_json(get_meta("policy_json"),{})
    return {**default,**saved}


def save_policy(value: dict) -> dict:
    merged={**policy(),**value}
    merged["maxEvidenceAgeMinutes"]=max(5,min(1440,int(merged.get("maxEvidenceAgeMinutes",120) or 120)))
    merged["waiverMaxHours"]=max(1,min(720,int(merged.get("waiverMaxHours",168) or 168)))
    set_meta("policy_json",json.dumps(merged,ensure_ascii=False,separators=(",",":")))
    return merged


def _assessment(row: dict | None) -> dict | None:
    if not row: return None
    return {"id":row["id"],"releaseId":row["release_id"],"candidateSha":row["candidate_sha"],
            "pythonLock":_json(row["python_lock_json"],{}),"workflow":_json(row["workflow_json"],{}),
            "githubAttestation":_json(row["github_attestation_json"],{}),"v33":_json(row["v33_json"],{}),
            "policy":_json(row["policy_json"],{}),"gate":_json(row["gate_json"],{}),
            "createdAt":row["created_at"],"updatedAt":row["updated_at"]}


def create_assessment(*,release_id:str,candidate_sha:str,python_lock:dict,workflow:dict,github_attestation:dict,v33:dict,policy_value:dict,gate:dict)->dict:
    aid=uuid.uuid4().hex[:20]; now=_now()
    db.execute("INSERT INTO v34_assessments(id,release_id,candidate_sha,python_lock_json,workflow_json,github_attestation_json,v33_json,policy_json,gate_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
               (aid,release_id,candidate_sha,json.dumps(python_lock,ensure_ascii=False),json.dumps(workflow,ensure_ascii=False),json.dumps(github_attestation,ensure_ascii=False),json.dumps(v33,ensure_ascii=False),json.dumps(policy_value,ensure_ascii=False),json.dumps(gate,ensure_ascii=False),now,now))
    return get_assessment(aid) or {}


def get_assessment(aid:str)->dict|None: return _assessment(db.fetchone("SELECT * FROM v34_assessments WHERE id=?",(aid,)))

def latest_assessment(release_id:str,candidate_sha:str|None=None)->dict|None:
    if candidate_sha: row=db.fetchone("SELECT * FROM v34_assessments WHERE release_id=? AND candidate_sha=? ORDER BY created_at DESC LIMIT 1",(release_id,candidate_sha))
    else: row=db.fetchone("SELECT * FROM v34_assessments WHERE release_id=? ORDER BY created_at DESC LIMIT 1",(release_id,))
    return _assessment(row)

def list_assessments(limit:int=30)->list[dict]:
    return [_assessment(r) for r in db.fetchall("SELECT * FROM v34_assessments ORDER BY created_at DESC LIMIT ?",(max(1,min(limit,200)),)) if r]


def _waiver(row:dict|None)->dict|None:
    if not row:return None
    return {"id":row["id"],"releaseId":row["release_id"],"candidateSha":row["candidate_sha"],"blockerCode":row["blocker_code"],"reason":row["reason"],"approverId":row["approver_id"],"expiresAt":row["expires_at"],"createdAt":row["created_at"],"revokedAt":row.get("revoked_at")}


def create_waiver(*,release_id:str,candidate_sha:str,blocker_code:str,reason:str,approver_id:str,expires_at:str)->dict:
    wid=uuid.uuid4().hex[:20]; now=_now()
    db.execute("INSERT INTO v34_waivers(id,release_id,candidate_sha,blocker_code,reason,approver_id,expires_at,created_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL)",(wid,release_id,candidate_sha,blocker_code,reason,approver_id,expires_at,now))
    return waiver(wid) or {}

def waiver(wid:str)->dict|None:return _waiver(db.fetchone("SELECT * FROM v34_waivers WHERE id=?",(wid,)))

def waivers(release_id:str|None=None,limit:int=100)->list[dict]:
    if release_id: rows=db.fetchall("SELECT * FROM v34_waivers WHERE release_id=? ORDER BY created_at DESC LIMIT ?",(release_id,max(1,min(limit,200))))
    else: rows=db.fetchall("SELECT * FROM v34_waivers ORDER BY created_at DESC LIMIT ?",(max(1,min(limit,200)),))
    return [_waiver(r) for r in rows if r]

def revoke_waiver(wid:str)->dict|None:
    db.execute("UPDATE v34_waivers SET revoked_at=? WHERE id=?",(_now(),wid)); return waiver(wid)


def event(action:str,*,release_id:str|None=None,actor_id:str|None=None,details:dict|None=None)->None:
    db.execute("INSERT INTO v34_events(id,release_id,action,actor_id,details_json,created_at) VALUES(?,?,?,?,?,?)",(uuid.uuid4().hex[:20],release_id,action,actor_id,json.dumps(details or {},ensure_ascii=False),_now()))

def events(limit:int=100)->list[dict]:
    rows=db.fetchall("SELECT * FROM v34_events ORDER BY created_at DESC LIMIT ?",(max(1,min(limit,500)),))
    return [{"id":r["id"],"releaseId":r.get("release_id"),"action":r["action"],"actorId":r.get("actor_id"),"details":_json(r["details_json"],{}),"createdAt":r["created_at"]} for r in rows]

ensure_schema()
