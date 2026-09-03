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
app.router.routes.extend(static_mounts)
