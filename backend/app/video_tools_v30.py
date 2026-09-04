from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from . import progressive_store_v30 as store
from . import reliability_store_v26 as rel26
from . import video_tools_v24 as v24
from . import video_tools_v29_runtime as v29runtime
from .video_tools_v29_runtime import base as v29
from .main import DATA_DIR

router = APIRouter(prefix="/api/video/v30", tags=["video-studio-v30"])

_STOP = threading.Event()
_STARTED = False
_START_LOCK = threading.Lock()
_RELEASE_LOCK = threading.Lock()

PROGRESSIVE_DIR = DATA_DIR / "video_progressive"
EVIDENCE_DIR = PROGRESSIVE_DIR / "evidence"
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_STAGES = [5, 25, 50, 100]
DEFAULT_MANIFEST = {
    "stages": DEFAULT_STAGES,
    "holdSeconds": 120,
    "minSamplesPerCohort": 10,
    "maxP95RegressionPct": 20.0,
    "max5xxDeltaPct": 1.0,
    "maxCandidate5xxPct": 2.0,
    "maxBurnRate1h": 2.0,
    "requireV29NotBlocked": True,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _percentile(values: list[float], p: float) -> float | None:
    clean = sorted(float(value) for value in values if isinstance(value, (int, float)))
    if not clean:
        return None
    if len(clean) == 1:
        return round(clean[0], 3)
    position = (len(clean) - 1) * max(0.0, min(1.0, p))
    lower = int(position); upper = min(len(clean) - 1, lower + 1)
    weight = position - lower
    return round(clean[lower] * (1 - weight) + clean[upper] * weight, 3)


def _traffic_config() -> dict:
    url = os.getenv("V30_TRAFFIC_WEBHOOK_URL", "").strip()
    return {
        "mode": "external-webhook" if url else "internal-cohort",
        "configured": bool(url),
        "urlConfigured": bool(url),
        "note": (
            "External traffic controller is configured. It should route candidate/current traffic and preferably send X-V30-Cohort."
            if url else
            "No external traffic controller is configured. Percentages affect V30 cohort assignment/measurement only, not Railway deployment routing."
        ),
    }


def _send_traffic(release: dict, percent: int, action: str) -> dict:
    config = _traffic_config()
    percent = max(0, min(100, int(percent)))
    if not config["configured"]:
        return {"ok": True, "mode": "internal-cohort", "appliedPercent": percent, "externalRouting": False}
    url = os.getenv("V30_TRAFFIC_WEBHOOK_URL", "").strip()
    if not url.startswith("https://"):
        raise RuntimeError("V30_TRAFFIC_WEBHOOK_URL must use HTTPS.")
    payload = json.dumps({
        "releaseId": release["id"], "name": release["name"],
        "currentVersion": release["currentVersion"], "candidateVersion": release["candidateVersion"],
        "candidatePercent": percent, "action": action, "requestedAt": _now(),
    }).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "MAGHRABI-V30/1.0"}
    token = os.getenv("V30_TRAFFIC_WEBHOOK_TOKEN", "").strip()
    if token:
        headers["X-V30-Token"] = token
    request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            raw = response.read(64 * 1024)
            status = int(getattr(response, "status", 200))
        if status < 200 or status >= 300:
            raise RuntimeError(f"Traffic controller returned HTTP {status}.")
        data = {}
        if raw:
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                data = {"raw": raw.decode("utf-8", errors="replace")[:1000]}
        return {"ok": True, "mode": "external-webhook", "appliedPercent": percent, "externalRouting": True, "response": data}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Traffic controller HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Traffic controller unavailable: {exc.reason}") from exc


def _stage_since(release: dict) -> str:
    events = store.stage_events(release["id"], 100)
    for event in events:
        if event["eventType"] in {"stage_applied", "release_started", "promoted"}:
            return str(event["createdAt"])
    return str(release.get("startedAt") or release.get("createdAt") or _now())


def _cohort_metrics(release: dict) -> dict:
    rows = store.cohort_rows(release["id"], _stage_since(release))
    output = {}
    for cohort in ("current", "candidate"):
        group = [row for row in rows if str(row.get("cohort")) == cohort]
        durations = [float(row.get("duration_ms") or 0) for row in group]
        errors = sum(1 for row in group if int(row.get("status_code") or 0) >= 500)
        output[cohort] = {
            "samples": len(group), "errors5xx": errors,
            "error5xxPct": round(errors / len(group) * 100, 4) if group else None,
            "p50Ms": _percentile(durations, .50), "p95Ms": _percentile(durations, .95), "p99Ms": _percentile(durations, .99),
        }
    current = output["current"]; candidate = output["candidate"]
    p95_regression = None
    if current["p95Ms"] not in {None, 0} and candidate["p95Ms"] is not None:
        p95_regression = round((candidate["p95Ms"] - current["p95Ms"]) / current["p95Ms"] * 100, 3)
    error_delta = None
    if current["error5xxPct"] is not None and candidate["error5xxPct"] is not None:
        error_delta = round(candidate["error5xxPct"] - current["error5xxPct"], 4)
    return {**output, "p95RegressionPct": p95_regression, "error5xxDeltaPct": error_delta, "since": _stage_since(release)}


def _evaluate(release: dict) -> dict:
    manifest = {**DEFAULT_MANIFEST, **(release.get("manifest") or {})}
    cohort = _cohort_metrics(release)
    v29_gate = v29._release_cached()
    budget = v29._error_budget(v29.store.get_settings())
    blockers: list[str] = []
    warnings: list[str] = []
    min_samples = max(1, int(manifest.get("minSamplesPerCohort", 10)))
    current_samples = int(cohort["current"]["samples"])
    candidate_samples = int(cohort["candidate"]["samples"])

    if bool(manifest.get("requireV29NotBlocked", True)) and v29_gate.get("state") == "block":
        blockers.append("V29 release gate is BLOCK.")
    if candidate_samples < min_samples or current_samples < min_samples:
        warnings.append(f"Need at least {min_samples} samples per cohort; current={current_samples}, candidate={candidate_samples}.")

    regression = cohort.get("p95RegressionPct")
    if regression is not None and candidate_samples >= min_samples and current_samples >= min_samples:
        limit = float(manifest.get("maxP95RegressionPct", 20) or 20)
        if regression > limit:
            blockers.append(f"Candidate P95 regression {regression:.2f}% exceeds {limit:.2f}%.")
    error_delta = cohort.get("error5xxDeltaPct")
    if error_delta is not None and candidate_samples >= min_samples and current_samples >= min_samples:
        limit = float(manifest.get("max5xxDeltaPct", 1) or 1)
        if error_delta > limit:
            blockers.append(f"Candidate 5xx delta {error_delta:.3f}% exceeds {limit:.3f}%.")
    candidate_5xx = cohort["candidate"].get("error5xxPct")
    if candidate_5xx is not None and candidate_samples >= min_samples:
        limit = float(manifest.get("maxCandidate5xxPct", 2) or 2)
        if candidate_5xx > limit:
            blockers.append(f"Candidate 5xx rate {candidate_5xx:.3f}% exceeds {limit:.3f}%.")
    burn = budget.get("burnRate1h")
    if burn is not None and burn > float(manifest.get("maxBurnRate1h", 2) or 2):
        blockers.append(f"1h error-budget burn rate {burn:.2f}x exceeds manifest threshold.")

    stage_ts = _parse_iso(_stage_since(release)) or time.time()
    hold_seconds = max(15, int(manifest.get("holdSeconds", 120) or 120))
    hold_remaining = max(0, int(stage_ts + hold_seconds - time.time()))
    enough = current_samples >= min_samples and candidate_samples >= min_samples
    decision = "rollback" if blockers else "promote" if enough and hold_remaining <= 0 else "hold"
    metrics = {
        "cohorts": cohort, "v29Gate": {"state": v29_gate.get("state"), "score": v29_gate.get("score")},
        "burnRate1h": burn, "holdRemainingSeconds": hold_remaining, "enoughSamples": enough,
        "traffic": _traffic_config(),
    }
    return {"decision": decision, "blockers": blockers, "warnings": warnings, "metrics": metrics, "evaluatedAt": _now()}


def _apply_stage(release: dict, stage_index: int, actor_id: str | None, event_type: str = "stage_applied") -> dict:
    manifest = {**DEFAULT_MANIFEST, **(release.get("manifest") or {})}
    stages = [max(0, min(100, int(value))) for value in manifest.get("stages", DEFAULT_STAGES)]
    stages = sorted(set(stages)) or list(DEFAULT_STAGES)
    if stage_index < 0 or stage_index >= len(stages):
        raise HTTPException(status_code=409, detail="Canary stage index خارج النطاق.")
    target = stages[stage_index]
    before = int(release.get("appliedPercent") or 0)
    store.update_release(release["id"], state="promoting", stageIndex=stage_index, desiredPercent=target)
    fresh = store.get_release(release["id"]) or release
    try:
        traffic = _send_traffic(fresh, target, "promote")
    except Exception as exc:
        store.update_release(release["id"], state="paused", warnings=[f"Traffic controller failed: {str(exc)[:500]}"])
        store.add_stage_event(release["id"], "traffic_failed", before, target, "paused", actor_id, {"error": str(exc)[:1000]})
        raise HTTPException(status_code=502, detail=f"تعذر تطبيق Canary Traffic: {str(exc)[:500]}") from exc
    state = "canary" if target < 100 else "promoting"
    updated = store.update_release(release["id"], state=state, stageIndex=stage_index, desiredPercent=target, appliedPercent=target, lastEvaluatedAt=None, blockers=[], warnings=[])
    store.add_stage_event(release["id"], event_type, before, target, state, actor_id, {"traffic": traffic})
    rel26.event("v30_stage_applied", node_id=v29.v26.NODE_ID, details={"releaseId": release["id"], "from": before, "to": target, "mode": traffic.get("mode")})
    return updated


def _rollback(release: dict, actor_id: str | None, reason: str, *, automatic: bool = False) -> dict:
    before = int(release.get("appliedPercent") or 0)
    try:
        traffic = _send_traffic(release, 0, "rollback")
    except Exception as exc:
        store.update_release(release["id"], state="paused", warnings=[f"Rollback traffic controller failed: {str(exc)[:500]}"])
        store.add_stage_event(release["id"], "rollback_failed", before, 0, "paused", actor_id, {"reason": reason, "error": str(exc)[:1000]})
        return store.get_release(release["id"]) or release
    updated = store.update_release(release["id"], state="rolled_back", desiredPercent=0, appliedPercent=0, finishedAt=_now(), blockers=[reason])
    store.add_stage_event(release["id"], "auto_rollback" if automatic else "rollback", before, 0, "rolled_back", actor_id, {"reason": reason, "traffic": traffic})
    rel26.event("v30_release_rolled_back", severity="warning", node_id=v29.v26.NODE_ID, details={"releaseId": release["id"], "reason": reason[:500], "automatic": automatic})
    return updated


def _promote_or_finish(release: dict, actor_id: str | None, *, automatic: bool) -> dict:
    manifest = {**DEFAULT_MANIFEST, **(release.get("manifest") or {})}
    stages = sorted(set(max(0, min(100, int(value))) for value in manifest.get("stages", DEFAULT_STAGES))) or list(DEFAULT_STAGES)
    index = int(release.get("stageIndex") or 0)
    if int(release.get("appliedPercent") or 0) >= 100 or index >= len(stages) - 1:
        updated = store.update_release(release["id"], state="promoted", desiredPercent=100, appliedPercent=100, finishedAt=_now())
        store.add_stage_event(release["id"], "auto_promoted" if automatic else "promoted", 100, 100, "promoted", actor_id, {"final": True})
        rel26.event("v30_release_promoted", node_id=v29.v26.NODE_ID, details={"releaseId": release["id"], "automatic": automatic})
        return updated
    return _apply_stage(release, index + 1, actor_id, "auto_stage_applied" if automatic else "stage_applied")


def _evaluate_and_act(release_id: str, actor_id: str | None = None, *, automatic: bool = False) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    evaluation = _evaluate(release)
    release = store.update_release(release_id, lastEvaluatedAt=_now(), blockers=evaluation["blockers"], warnings=evaluation["warnings"], metrics=evaluation["metrics"])
    store.add_stage_event(release_id, "evaluation", release.get("appliedPercent"), release.get("appliedPercent"), release.get("state") or "canary", actor_id, evaluation)
    if evaluation["decision"] == "rollback" and bool(release.get("autoRollback")):
        return _rollback(release, actor_id, "; ".join(evaluation["blockers"]) or "SLO regression", automatic=automatic)
    if evaluation["decision"] == "promote" and bool(release.get("autoPromote")):
        return _promote_or_finish(release, actor_id, automatic=automatic)
    return store.get_release(release_id) or release


def _stable_subject(request: Request) -> str:
    explicit = request.headers.get("x-v30-subject")
    if explicit:
        return explicit[:300]
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    ua = request.headers.get("user-agent", "")[:160]
    return f"{forwarded}|{ua}"


def _cohort_for(request: Request, release: dict) -> str:
    header = request.headers.get("x-v30-cohort", "").strip().lower()
    if header in {"current", "candidate"}:
        return header
    percent = max(0, min(100, int(release.get("appliedPercent") or 0)))
    subject = _stable_subject(request)
    digest = hashlib.sha256(f"{release['id']}|{subject}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") % 100
    return "candidate" if bucket < percent else "current"


def _evaluate_flag(flag: dict, subject: str) -> dict:
    if not flag.get("enabled"):
        return {"enabled": False, "variant": flag.get("variantOff") or "off", "bucket": None}
    digest = hashlib.sha256(f"{flag.get('salt')}|{subject}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") % 100
    enabled = bucket < int(flag.get("rolloutPercent") or 0)
    return {"enabled": enabled, "variant": flag.get("variantOn") if enabled else flag.get("variantOff"), "bucket": bucket}


def _evidence_path(release_id: str) -> Path:
    return EVIDENCE_DIR / f"MAGHRABI-V30-release-evidence-{release_id}.zip"


def _build_evidence(release: dict) -> Path:
    path = _evidence_path(release["id"])
    evidence = {
        "generatedAt": _now(), "release": release,
        "events": store.stage_events(release["id"], 300),
        "flags": store.list_flags(), "schema": store.schema_status(),
        "traffic": _traffic_config(), "v29ReleaseGate": v29._release_cached(),
        "v29Capacity": v29._capacity_snapshot(), "v28": v29.v28._overview(),
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("release.json", json.dumps(release, ensure_ascii=False, indent=2))
        archive.writestr("stage-events.json", json.dumps(evidence["events"], ensure_ascii=False, indent=2))
        archive.writestr("feature-flags.json", json.dumps(evidence["flags"], ensure_ascii=False, indent=2))
        archive.writestr("evidence.json", json.dumps(evidence, ensure_ascii=False, indent=2))
        summary = [
            "MAGHRABI Creator V30 Release Evidence",
            f"Release: {release['name']}", f"Current: {release['currentVersion']}", f"Candidate: {release['candidateVersion']}",
            f"State: {release['state']}", f"Traffic: {release['appliedPercent']}%", f"Generated: {evidence['generatedAt']}",
            "", "This bundle records control-plane evidence. Actual Railway traffic shifting is external unless V30_TRAFFIC_WEBHOOK_URL is configured.",
        ]
        archive.writestr("README.txt", "\n".join(summary))
    return path


def _background_loop() -> None:
    while not _STOP.wait(15):
        try:
            release = store.active_release()
            if not release or release.get("state") == "paused":
                continue
            with rel26.distributed_lock("v30:progressive-controller") as acquired:
                if not acquired:
                    continue
                _evaluate_and_act(release["id"], None, automatic=True)
        except Exception as exc:
            rel26.event("v30_controller_error", severity="warning", node_id=v29.v26.NODE_ID, details={"error": str(exc)[:500]})


def install_v30(app) -> None:
    global _STARTED
    with _START_LOCK:
        if _STARTED:
            return
        _STARTED = True

    @app.middleware("http")
    async def v30_cohort_middleware(request: Request, call_next):
        release = store.active_release()
        path = request.url.path
        tracked = bool(release) and path.startswith("/api/") and not path.startswith("/api/video/v30/") and "/health/" not in path
        started = time.perf_counter(); status = 500
        cohort = _cohort_for(request, release) if tracked and release else None
        response = None
        try:
            response = await call_next(request)
            status = int(response.status_code)
            if response is not None and cohort:
                response.headers["X-V30-Cohort"] = cohort
                response.headers["X-V30-Release"] = str(release.get("id"))
            return response
        finally:
            if tracked and release and cohort:
                try:
                    store.add_cohort_sample(release["id"], cohort, path, request.method.upper(), status, round((time.perf_counter() - started) * 1000, 3))
                except Exception:
                    pass

    async def startup() -> None:
        _STOP.clear()
        threading.Thread(target=_background_loop, daemon=True, name="v30-progressive-controller").start()

    async def shutdown() -> None:
        _STOP.set()

    app.add_event_handler("startup", startup)
    app.add_event_handler("shutdown", shutdown)


@router.get("/health/live")
async def live_v30() -> dict:
    return {"live": True, "version": "30", "nodeId": v29.v26.NODE_ID}


@router.get("/release/ready")
async def release_ready_v30() -> JSONResponse:
    release = store.active_release()
    if not release:
        gate = v29._release_cached()
        ready = gate.get("state") != "block"
        return JSONResponse({"ready": ready, "state": "no-active-release", "v29": gate.get("state"), "version": "30"}, status_code=200 if ready else 503)
    evaluation = _evaluate(release)
    ready = evaluation["decision"] != "rollback"
    return JSONResponse({"ready": ready, "state": release["state"], "decision": evaluation["decision"], "releaseId": release["id"], "version": "30"}, status_code=200 if ready else 503)


@router.get("/flags/{key}/evaluate")
async def evaluate_flag_v30(key: str, subject: str = "anonymous") -> dict:
    flag = store.get_flag(key.strip().lower())
    if not flag:
        return {"key": key, "enabled": False, "variant": "off", "exists": False}
    result = _evaluate_flag(flag, subject[:300])
    return {"key": flag["key"], "exists": True, **result}


@router.get("/admin/overview")
async def overview_v30(admin: dict = Depends(v24.require_admin)) -> dict:
    active = store.active_release()
    if active:
        active = {**active, "evaluation": _evaluate(active), "events": store.stage_events(active["id"], 30)}
    return {
        "version": "30", "generatedAt": _now(), "schema": store.schema_status(),
        "traffic": _traffic_config(), "activeRelease": active,
        "releases": store.list_releases(30), "flags": store.list_flags(),
        "v29": {"releaseGate": v29._release_cached(), "capacity": v29._capacity_snapshot(), "forecast": v29._capacity_forecast(v29.store.get_settings())},
    }


@router.post("/admin/releases")
async def create_release_v30(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    if store.active_release():
        raise HTTPException(status_code=409, detail="يوجد Progressive Release نشطة؛ أنهها أو Rollback قبل إنشاء Release جديدة.")
    current = str(payload.get("currentVersion") or "current").strip()
    candidate = str(payload.get("candidateVersion") or "candidate").strip()
    if not current or not candidate or current == candidate:
        raise HTTPException(status_code=422, detail="يلزم تحديد Current وCandidate مختلفين.")
    raw_manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else {}
    manifest = {**DEFAULT_MANIFEST, **raw_manifest}
    stages = manifest.get("stages", DEFAULT_STAGES)
    if not isinstance(stages, list):
        stages = DEFAULT_STAGES
    manifest["stages"] = sorted(set(max(1, min(100, int(value))) for value in stages))
    if 100 not in manifest["stages"]:
        manifest["stages"].append(100)
    manifest["holdSeconds"] = max(15, min(3600, int(manifest.get("holdSeconds", 120) or 120)))
    manifest["minSamplesPerCohort"] = max(1, min(10000, int(manifest.get("minSamplesPerCohort", 10) or 10)))
    release = store.create_release(
        name=str(payload.get("name") or f"{candidate} rollout"), current_version=current, candidate_version=candidate,
        manifest=manifest, auto_promote=bool(payload.get("autoPromote", False)), auto_rollback=bool(payload.get("autoRollback", True)),
        actor_id=str(admin.get("id") or "admin"),
    )
    return release


@router.post("/admin/releases/{release_id}/start")
async def start_release_v30(release_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    if release["state"] not in {"draft", "paused"}:
        raise HTTPException(status_code=409, detail="Release ليست في حالة تسمح بالبدء.")
    gate = v29._release_cached()
    if gate.get("state") == "block":
        raise HTTPException(status_code=409, detail="V29 Release Gate = BLOCK. أصلح الـBlockers قبل Canary.")
    store.update_release(release_id, state="canary", startedAt=release.get("startedAt") or _now())
    release = store.get_release(release_id) or release
    store.add_stage_event(release_id, "release_started", 0, 0, "canary", str(admin.get("id") or "admin"), {"v29Gate": gate})
    return _apply_stage(release, 0, str(admin.get("id") or "admin"), "stage_applied")


@router.post("/admin/releases/{release_id}/evaluate")
async def evaluate_release_v30(release_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    return _evaluate_and_act(release_id, str(admin.get("id") or "admin"), automatic=False)


@router.post("/admin/releases/{release_id}/promote")
async def promote_release_v30(release_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    evaluation = _evaluate(release)
    if evaluation["blockers"]:
        raise HTTPException(status_code=409, detail="لا يمكن Promotion مع وجود SLO Blockers.")
    return _promote_or_finish(release, str(admin.get("id") or "admin"), automatic=False)


@router.post("/admin/releases/{release_id}/rollback")
async def rollback_release_v30(release_id: str, payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    reason = str(payload.get("reason") or "Manual rollback")[:800]
    return _rollback(release, str(admin.get("id") or "admin"), reason, automatic=False)


@router.post("/admin/releases/{release_id}/pause")
async def pause_release_v30(release_id: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    updated = store.update_release(release_id, state="paused")
    store.add_stage_event(release_id, "paused", release.get("appliedPercent"), release.get("appliedPercent"), "paused", str(admin.get("id") or "admin"), {})
    return updated


@router.post("/admin/flags")
async def save_flag_v30(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    try:
        return store.upsert_flag(
            key=str(payload.get("key") or ""), name=str(payload.get("name") or payload.get("key") or "Feature Flag"),
            description=str(payload.get("description") or ""), enabled=bool(payload.get("enabled", False)),
            rollout_percent=max(0, min(100, int(payload.get("rolloutPercent") or 0))),
            variant_on=str(payload.get("variantOn") or "on"), variant_off=str(payload.get("variantOff") or "off"),
            actor_id=str(admin.get("id") or "admin"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/admin/flags/{key}")
async def delete_flag_v30(key: str, admin: dict = Depends(v24.require_admin_write)) -> dict:
    store.delete_flag(key.strip().lower())
    return {"ok": True, "key": key}


@router.get("/admin/releases/{release_id}/evidence")
async def evidence_v30(release_id: str, admin: dict = Depends(v24.require_admin)) -> FileResponse:
    release = store.get_release(release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release غير موجودة.")
    path = _build_evidence(release)
    return FileResponse(path, media_type="application/zip", filename=path.name)
