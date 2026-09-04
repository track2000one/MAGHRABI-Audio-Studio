from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from . import video_tools_v33 as base

router = base.router


def install_v33(app) -> None:
    if getattr(app.state, "v33_repro_gate_installed", False):
        return
    app.state.v33_repro_gate_installed = True

    @app.middleware("http")
    async def v33_reproducible_release_guard(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if method == "POST" and path.startswith("/api/video/v31/admin/releases/") and path.endswith("/promote"):
            target = request.headers.get("x-v31-target-environment", "").strip().lower()
            policy = base.store.policy()
            enforce = target == "production" or (target == "staging" and bool(policy.get("enforceStaging")))
            if enforce:
                parts = [part for part in path.split("/") if part]
                release_id = parts[-2] if len(parts) >= 2 else ""
                release = base.v31.store.get_release(release_id)
                if not release:
                    return JSONResponse({"detail":"V31 Release غير موجودة."}, status_code=404)
                assessment = base.store.latest_assessment(release_id, str(release.get("candidateSha") or ""))
                if not assessment:
                    return JSONResponse({
                        "detail":"Creator V33 reproducible-build assessment مطلوبة قبل Promotion.",
                        "code":"V33_ASSESSMENT_REQUIRED","releaseId":release_id,
                        "candidateSha":release.get("candidateSha"),"targetEnvironment":target,
                    }, status_code=428)
                gate = base._current_gate(assessment, release, target)
                if not gate.get("ready"):
                    return JSONResponse({
                        "detail":"Creator V33 Reproducibility / Attestation Gate منع Promotion.",
                        "code":"V33_REPRO_GATE_BLOCKED","gate":gate,
                    }, status_code=412)
        return await call_next(request)
