from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from . import video_tools_v34 as base

router = base.router

# V34 originally protected the first Railway-compatible CPU pair. The final
# production line moved to 2.6.0/2.6.0 because Trivy correctly blocked the
# older torch build for CVE-2025-32434. Keep the protection non-waivable while
# validating the new matched CPU pair.
_original_python_lock = base._python_lock


def _secure_python_lock(release: dict) -> dict:
    result = _original_python_lock(release)
    result["torchCpu"] = result.get("torchVersion") == "2.6.0+cpu"
    result["torchaudioCpu"] = result.get("torchaudioVersion") == "2.6.0+cpu"
    result["protectedPair"] = "torch 2.6.0+cpu / torchaudio 2.6.0+cpu"
    return result


base._python_lock = _secure_python_lock


def install_v34(app) -> None:
    if getattr(app.state, "v34_hermetic_gate_installed", False):
        return
    app.state.v34_hermetic_gate_installed = True

    @app.middleware("http")
    async def v34_hermetic_promotion_guard(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if method == "POST" and path.startswith("/api/video/v31/admin/releases/") and path.endswith("/promote"):
            target = request.headers.get("x-v31-target-environment", "").strip().lower()
            if target == "production":
                parts = [p for p in path.split("/") if p]
                release_id = parts[-2] if len(parts) >= 2 else ""
                release = base.v31.store.get_release(release_id)
                if not release:
                    return JSONResponse({"detail": "V31 Release غير موجودة."}, status_code=404)
                assessment = base.store.latest_assessment(release_id, str(release.get("candidateSha") or ""))
                if not assessment:
                    return JSONResponse(
                        {
                            "detail": "Creator V34 hermetic assessment مطلوبة قبل Production.",
                            "code": "V34_ASSESSMENT_REQUIRED",
                            "releaseId": release_id,
                            "candidateSha": release.get("candidateSha"),
                        },
                        status_code=428,
                    )
                gate = base._gate(assessment, release, "production")
                if not gate.get("ready"):
                    return JSONResponse(
                        {
                            "detail": "Creator V34 Hermetic Artifact Gate منع Production promotion.",
                            "code": "V34_HERMETIC_GATE_BLOCKED",
                            "gate": gate,
                        },
                        status_code=412,
                    )
        return await call_next(request)
