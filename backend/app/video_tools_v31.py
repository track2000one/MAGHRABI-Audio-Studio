from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from . import gitops_store_v31 as store
from . import reliability_store_v26 as rel26
from . import video_tools_v24 as v24
from . import video_tools_v30_runtime as v30rt
from .main import AUTH_SECRET, DATA_DIR

router = APIRouter(prefix="/api/video/v31", tags=["video-studio-v31"])

DEFAULT_REPOSITORY = os.getenv("V31_GITHUB_REPOSITORY", "track2000one/MAGHRABI-Audio-Studio").strip()
GITHUB_TOKEN = os.getenv("V31_GITHUB_TOKEN", "").strip()
DEPLOY_WEBHOOK_URL = os.getenv("V31_DEPLOY_WEBHOOK_URL", "").strip()
DEPLOY_WEBHOOK_TOKEN = os.getenv("V31_DEPLOY_WEBHOOK_TOKEN", "").strip()

ENVIRONMENTS = ["dev", "staging", "production"]
DEFAULT_MANIFEST = {
    "environments": ENVIRONMENTS,
    "requiredApprovals": {"dev": 0, "staging": 0, "production": 1},
    "requireCiSuccess": True,
    "freezeProtection": True,
    "useV30ProgressiveProduction": True,
    "v30AutoPromote": False,
    "v30AutoRollback": True,
    "v30HoldSeconds": 120,
    "v30MinSamplesPerCohort": 10,
}

DIR = DATA_DIR / "video_gitops"
EVIDENCE_DIR = DIR / "evidence"
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

_STOP = threading.Event()
_STARTED = False
_START_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _manifest(release: dict) -> dict:
    raw = release.get("manifest") if isinstance(release.get("manifest"), dict) else {}
    merged = {**DEFAULT_MANIFEST, **raw}
    approvals = dict(DEFAULT_MANIFEST["requiredApprovals"])
    if isinstance(raw.get("requiredApprovals"), dict):
        approvals.update(raw["requiredApprovals"])
    merged["requiredApprovals"] = approvals
    return merged


def _github_config() -> dict:
    return {
        "repository": DEFAULT_REPOSITORY,
        "tokenConfigured": bool(GITHUB_TOKEN),
        "mode": "authenticated" if GITHUB_TOKEN else "public-api",
    }


def _github_get(repository: str, path: str) -> dict | list:
    if "/" not in repository:
        raise RuntimeError("GitHub repository must be owner/name.")
    url = f"https://api.github.com/repos/{repository}/{path.lstrip('/')}"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "MAGHRABI-V31/1.0", "X-GitHub-Api-Version": "2022-11-28"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read(2 * 1024 * 1024)
        return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read(2048).decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"GitHub API HTTP {exc.code}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GitHub API unavailable: {exc.reason}") from exc


def _resolve_commit(repository: str, ref: str) -> dict:
    data = _github_get(repository, f"commits/{urllib.parse.quote(ref, safe='')}")
    if not isinstance(data, dict) or not data.get("sha"):
        raise RuntimeError("تعذر Resolve للـGit ref إلى SHA.")
    commit = data.get("commit") if isinstance(data.get("commit"), dict) else {}
    author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
    parents = data.get("parents") if isinstance(data.get("parents"), list) else []
    return {
        "sha": str(data.get("sha")),
        "message": str(commit.get("message") or ""),
        "author": author.get("name"),
        "date": author.get("date"),
        "htmlUrl": data.get("html_url"),
        "parentSha": str((parents[0] or {}).get("sha")) if parents else None,
    }


def _workflow_evidence(repository: str, sha: str) -> dict:
    data = _github_get(repository, f"actions/runs?head_sha={urllib.parse.quote(sha, safe='')}&per_page=20")
    runs = data.get("workflow_runs", []) if isinstance(data, dict) else []
    public = []
    for run in runs[:20]:
        if not isinstance(run, dict):
            continue
        public.append({
            "id": run.get("id"), "name": run.get("name"), "status": run.get("status"),
            "conclusion": run.get("conclusion"), "event": run.get("event"),
            "createdAt": run.get("created_at"), "updatedAt": run.get("updated_at"),
            "htmlUrl": run.get("html_url"),
        })
    completed = [run for run in public if run.get("status") == "completed"]
    failures = [run for run in completed if run.get("conclusion") not in {"success", "neutral", "skipped"}]
    success = any(run.get("conclusion") == "success" for run in completed) and not failures
    return {"runs": public, "completed": len(completed), "failures": len(failures), "success": success}


def _release_notes(repository: str, base_sha: str | None, candidate_sha: str, candidate_commit: dict) -> list[dict]:
    if not base_sha or base_sha == candidate_sha:
        return [{"sha": candidate_sha, "message": candidate_commit.get("message"), "author": candidate_commit.get("author"), "date": candidate_commit.get("date")}]
    try:
        data = _github_get(repository, f"compare/{urllib.parse.quote(base_sha, safe='')}...{urllib.parse.quote(candidate_sha, safe='')}")
        commits = data.get("commits", []) if isinstance(data, dict) else []
        notes = []
        for item in commits[-80:]:
            commit = item.get("commit") if isinstance(item, dict) and isinstance(item.get("commit"), dict) else {}
            author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
            notes.append({
                "sha": item.get("sha"), "message": str(commit.get("message") or "").splitlines()[0][:300],
                "author": author.get("name"), "date": author.get("date"), "htmlUrl": item.get("html_url"),
            })
        return notes or [{"sha": candidate_sha, "message": candidate_commit.get("message"), "author": candidate_commit.get("author"), "date": candidate_commit.get("date")}]
    except Exception as exc:
        return [{"sha": candidate_sha, "message": candidate_commit.get("message"), "author": candidate_commit.get("author"), "date": candidate_commit.get("date"), "noteWarning": str(exc)[:300]}]


def _active_freezes() -> list[dict]:
    now = time.time()
    result = []
    for item in store.freezes(100):
        if not item.get("active"):
            continue
        start = _parse_ts(item.get("startAt")); end = _parse_ts(item.get("endAt"))
        if start is not None and end is not None and start <= now <= end:
            result.append(item)
    return result


def _approval_signature(release: dict, environment: str, actor_id: str, decision: str, created_at: str) -> str:
    secret = (AUTH_SECRET or "").encode("utf-8")
    if len(secret) < 32:
        raise HTTPException(status_code=503, detail="AUTH_SECRET غير كافٍ لتوقيع Release approvals.")
    message = "|".join([release["id"], release["candidateSha"], environment, actor_id, decision, created_at]).encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def _verify_approval(release: dict, approval: dict) -> bool:
    try:
        expected = _approval_signature(release, str(approval.get("environment")), str(approval.get("actorId")), str(approval.get("decision")), str(approval.get("createdAt")))
        return hmac.compare_digest(expected, str(approval.get("signature") or ""))
    except Exception:
        return False


def _approval_summary(release: dict, environment: str) -> dict:
    items = store.approvals(release["id"], environment)
    enriched = [{**item, "signatureValid": _verify_approval(release, item)} for item in items]
    approvals = [item for item in enriched if item.get("decision") == "approve" and item.get("signatureValid")]
    rejects = [item for item in enriched if item.get("decision") == "reject" and item.get("signatureValid")]
    required = max(0, int((_manifest(release).get("requiredApprovals") or {}).get(environment, 0) or 0))
    return {"required": required, "approved": len(approvals), "rejected": len(rejects), "satisfied": len(approvals) >= required and not rejects, "items": enriched}


def _next_environment(release: dict) -> str | None:
    environments = [env for env in _manifest(release).get("environments", ENVIRONMENTS) if env in ENVIRONMENTS]
    current = str(release.get("environment") or "none")
    if current == "none":
        return environments[0] if environments else None
    try:
        index = environments.index(current)
    except ValueError:
        return environments[0] if environments else None
    return environments[index + 1] if index + 1 < len(environments) else None


def _deploy_config() -> dict:
    return {
        "configured": bool(DEPLOY_WEBHOOK_URL),
        "mode": "external-webhook" if DEPLOY_WEBHOOK_URL else "control-plane-only",
        "urlConfigured": bool(DEPLOY_WEBHOOK_URL),
        "note": "External deployment controller configured." if DEPLOY_WEBHOOK_URL else "No deployment webhook configured; environment promotion is recorded but does not change Railway deployments.",
    }


def _send_deployment(release: dict, *, action: str, environment: str, target_sha: str) -> dict:
    if not DEPLOY_WEBHOOK_URL:
        return {"ok": True, "external": False, "mode": "control-plane-only", "environment": environment, "targetSha": target_sha}
    if not DEPLOY_WEBHOOK_URL.startswith("https://"):
        raise RuntimeError("V31_DEPLOY_WEBHOOK_URL must use HTTPS.")
    payload = json.dumps({
        "releaseId": release["id"], "releaseName": release["name"], "repository": release["repository"],
        "action": action, "environment": environment, "targetSha": target_sha,
        "candidateRef": release["candidateRef"], "baseSha": release.get("baseSha"), "requestedAt": _now(),
    }).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "MAGHRABI-V31/1.0"}
    if DEPLOY_WEBHOOK_TOKEN:
        headers["X-V31-Token"] = DEPLOY_WEBHOOK_TOKEN
    request = urllib.request.Request(DEPLOY_WEBHOOK_URL, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(128 * 1024); status = int(getattr(response, "status", 200))
        if status < 200 or status >= 300:
            raise RuntimeError(f"Deployment controller returned HTTP {status}.")
        data = {}
        if raw:
            try: data = json.loads(raw.decode("utf-8"))
            except Exception: data = {"raw": raw.decode("utf-8", errors="replace")[:2000]}
        return {"ok": True, "external": True, "mode": "external-webhook", "environment": environment, "targetSha": target_sha, "response": data}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Deployment controller HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Deployment controller unavailable: {exc.reason}") from exc


def _maybe_start_v30(release: dict, actor_id: str | None) -> dict | None:
    manifest = _manifest(release)
    if not bool(manifest.get("useV30ProgressiveProduction", True)):
        return None
    base = v30rt.base
    traffic = base._traffic_config()
    if not traffic.get("configured"):
        return None
    existing_id = (release.get("deployment") or {}).get("v30ReleaseId")
    if existing_id:
        return base.store.get_release(str(existing_id))
    active = base.store.active_release()
    if active:
        raise RuntimeError(f"V30 has active release: {active.get('name')}")
    v30_manifest = {
        "stages": [5,25,50,100],
        "holdSeconds": max(15, int(manifest.get("v30HoldSeconds", 120) or 120)),
        "minSamplesPerCohort": max(1, int(manifest.get("v30MinSamplesPerCohort", 10) or 10)),
        "maxP95RegressionPct": 20.0, "max5xxDeltaPct": 1.0, "maxCandidate5xxPct": 2.0,
        "maxBurnRate1h": 2.0, "requireV29NotBlocked": True,
    }
    child = base.store.create_release(
        name=f"V31 {release['name']} production canary",
        current_version=str(release.get("baseSha") or "current-production"),
        candidate_version=release["candidateSha"], manifest=v30_manifest,
        auto_promote=bool(manifest.get("v30AutoPromote", False)),
        auto_rollback=bool(manifest.get("v30AutoRollback", True)), actor_id=actor_id,
    )
    base.store.update_release(child["id"], state="canary", startedAt=_now())
    child = base.store.get_release(child["id"]) or child
    base.store.add_stage_event(child["id"], "release_started", 0, 0, "canary", actor_id, {"source":"v31","releaseId":release["id"]})
    child = base._apply_stage(child, 0, actor_id, "stage_applied")
    return child


def _sync_v30_child(release: dict) -> dict:
    deployment = release.get("deployment") if isinstance(release.get("deployment"), dict) else {}
    child_id = deployment.get("v30ReleaseId")
    if not child_id:
        return release
    child = v30rt.base.store.get_release(str(child_id))
    if not child:
        return release
    deployment = {**deployment, "v30State": child.get("state"), "v30TrafficPercent": child.get("appliedPercent")}
    if child.get("state") == "promoted" and release.get("state") != "promoted":
        store.add_event(release["id"], "v30_promoted", "production", None, {"v30ReleaseId": child_id})
        return store.update_release(release["id"], state="promoted", environment="production", finishedAt=_now(), deployment=deployment)
    if child.get("state") == "rolled_back" and release.get("state") != "rolled_back":
        store.add_event(release["id"], "v30_rolled_back", "production", None, {"v30ReleaseId": child_id})
        return store.update_release(release["id"], state="rolled_back", environment="production", finishedAt=_now(), rollbackSha=release.get("baseSha"), deployment=deployment, blockers=["V30 progressive delivery rolled back candidate traffic."])
    return store.update_release(release["id"], deployment=deployment)


def _go_no_go(release: dict, environment: str | None = None, override_freeze: bool = False) -> dict:
    release = _sync_v30_child(release)
    environment = environment or _next_environment(release) or release.get("environment") or "production"
    manifest = _manifest(release)
    blockers: list[str] = []; warnings: list[str] = []
    github = release.get("github") if isinstance(release.get("github"), dict) else {}
    workflows = github.get("workflows") if isinstance(github.get("workflows"), dict) else {}
    if bool(manifest.get("requireCiSuccess", True)) and not workflows.get("success"):
        blockers.append("GitHub Actions evidence does not show a clean completed success for candidate SHA.")
    approval = _approval_summary(release, environment)
    if not approval["satisfied"]:
        blockers.append(f"{environment}: approvals {approval['approved']}/{approval['required']} or a signed rejection exists.")
    freezes = _active_freezes() if bool(manifest.get("freezeProtection", True)) else []
    if freezes and environment in {"staging","production"} and not override_freeze:
        blockers.append(f"Active change freeze: {freezes[0]['name']}")
    if not DEPLOY_WEBHOOK_URL:
        warnings.append("Deployment adapter is not configured; promotion is control-plane only.")
    v29_gate = v30rt.base.v29._release_cached()
    if v29_gate.get("state") == "block":
        blockers.append("V29 Release Gate is BLOCK.")
    return {"ready": not blockers, "environment": environment, "blockers": blockers, "warnings": warnings, "approvals": approval, "activeFreezes": freezes, "v29Gate": {"state":v29_gate.get("state"),"score":v29_gate.get("score")}}


def _approver(request: Request) -> dict:
    try:
        user = v24.require_user_write(request)
        if str(user.get("role")) not in {"admin","producer"}:
            raise HTTPException(status_code=403, detail="Release approval requires Admin or Producer role.")
        return user
    except HTTPException as exc:
        if exc.status_code not in {401,403}:
            raise
    return v24.require_admin_write(request)


def _evidence_path(release_id: str) -> Path:
    return EVIDENCE_DIR / f"MAGHRABI-V31-gitops-evidence-{release_id}.zip"


def _build_evidence(release: dict) -> Path:
    release = _sync_v30_child(release)
    path = _evidence_path(release["id"])
    data = {
        "generatedAt": _now(), "release": release, "events": store.events(release["id"], 500),
        "approvals": [{**item, "signatureValid": _verify_approval(release, item)} for item in store.approvals(release["id"])],
        "deployments": store.deployments(release["id"], 100), "freezes": store.freezes(100),
        "githubConfig": _github_config(), "deploymentConfig": _deploy_config(),
        "goNoGo": _go_no_go(release, release.get("environment") or "production"),
        "v30": (release.get("deployment") or {}).get("v30ReleaseId"),
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in [
            ("release.json", release), ("github-evidence.json", release.get("github") or {}),
            ("release-notes.json", release.get("notes") or []), ("approvals.json", data["approvals"]),
            ("deployments.json", data["deployments"]), ("events.json", data["events"]),
            ("evidence.json", data),
        ]:
            archive.writestr(name, json.dumps(payload, ensure_ascii=False, indent=2))
        archive.writestr("README.txt", "\n".join([
            "MAGHRABI Creator V31 GitOps Evidence", f"Release: {release['name']}",
            f"Repository: {release['repository']}", f"Candidate SHA: {release['candidateSha']}",
            f"Environment: {release['environment']}", f"State: {release['state']}",
            "", "Deployment changes are external only when V31_DEPLOY_WEBHOOK_URL is configured.",
        ]))
    return path


def _background_loop() -> None:
    while not _STOP.wait(15):
        try:
            with rel26.distributed_lock("v31:gitops-sync") as acquired:
                if not acquired:
                    continue
                release = store.active_release()
                if release:
                    _sync_v30_child(release)
        except Exception as exc:
            rel26.event("v31_sync_error", severity="warning", details={"error":str(exc)[:500]})


def install_v31(app) -> None:
    global _STARTED
    with _START_LOCK:
        if _STARTED:
            return
        _STARTED = True
    async def startup() -> None:
        _STOP.clear(); threading.Thread(target=_background_loop, daemon=True, name="v31-gitops-sync").start()
    async def shutdown() -> None:
        _STOP.set()
    app.add_event_handler("startup", startup); app.add_event_handler("shutdown", shutdown)


@router.get("/health/live")
async def live_v31() -> dict:
    return {"live":True,"version":"31","database":store.schema_status().get("databaseMode")}


@router.get("/release/ready")
async def ready_v31() -> JSONResponse:
    release = store.active_release()
    if not release:
        return JSONResponse({"ready":True,"state":"no-active-release","version":"31"})
    gate = _go_no_go(release)
    return JSONResponse({"ready":gate["ready"],"releaseId":release["id"],"state":release["state"],"gate":gate,"version":"31"}, status_code=200 if gate["ready"] else 503)


@router.get("/admin/overview")
async def overview_v31(admin: dict = Depends(v24.require_admin)) -> dict:
    releases = store.list_releases(30)
    active = store.active_release()
    if active:
        active = _sync_v30_child(active)
        active = {**active, "goNoGo":_go_no_go(active), "approvals":store.approvals(active["id"]), "deployments":store.deployments(active["id"],50), "events":store.events(active["id"],50)}
    return {
        "version":"31","generatedAt":_now(),"schema":store.schema_status(),"github":_github_config(),
        "deploymentAdapter":_deploy_config(),"activeRelease":active,"releases":releases,"freezes":store.freezes(50),
        "v30":{"traffic":v30rt.base._traffic_config(),"activeRelease":v30rt.base.store.active_release()},
    }


@router.post("/admin/releases")
async def create_release_v31(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    if store.active_release():
        raise HTTPException(status_code=409, detail="يوجد V31 Release نشطة؛ أنهها أو Rollback قبل إنشاء Release أخرى.")
    repository = str(payload.get("repository") or DEFAULT_REPOSITORY).strip()
    candidate_ref = str(payload.get("candidateRef") or "main").strip()
    try:
        commit = _resolve_commit(repository, candidate_ref)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"تعذر Resolve للـGit candidate: {str(exc)[:500]}") from exc
    base_sha = str(payload.get("baseSha") or "").strip() or commit.get("parentSha")
    raw_manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else {}
    manifest = {**DEFAULT_MANIFEST, **raw_manifest}
    release = store.create_release(
        name=str(payload.get("name") or f"{candidate_ref} release"), repository=repository,
        candidate_ref=candidate_ref, candidate_sha=commit["sha"], base_sha=base_sha,
        tag_name=str(payload.get("tagName") or "").strip() or None, manifest=manifest,
        actor_id=str(admin.get("id") or "admin"),
    )
    return release


@router.post("/admin/releases/{release_id}/prepare")
async def prepare_release_v31(release_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    try:
        commit = _resolve_commit(release["repository"], release["candidateSha"])
        workflows = _workflow_evidence(release["repository"], release["candidateSha"])
        notes = _release_notes(release["repository"], release.get("baseSha"), release["candidateSha"], commit)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"تعذر جمع GitHub evidence: {str(exc)[:500]}") from exc
    github = {"commit":commit,"workflows":workflows,"repository":release["repository"],"capturedAt":_now()}
    blockers = []
    if bool(_manifest(release).get("requireCiSuccess",True)) and not workflows.get("success"):
        blockers.append("Candidate GitHub Actions is not clean/successful yet.")
    updated = store.update_release(release_id, state="prepared" if not blockers else "blocked", preparedAt=_now(), github=github, notes=notes, blockers=blockers, warnings=[])
    store.add_event(release_id,"prepared","none",str(admin.get("id") or "admin"),{"workflowSuccess":workflows.get("success"),"notes":len(notes)})
    return {**updated,"goNoGo":_go_no_go(updated,"dev")}


@router.post("/admin/releases/{release_id}/approve")
async def approve_release_v31(release_id: str, request: Request, payload: dict = Body(default={})) -> dict:
    actor = _approver(request)
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    environment = str(payload.get("environment") or _next_environment(release) or "production").lower()
    if environment not in ENVIRONMENTS:
        raise HTTPException(status_code=422, detail="Environment غير صالح.")
    decision = str(payload.get("decision") or "approve").lower()
    if decision not in {"approve","reject"}:
        raise HTTPException(status_code=422, detail="Decision يجب أن يكون approve أو reject.")
    created = _now(); actor_id = str(actor.get("id") or "admin")
    signature = _approval_signature(release,environment,actor_id,decision,created)
    item = store.upsert_approval(release_id=release_id,environment=environment,actor_id=actor_id,actor_name=actor.get("name"),actor_role=actor.get("role"),decision=decision,reason=str(payload.get("reason") or ""),signature=signature,created_at=created)
    store.add_event(release_id,"approval_signed",environment,actor_id,{"decision":decision,"signature":signature[:16]})
    return {**item,"signatureValid":True,"summary":_approval_summary(release,environment)}


@router.post("/admin/releases/{release_id}/promote")
async def promote_release_v31(release_id: str, payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    release = _sync_v30_child(release)
    environment = _next_environment(release)
    if not environment:
        raise HTTPException(status_code=409, detail="Release وصلت إلى آخر Environment بالفعل.")
    override = bool(payload.get("overrideFreeze",False))
    gate = _go_no_go(release,environment,override_freeze=override)
    if not gate["ready"]:
        raise HTTPException(status_code=409, detail=" | ".join(gate["blockers"]))
    actor_id = str(admin.get("id") or "admin")
    if gate["activeFreezes"] and override:
        reason = str(payload.get("overrideReason") or "Admin override")[:800]
        store.add_event(release_id,"freeze_override",environment,actor_id,{"reason":reason,"freezes":[x["id"] for x in gate["activeFreezes"]]})
    try:
        response = _send_deployment(release,action="deploy",environment=environment,target_sha=release["candidateSha"])
    except Exception as exc:
        store.add_deployment(release_id=release_id,environment=environment,action="deploy",target_sha=release["candidateSha"],state="failed",external=True,actor_id=actor_id,response={"error":str(exc)[:1000]},finished_at=_now())
        store.update_release(release_id,state="failed",blockers=[f"Deployment failed: {str(exc)[:500]}"])
        raise HTTPException(status_code=502, detail=f"تعذر Deployment: {str(exc)[:500]}") from exc
    deployment_item = store.add_deployment(release_id=release_id,environment=environment,action="deploy",target_sha=release["candidateSha"],state="completed",external=bool(response.get("external")),actor_id=actor_id,response=response,finished_at=_now())
    deployment_state = {**(release.get("deployment") or {}),environment:deployment_item}
    next_state = environment
    updated = store.update_release(release_id,state=next_state,environment=environment,deployment=deployment_state,blockers=[],warnings=gate["warnings"])
    store.add_event(release_id,"environment_promoted",environment,actor_id,{"external":bool(response.get("external")),"sha":release["candidateSha"]})
    if environment == "production":
        try:
            child = _maybe_start_v30(updated,actor_id)
        except Exception as exc:
            store.add_event(release_id,"v30_start_failed",environment,actor_id,{"error":str(exc)[:1000]})
            return store.update_release(release_id,state="production",warnings=[*gate["warnings"],f"V30 progressive start failed: {str(exc)[:500]}"])
        if child:
            deployment_state = {**deployment_state,"v30ReleaseId":child["id"],"v30State":child.get("state"),"v30TrafficPercent":child.get("appliedPercent")}
            return store.update_release(release_id,state="production_canary",environment="production",deployment=deployment_state)
        return store.update_release(release_id,state="promoted",environment="production",finishedAt=_now(),deployment=deployment_state)
    return updated


@router.post("/admin/releases/{release_id}/rollback")
async def rollback_release_v31(release_id: str, payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    target = str(payload.get("targetSha") or release.get("baseSha") or "").strip()
    if not target:
        raise HTTPException(status_code=422, detail="لا يوجد Rollback SHA محدد.")
    environment = str(payload.get("environment") or release.get("environment") or "production")
    actor_id = str(admin.get("id") or "admin")
    try:
        response = _send_deployment(release,action="rollback",environment=environment,target_sha=target)
    except Exception as exc:
        store.add_deployment(release_id=release_id,environment=environment,action="rollback",target_sha=target,state="failed",external=True,actor_id=actor_id,response={"error":str(exc)[:1000]},finished_at=_now())
        raise HTTPException(status_code=502, detail=f"Rollback controller failed: {str(exc)[:500]}") from exc
    item = store.add_deployment(release_id=release_id,environment=environment,action="rollback",target_sha=target,state="completed",external=bool(response.get("external")),actor_id=actor_id,response=response,finished_at=_now())
    updated = store.update_release(release_id,state="rolled_back",rollbackSha=target,finishedAt=_now(),deployment={**(release.get("deployment") or {}),"rollback":item})
    store.add_event(release_id,"rolled_back",environment,actor_id,{"targetSha":target,"external":bool(response.get("external"))})
    return updated


@router.post("/admin/freezes")
async def create_freeze_v31(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    start = str(payload.get("startAt") or "").strip(); end = str(payload.get("endAt") or "").strip()
    if _parse_ts(start) is None or _parse_ts(end) is None or (_parse_ts(end) or 0) <= (_parse_ts(start) or 0):
        raise HTTPException(status_code=422, detail="Freeze start/end غير صالحين.")
    return store.add_freeze(name=str(payload.get("name") or "Change Freeze"),start_at=start,end_at=end,reason=str(payload.get("reason") or ""),actor_id=str(admin.get("id") or "admin"))


@router.delete("/admin/freezes/{freeze_id}")
async def delete_freeze_v31(freeze_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    store.delete_freeze(freeze_id); return {"ok":True,"id":freeze_id}


@router.get("/admin/releases/{release_id}/evidence")
async def evidence_v31(release_id: str, admin: dict = Depends(v24.require_admin)) -> FileResponse:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    path = _build_evidence(release)
    return FileResponse(path,media_type="application/zip",filename=path.name)
