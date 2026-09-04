from __future__ import annotations

import os
import re
import socket

from fastapi import Request
from fastapi.responses import JSONResponse

from . import video_tools_v26 as base

# RAILWAY_REPLICA_ID is the preferred stable identity. When it is absent,
# never fall back to deployment id alone because a deployment may have more
# than one replica. Hostname + PID keeps the runtime node identity unique.
base.DEPLOYMENT_ID = os.getenv("RAILWAY_DEPLOYMENT_ID", "")
base.INSTANCE_ID = os.getenv("RAILWAY_REPLICA_ID") or os.getenv("HOSTNAME") or socket.gethostname()
base.NODE_ID = (
    os.getenv("RAILWAY_REPLICA_ID")
    or f"{base.DEPLOYMENT_ID or 'local'}:{socket.gethostname()}:{os.getpid()}"
)

router = base.router


def install_reliability(app) -> None:
    base.install_reliability(app)
    if getattr(app.state, "v26_unversioned_video_gate_installed", False):
        return
    app.state.v26_unversioned_video_gate_installed = True

    @app.middleware("http")
    async def v26_unversioned_video_gate(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        is_versioned = bool(re.match(r"^/api/video/v\d+(?:/|$)", path))
        is_base_video_mutation = (
            path.startswith("/api/video/")
            and not is_versioned
            and method not in {"GET", "HEAD", "OPTIONS"}
        )
        maintenance = base._maintenance()
        if is_base_video_mutation and (maintenance["enabled"] or maintenance["draining"]):
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "Production processing is temporarily unavailable during Maintenance/Draining.",
                    "maintenance": maintenance,
                },
                headers={"Retry-After": "30", "X-MAGHRABI-MAINTENANCE": "true"},
            )
        return await call_next(request)
