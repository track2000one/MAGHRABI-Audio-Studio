from starlette.routing import Mount

from .main import app
from .audio_tools import router as audio_tools_router

# main.py mounts the SPA at "/". Keep that catch-all route last so the
# /api/tools endpoints are reachable before StaticFiles handles the request.
static_mounts = [route for route in app.router.routes if isinstance(route, Mount)]
for route in static_mounts:
    app.router.routes.remove(route)

app.include_router(audio_tools_router)
app.router.routes.extend(static_mounts)
