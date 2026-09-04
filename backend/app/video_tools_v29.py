from __future__ import annotations

import json
import math
import os
import statistics
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from . import capacity_store_v29 as store
from . import identity_store_v24 as identity
from . import reliability_store_v26 as rel26
from . import video_tools_v24 as v24
from . import video_tools_v25 as v25
from . import video_tools_v27 as v27
from . import video_tools_v28 as v28
from .video_tools_v26_runtime import base as v26

router = APIRouter(prefix="/api/video/v29", tags=["video-studio-v29"])

_STOP = threading.Event()
_STARTED = False
_START_LOCK = threading.Lock()
_TEST_LOCK = threading.Lock()
_GATE_CACHE: tuple[float, dict] | None = None

SUCCESS = {"done", "completed", "success"}
FAILURE = {"failed", "error"}
TERMINAL = SUCCESS | FAILURE | {"cancelled", "partial"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _percentile(values: list[float], percent: float) -> float | None:
    clean = sorted(float(item) for item in values if isinstance(item, (int, float)) and math.isfinite(float(item)))
    if not clean:
        return None
    if len(clean) == 1:
        return round(clean[0], 3)
    position = (len(clean) - 1) * max(0.0, min(1.0, percent))
    lower = int(math.floor(position)); upper = int(math.ceil(position))
    if lower == upper:
        return round(clean[lower], 3)
    weight = position - lower
    return round(clean[lower] * (1 - weight) + clean[upper] * weight, 3)


def _job_samples(hours: float) -> list[dict]:
    cutoff = time.time() - max(1.0, hours) * 3600
    samples: list[dict] = []
    for category, path in v25._job_state_files():
        if category == "orchestrator":
            # V21 items launch V20 child pipelines. Counting the project JSON again
            # would double-count production work, so V29 uses the child jobs.
            continue
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        created = _parse_iso(state.get("createdAt"))
        started = _parse_iso(state.get("startedAt"))
        finished = _parse_iso(state.get("finishedAt"))
        observed = finished or started or created
        if observed is None:
            try:
                observed = path.stat().st_mtime
            except OSError:
                continue
        if observed < cutoff:
            continue
        status = str(state.get("status") or "unknown").lower()
        queue_seconds = max(0.0, started - created) if created is not None and started is not None else None
        execution_seconds = max(0.0, finished - started) if started is not None and finished is not None else None
        total_seconds = max(0.0, finished - created) if created is not None and finished is not None else None
        source = state.get("source") if isinstance(state.get("source"), dict) else {}
        source_duration = source.get("duration") if isinstance(source, dict) else None
        preset = state.get("presetLabel") or state.get("preset")
        if category == "render":
            output_size = state.get("outputSize") or state.get("size") or "render"
            quality = state.get("quality") or "default"
            preset = f"{output_size} · {quality}"
        samples.append({
            "category": category, "id": state.get("id") or path.parent.name,
            "status": status, "created": created, "started": started, "finished": finished,
            "queueSeconds": queue_seconds, "executionSeconds": execution_seconds, "totalSeconds": total_seconds,
            "preset": str(preset or category), "sourceDuration": float(source_duration) if isinstance(source_duration, (int, float)) else None,
        })
    return samples


def _job_metrics(hours: float, settings: dict) -> dict:
    samples = _job_samples(hours)
    terminal = [item for item in samples if item["status"] in TERMINAL]
    successes = [item for item in terminal if item["status"] in SUCCESS]
    failures = [item for item in terminal if item["status"] in FAILURE]
    queue_values = [item["queueSeconds"] for item in samples if item["queueSeconds"] is not None]
    execution_values = [item["executionSeconds"] for item in successes if item["executionSeconds"] is not None]
    render_values = [item["executionSeconds"] for item in successes if item["category"] == "render" and item["executionSeconds"] is not None]
    pipeline_values = [item["executionSeconds"] for item in successes if item["category"] == "pipeline" and item["executionSeconds"] is not None]
    success_pct = round(len(successes) / len(terminal) * 100, 3) if terminal else None

    cost_rate = max(0.0, float(os.getenv("V29_COMPUTE_USD_PER_HOUR", "0") or 0))
    grouped: dict[str, dict] = {}
    for item in successes:
        duration = item.get("executionSeconds")
        if duration is None:
            continue
        key = f"{item['category']}:{item['preset']}"
        bucket = grouped.setdefault(key, {"category": item["category"], "preset": item["preset"], "durations": [], "sourceSeconds": 0.0})
        bucket["durations"].append(float(duration))
        if item.get("sourceDuration"):
            bucket["sourceSeconds"] += float(item["sourceDuration"])
    per_preset = []
    for bucket in grouped.values():
        durations = bucket.pop("durations")
        compute_seconds = sum(durations)
        source_seconds = float(bucket.pop("sourceSeconds"))
        per_preset.append({
            **bucket,
            "samples": len(durations),
            "computeSeconds": round(compute_seconds, 2),
            "p50Seconds": _percentile(durations, .50),
            "p95Seconds": _percentile(durations, .95),
            "realTimeFactor": round(compute_seconds / source_seconds, 3) if source_seconds > 0 else None,
            "estimatedUsd": round(compute_seconds / 3600 * cost_rate, 4) if cost_rate > 0 else None,
        })
    per_preset.sort(key=lambda item: item["computeSeconds"], reverse=True)
    return {
        "windowHours": hours,
        "samples": len(samples), "terminalSamples": len(terminal), "successes": len(successes), "failures": len(failures),
        "successPct": success_pct,
        "queue": {"samples": len(queue_values), "p50Seconds": _percentile(queue_values, .50), "p95Seconds": _percentile(queue_values, .95), "p99Seconds": _percentile(queue_values, .99)},
        "execution": {"samples": len(execution_values), "p50Seconds": _percentile(execution_values, .50), "p95Seconds": _percentile(execution_values, .95), "p99Seconds": _percentile(execution_values, .99)},
        "renderP95Seconds": _percentile(render_values, .95), "renderSamples": len(render_values),
        "pipelineP95Seconds": _percentile(pipeline_values, .95), "pipelineSamples": len(pipeline_values),
        "perPreset": per_preset[:20],
        "computeUsdPerHourConfigured": cost_rate if cost_rate > 0 else None,
    }


def _api_window(hours: float) -> dict:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=max(.05, hours))).isoformat()
    rows = identity.fetchall("SELECT status_code,duration_ms FROM v29_api_samples WHERE created_at>=? ORDER BY created_at", (cutoff,))
    durations = [float(row.get("duration_ms") or 0) for row in rows]
    errors_5xx = sum(1 for row in rows if int(row.get("status_code") or 0) >= 500)
    errors_4xx = sum(1 for row in rows if 400 <= int(row.get("status_code") or 0) < 500)
    count = len(rows)
    availability = round((count - errors_5xx) / count * 100, 4) if count else None
    request_success = round((count - errors_5xx - errors_4xx) / count * 100, 4) if count else None
    return {
        "hours": hours, "samples": count, "errors5xx": errors_5xx, "errors4xx": errors_4xx,
        "availabilityPct": availability, "requestSuccessPct": request_success,
        "p50Ms": _percentile(durations, .50), "p95Ms": _percentile(durations, .95), "p99Ms": _percentile(durations, .99),
    }


def _error_budget(settings: dict) -> dict:
    target = float(settings.get("availability.targetPct", 99.5) or 99.5)
    window = float(settings.get("window.hours", 24) or 24)
    main = _api_window(window)
    fast = _api_window(1)
    slow = _api_window(6)
    allowed_rate = max(0.000001, (100.0 - target) / 100.0)

    def burn(data: dict) -> float | None:
        if not data["samples"]:
            return None
        actual_rate = data["errors5xx"] / data["samples"]
        return round(actual_rate / allowed_rate, 3)

    if main["samples"]:
        allowed_errors = main["samples"] * allowed_rate
        remaining = allowed_errors - main["errors5xx"]
        remaining_pct = round(remaining / allowed_errors * 100, 2) if allowed_errors > 0 else None
    else:
        allowed_errors = 0.0; remaining = 0.0; remaining_pct = None
    return {
        "targetPct": target, "window": main,
        "allowedErrorsEquivalent": round(allowed_errors, 3), "remainingErrorsEquivalent": round(remaining, 3),
        "remainingBudgetPct": remaining_pct,
        "burnRate1h": burn(fast), "burnRate6h": burn(slow),
        "fastWindow": fast, "slowWindow": slow,
    }


def _capacity_snapshot() -> dict:
    samples = _job_samples(24)
    queued = sum(1 for item in samples if item["status"] in {"queued", "pending", "retry_wait"})
    active_jobs = sum(1 for item in samples if item["status"] in {"processing", "rendering", "running"})
    active_leases = int(identity.scalar("SELECT COUNT(*) AS count FROM v26_job_leases WHERE state='active'", default=0) or 0)
    try:
        v28_overview = v28._overview()
        replicas = max(1, int(v28_overview.get("replicaCount") or 1))
    except Exception:
        replicas = 1
    ffmpeg = v25._ffmpeg_processes()
    memory = v25._memory_info()
    storage = v25._storage_info()
    try:
        load1 = float(os.getloadavg()[0])
    except Exception:
        load1 = None
    cpu_count = max(1, int(os.cpu_count() or 1))
    ffmpeg_ratio = len(ffmpeg) / replicas
    lease_ratio = active_leases / max(1, replicas * 4)
    load_ratio = (load1 / cpu_count) if load1 is not None else 0.0
    saturation = round(max(ffmpeg_ratio, lease_ratio, load_ratio) * 100, 2)
    payload = {
        "replicaCount": replicas, "ffmpegActive": len(ffmpeg), "activeLeases": active_leases,
        "queuedJobs": queued, "activeJobs": active_jobs, "load1": load1, "cpuCount": cpu_count,
        "memoryPercent": memory.get("usedPercent"), "diskPercent": storage.get("disk", {}).get("usedPercent"),
        "saturationPercent": saturation,
    }
    return payload


def _capacity_forecast(settings: dict) -> dict:
    horizon_hours = 6.0
    samples = _job_samples(horizon_hours)
    now = time.time(); cutoff = now - horizon_hours * 3600
    arrivals = sum(1 for item in samples if item.get("created") and item["created"] >= cutoff)
    completions = sum(1 for item in samples if item.get("finished") and item["finished"] >= cutoff and item["status"] in TERMINAL)
    current = _capacity_snapshot()
    arrival_rate = arrivals / horizon_hours
    completion_rate = completions / horizon_hours
    delta = arrival_rate - completion_rate
    backlog_1h = max(0.0, float(current["queuedJobs"]) + delta)
    replicas = max(1, int(current["replicaCount"]))
    per_replica_throughput = completion_rate / replicas if completion_rate > 0 else 0.0
    if arrival_rate <= 0:
        recommended = replicas
    elif per_replica_throughput <= 0:
        recommended = min(12, replicas + 1)
    else:
        recommended = max(1, min(12, math.ceil((arrival_rate / per_replica_throughput) * 1.25)))
        if backlog_1h > max(2, replicas * 2):
            recommended = min(12, max(recommended, replicas + 1))
    return {
        "measurementHours": horizon_hours, "arrivals": arrivals, "completions": completions,
        "arrivalPerHour": round(arrival_rate, 3), "completionPerHour": round(completion_rate, 3),
        "currentBacklog": current["queuedJobs"], "forecastBacklog1h": round(backlog_1h, 2),
        "currentReplicas": replicas, "recommendedReplicas": recommended,
        "recommendation": "scale-out" if recommended > replicas else "scale-in-candidate" if recommended < replicas else "hold",
        "note": "Recommendation only; V29 does not change Railway replica count automatically.",
    }


def _latest_duplicate_count() -> int | None:
    rows = identity.fetchall("SELECT duplicate_count FROM v28_drills WHERE kind='duplicate-contest' AND state='passed' ORDER BY started_at DESC LIMIT 1")
    return int(rows[0].get("duplicate_count") or 0) if rows else None


def _latest_rto() -> int | None:
    rows = identity.fetchall("SELECT rto_ms FROM v28_drills WHERE kind='worker-kill' AND state='passed' AND rto_ms IS NOT NULL ORDER BY started_at DESC LIMIT 1")
    return int(rows[0].get("rto_ms") or 0) if rows else None


def _evaluate_release(*, persist: bool = False, version_label: str = "Creator V29", actor_id: str | None = None) -> dict:
    settings = store.get_settings()
    hours = float(settings.get("window.hours", 24) or 24)
    jobs = _job_metrics(hours, settings)
    budget = _error_budget(settings)
    api = budget["window"]
    capacity = _capacity_snapshot()
    forecast = _capacity_forecast(settings)
    v28_overview = v28._overview()
    blockers: list[str] = []
    warnings: list[str] = []

    min_jobs = max(1, int(settings.get("samples.minJobs", 5) or 5))
    min_api = max(1, int(settings.get("samples.minApi", 20) or 20))
    if not v28_overview.get("ready"):
        blockers.append("V28 reliability readiness is not READY.")
    if not bool(v28_overview.get("v27", {}).get("managedReady")):
        blockers.append("V27 managed-worker readiness is not READY.")
    if int(store.schema_status().get("pending") or 0) > 0:
        blockers.append("V29 database migrations are pending.")
    if bool(settings.get("release.requireDistributedSafe")) and not v28_overview.get("distributedSafe"):
        blockers.append("Release policy requires PostgreSQL distributed state.")
    elif not v28_overview.get("distributedSafe"):
        warnings.append("Distributed state is LOCAL ONLY; PostgreSQL is recommended before multi-replica production.")
    if bool(settings.get("release.requireMultiReplica")) and int(v28_overview.get("replicaCount") or 0) < 2:
        blockers.append("Release policy requires at least two live replicas.")
    elif int(v28_overview.get("replicaCount") or 0) < 2:
        warnings.append("Only one live replica is currently observed.")

    if jobs["terminalSamples"] >= min_jobs:
        target = float(settings.get("jobs.successTargetPct", 98) or 98)
        if jobs["successPct"] is not None and jobs["successPct"] < target:
            blockers.append(f"Job success rate {jobs['successPct']:.2f}% is below target {target:.2f}%.")
    else:
        warnings.append(f"Only {jobs['terminalSamples']} terminal job samples; minimum is {min_jobs}.")

    render_target = float(settings.get("jobs.renderP95Seconds", 900) or 900)
    render_p95 = jobs.get("renderP95Seconds")
    if render_p95 is not None and jobs.get("renderSamples", 0) >= 3 and render_p95 > render_target:
        blockers.append(f"Render P95 {render_p95:.1f}s exceeds {render_target:.1f}s target.")
    elif jobs.get("renderSamples", 0) < 3:
        warnings.append("Insufficient render samples for a stable Render P95.")

    queue_target = float(settings.get("jobs.queueP95Seconds", 120) or 120)
    queue_p95 = jobs.get("queue", {}).get("p95Seconds")
    if queue_p95 is not None and jobs.get("queue", {}).get("samples", 0) >= 3 and queue_p95 > queue_target:
        blockers.append(f"Queue P95 {queue_p95:.1f}s exceeds {queue_target:.1f}s target.")

    if api["samples"] >= min_api:
        availability_target = float(settings.get("availability.targetPct", 99.5) or 99.5)
        if api.get("availabilityPct") is not None and api["availabilityPct"] < availability_target:
            blockers.append(f"API availability {api['availabilityPct']:.3f}% is below {availability_target:.3f}%.")
        api_p95_target = float(settings.get("api.p95Ms", 2500) or 2500)
        if api.get("p95Ms") is not None and api["p95Ms"] > api_p95_target:
            blockers.append(f"API P95 {api['p95Ms']:.0f}ms exceeds {api_p95_target:.0f}ms target.")
        fast_burn = budget.get("burnRate1h")
        slow_burn = budget.get("burnRate6h")
        if fast_burn is not None and fast_burn >= float(settings.get("burn.fastThreshold", 2.0) or 2.0):
            blockers.append(f"Fast error-budget burn rate is {fast_burn:.2f}x.")
        elif slow_burn is not None and slow_burn >= float(settings.get("burn.slowThreshold", 1.0) or 1.0):
            warnings.append(f"Slow error-budget burn rate is {slow_burn:.2f}x.")
    else:
        warnings.append(f"Only {api['samples']} API samples; minimum is {min_api}.")

    rto = _latest_rto()
    rto_target = int(settings.get("rto.targetMs", 60000) or 60000)
    if rto is not None and rto > rto_target:
        blockers.append(f"Latest measured RTO {rto}ms exceeds {rto_target}ms target.")
    elif rto is None:
        warnings.append("No successful V28 worker-kill RTO measurement is available yet.")
    duplicates = _latest_duplicate_count()
    if duplicates is not None and duplicates > 0:
        blockers.append(f"Duplicate commit count is {duplicates}; target is zero.")
    elif duplicates is None:
        warnings.append("No successful V28 duplicate-execution contest has been recorded yet.")

    saturation = float(capacity.get("saturationPercent") or 0)
    block_sat = float(settings.get("capacity.blockSaturationPct", 95) or 95)
    warn_sat = float(settings.get("capacity.warnSaturationPct", 85) or 85)
    if saturation >= block_sat:
        blockers.append(f"Worker saturation {saturation:.1f}% exceeds block threshold {block_sat:.1f}%.")
    elif saturation >= warn_sat:
        warnings.append(f"Worker saturation {saturation:.1f}% exceeds warning threshold {warn_sat:.1f}%.")

    score = max(0, 100 - len(blockers) * 18 - len(warnings) * 4)
    state = "block" if blockers else "warn" if warnings else "pass"
    metrics = {
        "jobs": jobs, "api": api, "errorBudget": budget, "capacity": capacity,
        "forecast": forecast, "rtoMs": rto, "duplicateCount": duplicates,
        "databaseMode": identity.mode(), "replicaCount": v28_overview.get("replicaCount"),
    }
    result = {"state": state, "score": score, "blockers": blockers, "warnings": warnings, "metrics": metrics, "evaluatedAt": _now(), "versionLabel": version_label}
    if persist:
        return store.add_release_gate(version_label, state, score, actor_id, blockers, warnings, metrics)
    return result


def _release_cached() -> dict:
    global _GATE_CACHE
    now = time.monotonic()
    if _GATE_CACHE and now - _GATE_CACHE[0] < 10:
        return _GATE_CACHE[1]
    value = _evaluate_release()
    _GATE_CACHE = (now, value)
    return value


def _overview() -> dict:
    settings = store.get_settings()
    hours = float(settings.get("window.hours", 24) or 24)
    current_capacity = _capacity_snapshot()
    return {
        "version": "29", "generatedAt": _now(), "schema": store.schema_status(), "settings": settings,
        "jobs": _job_metrics(hours, settings), "errorBudget": _error_budget(settings),
        "capacity": current_capacity, "capacityForecast": _capacity_forecast(settings),
        "capacityHistory": store.capacity_history(60), "loadTests": store.list_load_tests(20),
        "releaseGate": _release_cached(), "releaseHistory": store.release_gate_history(15),
        "v28": {"ready": v28._overview().get("ready"), "replicaCount": v28._overview().get("replicaCount"), "distributedSafe": v28._overview().get("distributedSafe")},
        "costModel": {
            "rateUsdPerComputeHour": max(0.0, float(os.getenv("V29_COMPUTE_USD_PER_HOUR", "0") or 0)) or None,
            "isEstimate": True,
            "note": "Financial cost is shown only when V29_COMPUTE_USD_PER_HOUR is configured; it is an estimate, not Railway billing data.",
        },
    }


def _run_load_test(test_id: str, kind: str, duration: float, concurrency: int) -> None:
    latencies: list[float] = []
    errors = 0
    lock_misses = 0
    samples_lock = threading.Lock()
    started = time.monotonic()
    stop_at = started + duration
    pace = .35 if kind == "load" else .9

    def worker(index: int) -> None:
        nonlocal errors, lock_misses
        while time.monotonic() < stop_at:
            tick = time.perf_counter()
            try:
                row = identity.fetchone("SELECT 1 AS ok")
                if not row or int(row.get("ok") or 0) != 1:
                    raise RuntimeError("DB probe returned an invalid response")
                with rel26.distributed_lock(f"v29:synthetic:{test_id}:{index % 2}") as acquired:
                    if acquired:
                        identity.scalar("SELECT COUNT(*) AS count FROM v26_job_leases", default=0)
                    else:
                        with samples_lock:
                            lock_misses += 1
                elapsed = (time.perf_counter() - tick) * 1000
                with samples_lock:
                    latencies.append(elapsed)
            except Exception:
                with samples_lock:
                    errors += 1
            remaining = stop_at - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(pace, remaining))

    threads = [threading.Thread(target=worker, args=(index,), daemon=True, name=f"v29-{kind}-{index}") for index in range(concurrency)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=duration + 10)
    elapsed = max(.001, time.monotonic() - started)
    operations = len(latencies) + errors
    store.finish_load_test(
        test_id, state="passed" if errors == 0 else "warning", operations=operations, errors=errors,
        p50_ms=_percentile(latencies, .50), p95_ms=_percentile(latencies, .95), p99_ms=_percentile(latencies, .99),
        ops_per_second=round(operations / elapsed, 3),
        details={"lockMisses": lock_misses, "databaseMode": identity.mode(), "paceSeconds": pace, "syntheticOnly": True},
    )
    rel26.event("v29_capacity_test_completed", severity="info" if errors == 0 else "warning", node_id=v26.NODE_ID,
                details={"testId": test_id, "kind": kind, "operations": operations, "errors": errors, "lockMisses": lock_misses})
    _TEST_LOCK.release()


def _background_loop() -> None:
    last_cleanup = 0.0
    while not _STOP.wait(60):
        try:
            store.add_capacity_sample(_capacity_snapshot())
            now = time.monotonic()
            if now - last_cleanup > 6 * 3600:
                settings = store.get_settings()
                store.cleanup(int(settings.get("retention.apiDays", 14) or 14), int(settings.get("retention.capacityDays", 30) or 30))
                last_cleanup = now
        except Exception as exc:
            rel26.event("v29_capacity_sampler_failed", severity="warning", node_id=v26.NODE_ID, details={"error": str(exc)[:500]})


def install_v29(app) -> None:
    global _STARTED
    with _START_LOCK:
        if _STARTED:
            return
        _STARTED = True

    @app.middleware("http")
    async def v29_latency_middleware(request: Request, call_next):
        path = request.url.path
        track = path.startswith("/api/") and not path.startswith("/api/video/v29/") and "/health/" not in path and not path.endswith("/admin/overview")
        started = time.perf_counter(); status = 500
        try:
            response = await call_next(request)
            status = int(response.status_code)
            return response
        finally:
            if track:
                try:
                    store.add_api_sample(path, request.method.upper(), status, round((time.perf_counter() - started) * 1000, 3))
                except Exception:
                    pass

    async def startup() -> None:
        _STOP.clear()
        identity.execute("UPDATE v29_load_tests SET state='interrupted',finished_at=? WHERE state='running'", (_now(),))
        try:
            store.add_capacity_sample(_capacity_snapshot())
        except Exception:
            pass
        threading.Thread(target=_background_loop, daemon=True, name="v29-capacity-sampler").start()

    async def shutdown() -> None:
        _STOP.set()

    app.add_event_handler("startup", startup)
    app.add_event_handler("shutdown", shutdown)


@router.get("/health/live")
async def live_v29() -> dict:
    return {"live": True, "version": "29", "nodeId": v26.NODE_ID}


@router.get("/release/ready")
async def release_ready_v29() -> JSONResponse:
    gate = _release_cached()
    public = {"ready": gate["state"] != "block", "state": gate["state"], "score": gate["score"], "evaluatedAt": gate["evaluatedAt"], "version": "29"}
    return JSONResponse(public, status_code=503 if gate["state"] == "block" else 200)


@router.get("/admin/overview")
async def overview_v29(admin: dict = Depends(v24.require_admin)) -> dict:
    return _overview()


@router.post("/admin/settings")
async def settings_v29(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    global _GATE_CACHE
    values = payload.get("settings") if isinstance(payload.get("settings"), dict) else payload
    result = store.set_settings(values)
    _GATE_CACHE = None
    rel26.event("v29_slo_settings_updated", node_id=v26.NODE_ID, details={"actor": admin.get("id"), "keys": list(values)[:40]})
    return result


@router.post("/admin/release-gate")
async def run_release_gate_v29(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    global _GATE_CACHE
    label = str(payload.get("versionLabel") or "Creator V29")[:100]
    gate = _evaluate_release(persist=True, version_label=label, actor_id=str(admin.get("id") or "admin"))
    _GATE_CACHE = None
    rel26.event("v29_release_gate_evaluated", severity="warning" if gate.get("state") == "block" else "info", node_id=v26.NODE_ID,
                details={"actor": admin.get("id"), "gateId": gate.get("id"), "state": gate.get("state"), "score": gate.get("score")})
    return gate


@router.post("/admin/capacity-snapshot")
async def snapshot_v29(admin: dict = Depends(v24.require_admin_write)) -> dict:
    payload = _capacity_snapshot()
    sample_id = store.add_capacity_sample(payload)
    return {"id": sample_id, **payload}


@router.post("/admin/load-test")
async def load_test_v29(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    if not _TEST_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="يوجد Load/Soak Test آخر قيد التنفيذ على هذه Replica.")
    try:
        kind = str(payload.get("kind") or "load").lower()
        if kind not in {"load", "soak"}:
            kind = "load"
        max_duration = 30 if kind == "load" else 120
        max_concurrency = 6 if kind == "load" else 4
        duration = max(5.0, min(float(payload.get("durationSeconds") or (15 if kind == "load" else 60)), max_duration))
        concurrency = max(1, min(int(payload.get("concurrency") or (4 if kind == "load" else 2)), max_concurrency))
        running = int(identity.scalar("SELECT COUNT(*) AS count FROM v29_load_tests WHERE state='running'", default=0) or 0)
        if running:
            raise HTTPException(status_code=409, detail="يوجد Capacity Test مسجل كـrunning؛ انتظر أو أعد تشغيل الخدمة إذا كان سجلًا قديمًا.")
        test = store.create_load_test(kind, duration, concurrency, {"actor": admin.get("id"), "syntheticOnly": True})
        threading.Thread(target=_run_load_test, args=(str(test["id"]), kind, duration, concurrency), daemon=True, name=f"v29-{kind}-{test['id']}").start()
        return test
    except Exception:
        _TEST_LOCK.release()
        raise
