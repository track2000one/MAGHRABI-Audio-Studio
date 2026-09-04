from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from . import video_tools_v32 as base

router = base.router


def install_v32(app) -> None:
    if getattr(app.state, "v32_supply_chain_guard_installed", False):
        return
    app.state.v32_supply_chain_guard_installed = True

    @app.middleware("http")
    async def v32_supply_chain_promotion_guard(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if method == "POST" and path.startswith("/api/video/v31/admin/releases/") and path.endswith("/promote"):
            target = request.headers.get("x-v31-target-environment", "").strip().lower()
            if target in {"staging", "production"}:
                parts = [part for part in path.split("/") if part]
                release_id = parts[-2] if len(parts) >= 2 else ""
                release = base.v31.store.get_release(release_id)
                if not release:
                    return JSONResponse({"detail": "V31 Release غير موجودة."}, status_code=404)
                scan = base.store.latest_scan(release_id, str(release.get("candidateSha") or ""))
                if not scan:
                    return JSONResponse({
                        "detail": "Creator V32 supply-chain scan مطلوب قبل Promotion إلى Staging/Production.",
                        "code": "V32_SCAN_REQUIRED", "releaseId": release_id,
                        "candidateSha": release.get("candidateSha"), "targetEnvironment": target,
                    }, status_code=428)
                gate = base.evaluate_gate(scan, release, target)
                if not gate.get("ready"):
                    return JSONResponse({
                        "detail": "Creator V32 Supply-Chain Gate منع Promotion.",
                        "code": "V32_SUPPLY_CHAIN_BLOCKED", "gate": gate,
                    }, status_code=412)
        return await call_next(request)
