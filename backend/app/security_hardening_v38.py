from __future__ import annotations

import os

from fastapi import Request

CSP = "; ".join(
    [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
    ]
)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": CSP,
}


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def is_https_request(request: Request) -> bool:
    forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


def is_sensitive_path(path: str) -> bool:
    normalized = path.rstrip("/") or "/"
    return (
        normalized.startswith("/api/auth")
        or "/admin/" in normalized
        or normalized.endswith("/admin")
        or normalized.endswith("/release/ready")
        or normalized.startswith("/api/video/v40")
    )


def _disable_public_docs(app) -> None:
    if _truthy(os.getenv("ENABLE_API_DOCS")):
        return
    blocked = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}
    app.router.routes[:] = [route for route in app.router.routes if getattr(route, "path", None) not in blocked]


def install_security_hardening(app) -> None:
    if getattr(app.state, "v38_security_headers_installed", False):
        return
    app.state.v38_security_headers_installed = True
    _disable_public_docs(app)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        if is_https_request(request):
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if is_sensitive_path(request.url.path):
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
        return response
