from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from . import video_tools_v40 as base

router = base.router


def install_v40(app) -> None:
    if getattr(app.state, "v40_final_gate_installed", False):
        return
    app.state.v40_final_gate_installed = True

    @app.middleware("http")
    async def v40_final_promotion_guard(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if method == "POST" and path.startswith("/api/video/v31/admin/releases/") and path.endswith("/promote"):
            target = request.headers.get("x-v31-target-environment", "").strip().lower()
            if target == "production":
                parts = [part for part in path.split("/") if part]
                release_id = parts[-2] if len(parts) >= 2 else ""
                release = base.v31.store.get_release(release_id)
                if not release:
                    return JSONResponse({"detail": "V31 Release غير موجودة."}, status_code=404)
                readiness = base.final_readiness(release)
                if not readiness.get("ready"):
                    return JSONResponse(
                        {
                            "detail": "Creator V40 Final Production Readiness Gate منع Production promotion.",
                            "code": "V40_FINAL_GATE_BLOCKED",
                            "readiness": readiness,
                        },
                        status_code=412,
                    )
        return await call_next(request)
