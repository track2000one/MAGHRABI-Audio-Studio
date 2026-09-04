from starlette.routing import Mount

from .main import app
from .audio_tools import router as audio_tools_router
from .video_tools import router as video_tools_router
from .video_tools_v2 import router as video_tools_v2_router
from .video_tools_v3 import router as video_tools_v3_router
from .video_tools_v4 import router as video_tools_v4_router
from .video_tools_v5 import router as video_tools_v5_router
from .video_tools_v6 import router as video_tools_v6_router
from .video_tools_v7 import router as video_tools_v7_router
from .video_tools_v8 import router as video_tools_v8_router
from .video_tools_v9 import router as video_tools_v9_router
from .video_tools_v10 import router as video_tools_v10_router
from .video_tools_v11 import router as video_tools_v11_router
from .video_tools_v12_runtime import router as video_tools_v12_router
from .video_tools_v13_runtime import router as video_tools_v13_router
from .video_tools_v14 import router as video_tools_v14_router
from .video_tools_v15_safe import router as video_tools_v15_router
from .video_tools_v16 import router as video_tools_v16_router
from .video_tools_v17 import router as video_tools_v17_router
from .video_tools_v18 import router as video_tools_v18_router
from .video_tools_v19_runtime import router as video_tools_v19_router
from .video_tools_v20_runtime import router as video_tools_v20_router
from .video_tools_v21_runtime import router as video_tools_v21_router
from .video_tools_v22 import router as video_tools_v22_router
from .video_tools_v23_runtime import router as video_tools_v23_router
from .video_tools_v24_runtime import router as video_tools_v24_router
from .video_tools_v25 import router as video_tools_v25_router, install_observability as install_v25_observability
from .video_tools_v26_runtime import router as video_tools_v26_router, install_reliability as install_v26_reliability
from .video_tools_v27 import router as video_tools_v27_router, install_managed_workers as install_v27_managed_workers
from .video_tools_v28 import router as video_tools_v28_router, install_v28
from .video_tools_v29_runtime import router as video_tools_v29_router, install_v29
from .video_tools_v30_runtime import router as video_tools_v30_router, install_v30
from .video_tools_v31_runtime import router as video_tools_v31_router, install_v31

# main.py mounts the SPA at "/". Keep that catch-all route last so API
# endpoints remain reachable before StaticFiles handles the request.
static_mounts = [route for route in app.router.routes if isinstance(route, Mount)]
for route in static_mounts:
    app.router.routes.remove(route)

app.include_router(audio_tools_router)
app.include_router(video_tools_router)
app.include_router(video_tools_v2_router)
app.include_router(video_tools_v3_router)
app.include_router(video_tools_v4_router)
app.include_router(video_tools_v5_router)
app.include_router(video_tools_v6_router)
app.include_router(video_tools_v7_router)
app.include_router(video_tools_v8_router)
app.include_router(video_tools_v9_router)
app.include_router(video_tools_v10_router)
app.include_router(video_tools_v11_router)
app.include_router(video_tools_v12_router)
app.include_router(video_tools_v13_router)
app.include_router(video_tools_v14_router)
app.include_router(video_tools_v15_router)
app.include_router(video_tools_v16_router)
app.include_router(video_tools_v17_router)
app.include_router(video_tools_v18_router)
app.include_router(video_tools_v19_router)
app.include_router(video_tools_v20_router)
app.include_router(video_tools_v21_router)
app.include_router(video_tools_v22_router)
app.include_router(video_tools_v23_router)
app.include_router(video_tools_v24_router)
app.include_router(video_tools_v25_router)
app.include_router(video_tools_v26_router)
app.include_router(video_tools_v27_router)
app.include_router(video_tools_v28_router)
app.include_router(video_tools_v29_router)
app.include_router(video_tools_v30_router)
app.include_router(video_tools_v31_router)
app.router.routes.extend(static_mounts)

# Install observability, reliability, managed workers, chaos validation,
# SLO/capacity sampling, progressive delivery, then GitOps synchronization.
install_v25_observability(app)
install_v26_reliability(app)
install_v27_managed_workers(app)
install_v28(app)
install_v29(app)
install_v30(app)
install_v31(app)
