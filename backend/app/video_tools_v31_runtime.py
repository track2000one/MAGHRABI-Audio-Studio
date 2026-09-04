from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from . import video_tools_v31 as base

router = base.router


def install_v31(app) -> None:
    base.install_v31(app)
    if getattr(app.state, "v31_runtime_guard_installed", False):
        return
    app.state.v31_runtime_guard_installed = True

    @app.middleware("http")
    async def v31_gitops_concurrency_guard(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()

        if method == "POST" and path.startswith("/api/video/v31/admin/releases/") and path.endswith("/promote"):
            parts = [part for part in path.split("/") if part]
            release_id = parts[-2] if len(parts) >= 2 else ""
            target = request.headers.get("x-v31-target-environment", "").strip().lower()
            if target not in base.ENVIRONMENTS:
                return JSONResponse({"detail": "X-V31-Target-Environment مطلوب لعملية Promotion."}, status_code=428)
            with base.rel26.distributed_lock(f"v31:promote:{release_id}", blocking=False) as acquired:
                if not acquired:
                    return JSONResponse({"detail": "Promotion أخرى لنفس Release قيد التنفيذ."}, status_code=409)
                latest = base.store.get_release(release_id)
                if not latest:
                    return JSONResponse({"detail": "Release غير موجودة."}, status_code=404)
                expected = base._next_environment(base._sync_v30_child(latest))
                if expected != target:
                    return JSONResponse({"detail": f"Promotion request قديمة. المرحلة التالية الحالية هي {expected or 'NONE'} وليست {target}."}, status_code=409)
                return await call_next(request)

        if method == "POST" and path.startswith("/api/video/v31/admin/releases/") and path.endswith("/rollback"):
            parts = [part for part in path.split("/") if part]
            release_id = parts[-2] if len(parts) >= 2 else ""
            target_sha = request.headers.get("x-v31-rollback-sha", "").strip()
            if not target_sha:
                return JSONResponse({"detail": "X-V31-Rollback-Sha مطلوب لعملية Rollback."}, status_code=428)
            with base.rel26.distributed_lock(f"v31:rollback:{release_id}", blocking=False) as acquired:
                if not acquired:
                    return JSONResponse({"detail": "Rollback أخرى لنفس Release قيد التنفيذ."}, status_code=409)
                latest = base.store.get_release(release_id)
                if not latest:
                    return JSONResponse({"detail": "Release غير موجودة."}, status_code=404)
                if latest.get("state") == "rolled_back" and str(latest.get("rollbackSha") or "") == target_sha:
                    return JSONResponse(latest, status_code=200)
                return await call_next(request)

        return await call_next(request)
