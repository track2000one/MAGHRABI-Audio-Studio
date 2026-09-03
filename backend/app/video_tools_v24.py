from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import smtplib
import ssl
import struct
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from email.message import EmailMessage

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Body, Depends, Form, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, RedirectResponse

from . import identity_store_v24 as store
from . import video_tools_v21 as v21
from . import video_tools_v22 as v22
from .main import AUTH_SECRET, current_user

router = APIRouter(prefix="/api/video/v24", tags=["video-studio-v24"])

SESSION_COOKIE = "maghrabi_v24_session"
CSRF_COOKIE = "maghrabi_v24_csrf"
SESSION_TTL = int(os.getenv("V24_SESSION_TTL_SECONDS", str(12 * 60 * 60)))
RESET_TTL = int(os.getenv("V24_RESET_TTL_SECONDS", str(60 * 60)))
INVITE_TTL = int(os.getenv("V24_INVITE_TTL_SECONDS", str(7 * 24 * 60 * 60)))
RATE_WINDOW = int(os.getenv("V24_LOGIN_RATE_WINDOW_SECONDS", "900"))
RATE_MAX = int(os.getenv("V24_LOGIN_RATE_MAX", "5"))
RATE_BLOCK = int(os.getenv("V24_LOGIN_RATE_BLOCK_SECONDS", "900"))
PBKDF2_ITERATIONS = max(120_000, int(os.getenv("V24_PBKDF2_ITERATIONS", "310000")))
ROLES = {"admin", "producer", "editor", "reviewer", "viewer"}
PERMISSIONS = {"view": 10, "review": 20, "edit": 30, "manage": 40}
RESOURCE_TYPES = {"v21_project", "v22_room"}

SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USERNAME).strip()
SMTP_STARTTLS = os.getenv("SMTP_STARTTLS", "true").lower() not in {"0", "false", "no"}
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")

OIDC_ISSUER = os.getenv("OIDC_ISSUER", "").strip().rstrip("/")
OIDC_CLIENT_ID = os.getenv("OIDC_CLIENT_ID", "").strip()
OIDC_CLIENT_SECRET = os.getenv("OIDC_CLIENT_SECRET", "")
OIDC_REDIRECT_URI = os.getenv("OIDC_REDIRECT_URI", "").strip()
OIDC_SCOPES = os.getenv("OIDC_SCOPES", "openid profile email").strip()
OIDC_AUTO_PROVISION = os.getenv("OIDC_AUTO_PROVISION", "false").lower() in {"1", "true", "yes"}
_OIDC_CACHE: tuple[float, dict] | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ts() -> int:
    return int(time.time())


def _require_secret() -> bytes:
    if not AUTH_SECRET or len(AUTH_SECRET) < 32:
        raise HTTPException(status_code=503, detail="AUTH_SECRET يجب أن يكون مهيأ بطول 32 حرفًا على الأقل لتشغيل V24.")
    return AUTH_SECRET.encode("utf-8")


def _fernet() -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(_require_secret() + b"|v24-mfa|").digest())
    return Fernet(key)


def _encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    if len(password) < 10:
        raise HTTPException(status_code=400, detail="كلمة المرور يجب ألا تقل عن 10 أحرف.")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return _b64(salt), _b64(digest)


def _verify_password(password: str, salt_text: str | None, digest_text: str | None) -> bool:
    if not salt_text or not digest_text:
        return False
    try:
        salt = base64.urlsafe_b64decode(salt_text + "=" * (-len(salt_text) % 4))
        _salt, candidate = _hash_password(password, salt)
        return hmac.compare_digest(candidate, digest_text)
    except Exception:
        return False


def _token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _safe_json(value: str | None):
    try:
        return json.loads(value or "{}")
    except Exception:
        return {}


def _public_user(row: dict | None, internal: bool = False) -> dict | None:
    if not row:
        return None
    result = {
        "id": row.get("id"), "name": row.get("name"), "email": row.get("email"),
        "role": row.get("role"), "status": row.get("status"), "active": bool(row.get("active")),
        "mfaEnabled": bool(row.get("mfa_enabled")), "createdAt": row.get("created_at"),
        "lastLoginAt": row.get("last_login_at"),
    }
    if internal:
        result["authVersion"] = int(row.get("auth_version") or 1)
    return result


def _audit(actor: dict, action: str, details: dict | None = None) -> None:
    store.execute(
        "INSERT INTO v24_audit(id,actor_id,actor_name,actor_role,action,details_json,created_at) VALUES(?,?,?,?,?,?,?)",
        (uuid.uuid4().hex[:16], actor.get("id"), actor.get("name"), actor.get("role"), action,
         json.dumps(details or {}, ensure_ascii=False), _now()),
    )


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _rate_key(request: Request, email: str) -> str:
    raw = f"{_client_ip(request)}|{email.lower()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _rate_check(request: Request, email: str) -> None:
    key = _rate_key(request, email)
    row = store.fetchone("SELECT * FROM v24_login_buckets WHERE bucket_key=?", (key,))
    now = _now_ts()
    if row and int(row.get("blocked_until") or 0) > now:
        retry = int(row["blocked_until"]) - now
        raise HTTPException(status_code=429, detail=f"محاولات دخول كثيرة. أعد المحاولة بعد {retry} ثانية.")


def _rate_fail(request: Request, email: str) -> None:
    key = _rate_key(request, email)
    now = _now_ts()
    row = store.fetchone("SELECT * FROM v24_login_buckets WHERE bucket_key=?", (key,))
    if not row or now - int(row.get("window_started") or 0) > RATE_WINDOW:
        store.execute("DELETE FROM v24_login_buckets WHERE bucket_key=?", (key,))
        store.execute("INSERT INTO v24_login_buckets(bucket_key,attempt_count,window_started,blocked_until) VALUES(?,?,?,0)", (key, 1, now))
        return
    count = int(row.get("attempt_count") or 0) + 1
    blocked = now + RATE_BLOCK if count >= RATE_MAX else int(row.get("blocked_until") or 0)
    store.execute("UPDATE v24_login_buckets SET attempt_count=?, blocked_until=? WHERE bucket_key=?", (count, blocked, key))


def _rate_clear(request: Request, email: str) -> None:
    store.execute("DELETE FROM v24_login_buckets WHERE bucket_key=?", (_rate_key(request, email),))


def _totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _totp_code(secret: str, timestamp: int | None = None) -> str:
    timestamp = timestamp or _now_ts()
    counter = timestamp // 30
    normalized = secret + "=" * (-len(secret) % 8)
    key = base64.b32decode(normalized, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{value:06d}"


def _verify_totp(secret: str | None, code: str) -> bool:
    if not secret or not code or len(code.strip()) != 6:
        return False
    now = _now_ts()
    return any(hmac.compare_digest(_totp_code(secret, now + drift * 30), code.strip()) for drift in (-1, 0, 1))


def _session_by_request(request: Request) -> tuple[dict, dict] | tuple[None, None]:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None, None
    row = store.fetchone("SELECT * FROM v24_sessions WHERE token_hash=?", (_token_hash(raw),))
    if not row or row.get("revoked_at") or int(row.get("expires_at") or 0) < _now_ts():
        return None, None
    user = store.fetchone("SELECT * FROM v24_users WHERE id=?", (row.get("user_id"),))
    if not user or not bool(user.get("active")) or user.get("status") != "active":
        return None, None
    store.execute("UPDATE v24_sessions SET last_seen_at=? WHERE id=?", (_now(), row["id"]))
    return user, row


def _legacy_admin(request: Request) -> dict | None:
    username = current_user(request)
    return {"id": "legacy-admin", "name": username, "email": None, "role": "admin", "legacy": True} if username else None


def require_user(request: Request) -> dict:
    user, _session = _session_by_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="يلزم تسجيل الدخول بحساب V24.")
    return user


def require_admin(request: Request) -> dict:
    user, _session = _session_by_request(request)
    if user and user.get("role") == "admin":
        return user
    legacy = _legacy_admin(request)
    if legacy:
        return legacy
    raise HTTPException(status_code=403, detail="تتطلب العملية صلاحية Admin.")


def _csrf(request: Request) -> None:
    _user, session = _session_by_request(request)
    if not session:
        raise HTTPException(status_code=401, detail="الجلسة غير صالحة.")
    header = request.headers.get("x-maghrabi-csrf", "")
    cookie = request.cookies.get(CSRF_COOKIE, "")
    if not header or not cookie or not hmac.compare_digest(header, cookie) or not hmac.compare_digest(_token_hash(header), str(session.get("csrf_hash") or "")):
        raise HTTPException(status_code=403, detail="CSRF validation failed.")


def require_user_write(request: Request) -> dict:
    user = require_user(request)
    _csrf(request)
    return user


def require_admin_write(request: Request) -> dict:
    user, _session = _session_by_request(request)
    if user and user.get("role") == "admin":
        _csrf(request)
        return user
    legacy = _legacy_admin(request)
    if legacy:
        return legacy
    raise HTTPException(status_code=403, detail="تتطلب العملية صلاحية Admin.")


def _issue_session(response: Response, request: Request, user: dict) -> dict:
    raw = secrets.token_urlsafe(40)
    csrf = secrets.token_urlsafe(30)
    sid = uuid.uuid4().hex[:18]
    now = _now()
    store.execute(
        "INSERT INTO v24_sessions(id,user_id,token_hash,csrf_hash,created_at,expires_at,last_seen_at,ip,user_agent,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)",
        (sid, user["id"], _token_hash(raw), _token_hash(csrf), now, _now_ts() + SESSION_TTL, now,
         _client_ip(request), request.headers.get("user-agent", "")[:500]),
    )
    response.set_cookie(SESSION_COOKIE, raw, max_age=SESSION_TTL, httponly=True, secure=True, samesite="lax", path="/")
    response.set_cookie(CSRF_COOKIE, csrf, max_age=SESSION_TTL, httponly=False, secure=True, samesite="lax", path="/")
    return {"id": sid, "csrfToken": csrf}


def _clear_session_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
    response.delete_cookie(CSRF_COOKIE, path="/", secure=True, httponly=False, samesite="lax")


def _public_session(row: dict, current_id: str | None = None) -> dict:
    return {
        "id": row.get("id"), "createdAt": row.get("created_at"), "expiresAt": row.get("expires_at"),
        "lastSeenAt": row.get("last_seen_at"), "ip": row.get("ip"), "userAgent": row.get("user_agent"),
        "revoked": bool(row.get("revoked_at")), "current": row.get("id") == current_id,
    }


def _send_email(to: str, subject: str, text: str) -> tuple[bool, str | None]:
    if not SMTP_HOST or not SMTP_FROM:
        return False, "SMTP غير مهيأ."
    message = EmailMessage()
    message["From"] = SMTP_FROM
    message["To"] = to
    message["Subject"] = subject
    message.set_content(text)
    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=12) as client:
            if SMTP_STARTTLS:
                client.starttls(context=context)
            if SMTP_USERNAME:
                client.login(SMTP_USERNAME, SMTP_PASSWORD)
            client.send_message(message)
        return True, None
    except Exception as exc:
        return False, str(exc)[:500]


def _base_url(request: Request) -> str:
    return PUBLIC_BASE_URL or str(request.base_url).rstrip("/")


def _resource_catalog() -> list[dict]:
    output: list[dict] = []
    for path in v21.PROJECTS_DIR.glob("*/project.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            output.append({"type": "v21_project", "id": state.get("id"), "name": state.get("name"), "status": state.get("status"), "updatedAt": state.get("updatedAt")})
        except Exception:
            continue
    for path in v22.ROOMS_DIR.glob("*/room.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            output.append({"type": "v22_room", "id": state.get("id"), "name": state.get("name"), "status": v22._approval_state(state).get("status"), "updatedAt": state.get("updatedAt")})
        except Exception:
            continue
    output.sort(key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
    return output[:500]


def _team_ids(user_id: str) -> set[str]:
    return {str(item["team_id"]) for item in store.fetchall("SELECT team_id FROM v24_team_members WHERE user_id=?", (user_id,))}


def _permission_for(user: dict, resource_type: str, resource_id: str) -> str | None:
    if user.get("role") == "admin":
        return "manage"
    team_ids = _team_ids(str(user["id"]))
    rows = store.fetchall("SELECT * FROM v24_acl WHERE resource_type=? AND resource_id=?", (resource_type, resource_id))
    values = []
    for row in rows:
        if row.get("owner_user_id") == user.get("id"):
            values.append("manage")
        if row.get("principal_type") == "user" and row.get("principal_id") == user.get("id"):
            values.append(str(row.get("permission")))
        if row.get("principal_type") == "team" and row.get("principal_id") in team_ids:
            values.append(str(row.get("permission")))
    valid = [item for item in values if item in PERMISSIONS]
    return max(valid, key=lambda item: PERMISSIONS[item]) if valid else None


def _require_resource(user: dict, resource_type: str, resource_id: str, minimum: str) -> str:
    permission = _permission_for(user, resource_type, resource_id)
    if not permission or PERMISSIONS[permission] < PERMISSIONS[minimum]:
        raise HTTPException(status_code=403, detail="لا تملك صلاحية كافية على هذا المورد.")
    return permission


def _oidc_ready() -> bool:
    return bool(OIDC_ISSUER and OIDC_CLIENT_ID and OIDC_REDIRECT_URI)


def _oidc_discovery() -> dict:
    global _OIDC_CACHE
    if not _oidc_ready():
        raise HTTPException(status_code=503, detail="OIDC غير مهيأ.")
    if _OIDC_CACHE and time.time() - _OIDC_CACHE[0] < 3600:
        return _OIDC_CACHE[1]
    url = f"{OIDC_ISSUER}/.well-known/openid-configuration"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"تعذر قراءة OIDC Discovery: {str(exc)[:300]}") from exc
    _OIDC_CACHE = (time.time(), data)
    return data


def _signed_state(return_hash: str = "#secure") -> str:
    payload = json.dumps({"ts": _now_ts(), "nonce": secrets.token_urlsafe(12), "return": return_hash}, separators=(",", ":")).encode("utf-8")
    encoded = _b64(payload)
    signature = _b64(hmac.new(_require_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _verify_state(state: str) -> dict:
    try:
        encoded, signature = state.split(".", 1)
        expected = _b64(hmac.new(_require_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8"))
        if _now_ts() - int(payload.get("ts", 0)) > 600:
            raise ValueError("expired")
        return payload
    except Exception as exc:
        raise HTTPException(status_code=400, detail="OIDC state غير صالح أو منتهي.") from exc


def _upsert_oidc_user(claims: dict) -> dict:
    email = str(claims.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=403, detail="مزود OIDC لم يُرجع بريدًا إلكترونيًا.")
    user = store.fetchone("SELECT * FROM v24_users WHERE lower(email)=lower(?)", (email,))
    if user:
        if not bool(user.get("active")):
            raise HTTPException(status_code=403, detail="الحساب معطل.")
        return user
    if not OIDC_AUTO_PROVISION:
        raise HTTPException(status_code=403, detail="الحساب غير موجود في V24 وAuto Provision غير مفعّل.")
    user_id = uuid.uuid4().hex[:14]
    name = str(claims.get("name") or claims.get("preferred_username") or email.split("@")[0])[:100]
    store.execute(
        "INSERT INTO v24_users(id,name,email,role,status,active,password_salt,password_hash,auth_version,mfa_secret,mfa_enabled,created_at,last_login_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (user_id, name, email, "viewer", "active", 1, None, None, 1, None, 0, _now(), None),
    )
    return store.fetchone("SELECT * FROM v24_users WHERE id=?", (user_id,)) or {}


@router.get("/info")
async def info_v24(request: Request) -> dict:
    migration = store.migrate_v23_if_empty(_now())
    user, _session = _session_by_request(request)
    legacy = _legacy_admin(request)
    return {
        "version": "24", "dbMode": store.mode(), "databaseUrlConfigured": store.configured_postgres(),
        "sqlitePath": str(store.SQLITE_PATH) if store.mode() == "sqlite" else None,
        "migration": migration, "authenticated": bool(user), "user": _public_user(user), "legacyAdmin": bool(legacy),
        "security": {"csrf": True, "serverSessions": True, "mfaTotp": True, "passwordReset": True,
                     "rateLimit": {"max": RATE_MAX, "windowSeconds": RATE_WINDOW, "blockSeconds": RATE_BLOCK}},
        "email": {"configured": bool(SMTP_HOST and SMTP_FROM), "host": SMTP_HOST or None, "from": SMTP_FROM or None},
        "oidc": {"configured": _oidc_ready(), "issuer": OIDC_ISSUER or None, "autoProvision": OIDC_AUTO_PROVISION},
    }


@router.post("/auth/login")
async def login_v24(request: Request, response: Response, payload: dict = Body(...)) -> dict:
    store.migrate_v23_if_empty(_now())
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    otp = str(payload.get("otp") or "").strip()
    _rate_check(request, email)
    user = store.fetchone("SELECT * FROM v24_users WHERE lower(email)=lower(?)", (email,))
    if not user or not bool(user.get("active")) or user.get("status") != "active" or not _verify_password(password, user.get("password_salt"), user.get("password_hash")):
        _rate_fail(request, email)
        raise HTTPException(status_code=401, detail="البريد الإلكتروني أو كلمة المرور غير صحيحة.")
    if bool(user.get("mfa_enabled")):
        secret = _decrypt_secret(user.get("mfa_secret"))
        if not otp:
            return {"authenticated": False, "mfaRequired": True, "message": "أدخل رمز Authenticator لإكمال تسجيل الدخول."}
        if not _verify_totp(secret, otp):
            _rate_fail(request, email)
            raise HTTPException(status_code=401, detail="رمز MFA غير صحيح.")
    _rate_clear(request, email)
    store.execute("UPDATE v24_users SET last_login_at=? WHERE id=?", (_now(), user["id"]))
    session = _issue_session(response, request, user)
    _audit(user, "v24_login", {"sessionId": session["id"], "ip": _client_ip(request)})
    return {"authenticated": True, "mfaRequired": False, "user": _public_user(user), **session}


@router.post("/auth/logout")
async def logout_v24(request: Request, response: Response, user: dict = Depends(require_user_write)) -> dict:
    _u, session = _session_by_request(request)
    if session:
        store.execute("UPDATE v24_sessions SET revoked_at=? WHERE id=?", (_now(), session["id"]))
        _audit(user, "v24_logout", {"sessionId": session["id"]})
    _clear_session_cookies(response)
    return {"authenticated": False}


@router.get("/auth/status")
async def status_v24(request: Request) -> dict:
    user, session = _session_by_request(request)
    return {"authenticated": bool(user), "user": _public_user(user), "sessionId": session.get("id") if session else None}


@router.post("/auth/forgot-password")
async def forgot_password_v24(request: Request, payload: dict = Body(...)) -> dict:
    email = str(payload.get("email") or "").strip().lower()
    user = store.fetchone("SELECT * FROM v24_users WHERE lower(email)=lower(?)", (email,))
    if user and bool(user.get("active")):
        token = secrets.token_urlsafe(40)
        store.execute("UPDATE v24_password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL", (_now(), user["id"]))
        store.execute(
            "INSERT INTO v24_password_resets(id,user_id,email,token_hash,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?,NULL)",
            (uuid.uuid4().hex[:16], user["id"], email, _token_hash(token), _now(), _now_ts() + RESET_TTL),
        )
        link = f"{_base_url(request)}/#reset={token}"
        sent, error = _send_email(email, "MAGHRABI Video Studio - Password Reset", f"استخدم الرابط التالي لإعادة تعيين كلمة المرور:\n\n{link}\n\nصلاحية الرابط محدودة.")
        _audit(user, "password_reset_requested", {"emailSent": sent, "emailError": error})
    return {"ok": True, "message": "إذا كان الحساب موجودًا فسيتم إنشاء طلب إعادة تعيين كلمة المرور."}


@router.get("/reset/{token}/info")
async def reset_info_v24(token: str) -> dict:
    row = store.fetchone("SELECT * FROM v24_password_resets WHERE token_hash=?", (_token_hash(token),))
    if not row or row.get("used_at") or int(row.get("expires_at") or 0) < _now_ts():
        raise HTTPException(status_code=404, detail="رابط إعادة التعيين غير صالح أو منتهي.")
    return {"email": row.get("email"), "expiresAt": row.get("expires_at")}


@router.post("/reset/{token}/complete")
async def reset_complete_v24(token: str, payload: dict = Body(...)) -> dict:
    row = store.fetchone("SELECT * FROM v24_password_resets WHERE token_hash=?", (_token_hash(token),))
    if not row or row.get("used_at") or int(row.get("expires_at") or 0) < _now_ts():
        raise HTTPException(status_code=404, detail="رابط إعادة التعيين غير صالح أو منتهي.")
    salt, digest = _hash_password(str(payload.get("password") or ""))
    user = store.fetchone("SELECT * FROM v24_users WHERE id=?", (row["user_id"],))
    if not user:
        raise HTTPException(status_code=404, detail="الحساب غير موجود.")
    store.execute("UPDATE v24_users SET password_salt=?, password_hash=?, auth_version=auth_version+1 WHERE id=?", (salt, digest, user["id"]))
    store.execute("UPDATE v24_password_resets SET used_at=? WHERE id=?", (_now(), row["id"]))
    store.execute("UPDATE v24_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (_now(), user["id"]))
    _audit(user, "password_reset_completed")
    return {"ok": True}


@router.get("/me")
async def me_v24(request: Request, user: dict = Depends(require_user)) -> dict:
    _u, session = _session_by_request(request)
    sessions = store.fetchall("SELECT * FROM v24_sessions WHERE user_id=? ORDER BY created_at DESC", (user["id"],))
    return {"user": _public_user(user), "sessions": [_public_session(item, session.get("id") if session else None) for item in sessions[:30]]}


@router.post("/me/sessions/{session_id}/revoke")
async def revoke_session_v24(session_id: str, request: Request, response: Response, user: dict = Depends(require_user_write)) -> dict:
    row = store.fetchone("SELECT * FROM v24_sessions WHERE id=? AND user_id=?", (session_id, user["id"]))
    if not row:
        raise HTTPException(status_code=404, detail="الجلسة غير موجودة.")
    store.execute("UPDATE v24_sessions SET revoked_at=? WHERE id=?", (_now(), session_id))
    _u, current = _session_by_request(request)
    if current and current.get("id") == session_id:
        _clear_session_cookies(response)
    _audit(user, "session_revoked", {"sessionId": session_id})
    return {"ok": True}


@router.post("/me/sessions/revoke-others")
async def revoke_other_sessions_v24(request: Request, user: dict = Depends(require_user_write)) -> dict:
    _u, current = _session_by_request(request)
    current_id = current.get("id") if current else ""
    store.execute("UPDATE v24_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL", (_now(), user["id"], current_id))
    _audit(user, "other_sessions_revoked")
    return {"ok": True}


@router.post("/me/mfa/setup")
async def mfa_setup_v24(user: dict = Depends(require_user_write)) -> dict:
    secret = _totp_secret()
    store.execute("UPDATE v24_users SET mfa_secret=?, mfa_enabled=0 WHERE id=?", (_encrypt_secret(secret), user["id"]))
    label = urllib.parse.quote(f"MAGHRABI Video Studio:{user.get('email')}")
    issuer = urllib.parse.quote("MAGHRABI Video Studio")
    uri = f"otpauth://totp/{label}?secret={secret}&issuer={issuer}&digits=6&period=30"
    _audit(user, "mfa_setup_started")
    return {"secret": secret, "otpauthUri": uri}


@router.post("/me/mfa/confirm")
async def mfa_confirm_v24(payload: dict = Body(...), user: dict = Depends(require_user_write)) -> dict:
    fresh = store.fetchone("SELECT * FROM v24_users WHERE id=?", (user["id"],)) or user
    secret = _decrypt_secret(fresh.get("mfa_secret"))
    if not _verify_totp(secret, str(payload.get("code") or "")):
        raise HTTPException(status_code=400, detail="رمز MFA غير صحيح.")
    store.execute("UPDATE v24_users SET mfa_enabled=1 WHERE id=?", (user["id"],))
    _audit(user, "mfa_enabled")
    return {"enabled": True}


@router.post("/me/mfa/disable")
async def mfa_disable_v24(payload: dict = Body(...), user: dict = Depends(require_user_write)) -> dict:
    fresh = store.fetchone("SELECT * FROM v24_users WHERE id=?", (user["id"],)) or user
    password = str(payload.get("password") or "")
    code = str(payload.get("code") or "")
    if not _verify_password(password, fresh.get("password_salt"), fresh.get("password_hash")) or not _verify_totp(_decrypt_secret(fresh.get("mfa_secret")), code):
        raise HTTPException(status_code=403, detail="كلمة المرور أو رمز MFA غير صحيح.")
    store.execute("UPDATE v24_users SET mfa_secret=NULL, mfa_enabled=0 WHERE id=?", (user["id"],))
    _audit(user, "mfa_disabled")
    return {"enabled": False}


@router.get("/me/resources")
async def resources_v24(user: dict = Depends(require_user)) -> dict:
    resources = []
    for item in _resource_catalog():
        permission = _permission_for(user, str(item["type"]), str(item["id"]))
        if permission:
            resources.append({**item, "permission": permission})
    return {"resources": resources}


@router.get("/me/review/{room_id}/video")
async def review_video_v24(room_id: str, version_id: str | None = Query(None), user: dict = Depends(require_user)) -> FileResponse:
    _require_resource(user, "v22_room", room_id, "view")
    state = v22._read_room(room_id)
    target = version_id or state.get("activeVersionId")
    version, path = v22._version_path(state, str(target))
    return FileResponse(path, media_type="video/mp4", filename=f"MAGHRABI-v24-review-v{version.get('number', 1)}.mp4")


@router.post("/me/review/{room_id}/comment")
async def review_comment_v24(room_id: str, payload: dict = Body(...), user: dict = Depends(require_user_write)) -> dict:
    _require_resource(user, "v22_room", room_id, "review")
    state = v22._read_room(room_id)
    version_id = str(payload.get("versionId") or state.get("activeVersionId") or "")
    v22._version_path(state, version_id)
    text = str(payload.get("text") or "").strip()[:2000]
    if not text:
        raise HTTPException(status_code=400, detail="اكتب التعليق أولًا.")
    try:
        at = max(0.0, min(24 * 3600.0, float(payload.get("time", 0))))
    except Exception:
        at = 0.0
    comment = {"id": uuid.uuid4().hex[:14], "versionId": version_id, "time": at, "text": text, "status": "open",
               "authorName": user.get("name"), "authorRole": user.get("role"), "memberId": user.get("id"),
               "enterprise": True, "createdAt": _now(), "resolvedAt": None}
    with v22._LOCK:
        state.setdefault("comments", []).append(comment); v22._refresh_status(state); v22._write_room(room_id, state)
    _audit(user, "review_comment", {"roomId": room_id, "commentId": comment["id"], "time": at})
    return {"comment": comment, "approval": v22._approval_state(state)}


@router.post("/me/review/{room_id}/decision")
async def review_decision_v24(room_id: str, payload: dict = Body(...), user: dict = Depends(require_user_write)) -> dict:
    _require_resource(user, "v22_room", room_id, "review")
    if user.get("role") not in {"admin", "producer", "reviewer"}:
        raise HTTPException(status_code=403, detail="دور المستخدم لا يسمح باتخاذ قرار اعتماد.")
    decision = str(payload.get("decision") or "")
    if decision not in {"approved", "changes_requested"}:
        raise HTTPException(status_code=400, detail="قرار المراجعة غير صالح.")
    state = v22._read_room(room_id)
    version_id = str(payload.get("versionId") or state.get("activeVersionId") or "")
    v22._version_path(state, version_id)
    item = {"id": uuid.uuid4().hex[:14], "versionId": version_id, "memberId": user.get("id"), "memberName": user.get("name"),
            "decision": decision, "note": str(payload.get("note") or "")[:2000], "enterprise": True, "createdAt": _now()}
    with v22._LOCK:
        state["decisions"] = [d for d in state.get("decisions", []) if not (d.get("versionId") == version_id and d.get("memberId") == user.get("id"))]
        state.setdefault("decisions", []).append(item); approval = v22._refresh_status(state); v22._write_room(room_id, state)
    _audit(user, "review_decision", {"roomId": room_id, "decision": decision})
    return {"decision": item, "approval": approval}


@router.get("/admin/overview")
async def admin_overview_v24(admin: dict = Depends(require_admin)) -> dict:
    store.migrate_v23_if_empty(_now())
    users = store.fetchall("SELECT * FROM v24_users ORDER BY created_at DESC")
    teams = store.fetchall("SELECT * FROM v24_teams ORDER BY created_at DESC")
    for team in teams:
        team["memberIds"] = [row["user_id"] for row in store.fetchall("SELECT user_id FROM v24_team_members WHERE team_id=?", (team["id"],))]
    acl = store.fetchall("SELECT * FROM v24_acl ORDER BY created_at DESC")
    audit = store.fetchall("SELECT * FROM v24_audit ORDER BY created_at DESC LIMIT 300")
    sessions = store.fetchall("SELECT * FROM v24_sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 500")
    return {
        "admin": _public_user(admin) if not admin.get("legacy") else admin,
        "dbMode": store.mode(), "databaseUrlConfigured": store.configured_postgres(),
        "users": [_public_user(item, internal=True) for item in users], "teams": teams,
        "acl": [{"id": r.get("id"), "resourceType": r.get("resource_type"), "resourceId": r.get("resource_id"),
                 "principalType": r.get("principal_type"), "principalId": r.get("principal_id"), "permission": r.get("permission"),
                 "ownerUserId": r.get("owner_user_id"), "createdAt": r.get("created_at")} for r in acl],
        "resources": _resource_catalog(),
        "audit": [{"id": r.get("id"), "actorId": r.get("actor_id"), "actorName": r.get("actor_name"), "actorRole": r.get("actor_role"),
                   "action": r.get("action"), "details": _safe_json(r.get("details_json")), "createdAt": r.get("created_at")} for r in audit],
        "sessions": {"active": len(sessions), "mfaUsers": sum(1 for u in users if bool(u.get("mfa_enabled"))), "totalUsers": len(users)},
        "email": {"configured": bool(SMTP_HOST and SMTP_FROM)}, "oidc": {"configured": _oidc_ready(), "issuer": OIDC_ISSUER or None, "autoProvision": OIDC_AUTO_PROVISION},
        "roles": sorted(ROLES), "permissions": list(PERMISSIONS.keys()),
    }


@router.post("/admin/invites")
async def create_invite_v24(request: Request, payload: dict = Body(...), admin: dict = Depends(require_admin_write)) -> dict:
    name = str(payload.get("name") or "").strip()[:100]
    email = str(payload.get("email") or "").strip().lower()[:180]
    role = str(payload.get("role") or "viewer")
    if not name or "@" not in email or role not in ROLES:
        raise HTTPException(status_code=400, detail="بيانات الدعوة غير صالحة.")
    token = secrets.token_urlsafe(40)
    store.execute("UPDATE v24_invites SET revoked_at=? WHERE lower(email)=lower(?) AND used_at IS NULL AND revoked_at IS NULL", (_now(), email))
    invite_id = uuid.uuid4().hex[:16]
    expires = _now_ts() + INVITE_TTL
    store.execute("INSERT INTO v24_invites(id,name,email,role,token_hash,token_last4,created_at,expires_at,used_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)",
                  (invite_id, name, email, role, _token_hash(token), token[-4:], _now(), expires))
    link = f"{_base_url(request)}/#invite24={token}"
    sent = False; email_error = None
    if bool(payload.get("sendEmail")):
        sent, email_error = _send_email(email, "MAGHRABI Video Studio - Team Invitation", f"مرحبًا {name}\n\nتمت دعوتك للانضمام إلى MAGHRABI Video Studio بدور {role}.\n\n{link}")
    _audit(admin, "invite_created", {"email": email, "role": role, "emailSent": sent, "emailError": email_error})
    return {"invite": {"id": invite_id, "name": name, "email": email, "role": role, "expiresAt": expires, "tokenLast4": token[-4:]},
            "token": token, "shareFragment": f"#invite24={token}", "emailSent": sent, "emailError": email_error}


@router.get("/invite/{token}/info")
async def invite_info_v24(token: str) -> dict:
    row = store.fetchone("SELECT * FROM v24_invites WHERE token_hash=?", (_token_hash(token),))
    if not row or row.get("used_at") or row.get("revoked_at") or int(row.get("expires_at") or 0) < _now_ts():
        raise HTTPException(status_code=404, detail="الدعوة غير صالحة أو منتهية.")
    return {"name": row.get("name"), "email": row.get("email"), "role": row.get("role"), "expiresAt": row.get("expires_at")}


@router.post("/invite/{token}/accept")
async def invite_accept_v24(token: str, payload: dict = Body(...)) -> dict:
    row = store.fetchone("SELECT * FROM v24_invites WHERE token_hash=?", (_token_hash(token),))
    if not row or row.get("used_at") or row.get("revoked_at") or int(row.get("expires_at") or 0) < _now_ts():
        raise HTTPException(status_code=404, detail="الدعوة غير صالحة أو منتهية.")
    if store.fetchone("SELECT id FROM v24_users WHERE lower(email)=lower(?) AND status='active'", (row["email"],)):
        raise HTTPException(status_code=409, detail="هذا الحساب مفعّل مسبقًا.")
    salt, digest = _hash_password(str(payload.get("password") or ""))
    existing = store.fetchone("SELECT * FROM v24_users WHERE lower(email)=lower(?)", (row["email"],))
    if existing:
        user_id = existing["id"]
        store.execute("UPDATE v24_users SET name=?,role=?,status='active',active=1,password_salt=?,password_hash=?,auth_version=auth_version+1 WHERE id=?",
                      (row["name"], row["role"], salt, digest, user_id))
    else:
        user_id = uuid.uuid4().hex[:14]
        store.execute("INSERT INTO v24_users(id,name,email,role,status,active,password_salt,password_hash,auth_version,mfa_secret,mfa_enabled,created_at,last_login_at) VALUES(?,?,?,?,?,?,?,?,1,NULL,0,?,NULL)",
                      (user_id, row["name"], row["email"], row["role"], "active", 1, salt, digest, _now()))
    store.execute("UPDATE v24_invites SET used_at=? WHERE id=?", (_now(), row["id"]))
    user = store.fetchone("SELECT * FROM v24_users WHERE id=?", (user_id,)) or {}
    _audit(user, "invite_accepted")
    return {"ok": True, "user": _public_user(user)}


@router.post("/admin/users/{user_id}/active")
async def user_active_v24(user_id: str, active: bool = Form(...), admin: dict = Depends(require_admin_write)) -> dict:
    user = store.fetchone("SELECT * FROM v24_users WHERE id=?", (user_id,))
    if not user: raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
    store.execute("UPDATE v24_users SET active=?, auth_version=auth_version+1 WHERE id=?", (1 if active else 0, user_id))
    if not active:
        store.execute("UPDATE v24_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (_now(), user_id))
    _audit(admin, "user_status_changed", {"userId": user_id, "active": bool(active)})
    return _public_user(store.fetchone("SELECT * FROM v24_users WHERE id=?", (user_id,)), internal=True) or {}


@router.post("/admin/users/{user_id}/role")
async def user_role_v24(user_id: str, role: str = Form(...), admin: dict = Depends(require_admin_write)) -> dict:
    if role not in ROLES: raise HTTPException(status_code=400, detail="الدور غير مدعوم.")
    if not store.fetchone("SELECT id FROM v24_users WHERE id=?", (user_id,)): raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
    store.execute("UPDATE v24_users SET role=?, auth_version=auth_version+1 WHERE id=?", (role, user_id))
    store.execute("UPDATE v24_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (_now(), user_id))
    _audit(admin, "user_role_changed", {"userId": user_id, "role": role})
    return _public_user(store.fetchone("SELECT * FROM v24_users WHERE id=?", (user_id,)), internal=True) or {}


@router.post("/admin/users/{user_id}/reset-link")
async def admin_reset_link_v24(user_id: str, request: Request, payload: dict = Body(default={}), admin: dict = Depends(require_admin_write)) -> dict:
    user = store.fetchone("SELECT * FROM v24_users WHERE id=?", (user_id,))
    if not user: raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
    token = secrets.token_urlsafe(40)
    store.execute("UPDATE v24_password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL", (_now(), user_id))
    expires = _now_ts() + RESET_TTL
    store.execute("INSERT INTO v24_password_resets(id,user_id,email,token_hash,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?,NULL)",
                  (uuid.uuid4().hex[:16], user_id, user["email"], _token_hash(token), _now(), expires))
    link = f"{_base_url(request)}/#reset={token}"
    sent = False; error = None
    if bool(payload.get("sendEmail")):
        sent, error = _send_email(user["email"], "MAGHRABI Video Studio - Password Reset", f"استخدم الرابط التالي:\n\n{link}")
    _audit(admin, "admin_password_reset_created", {"userId": user_id, "emailSent": sent})
    return {"token": token, "shareFragment": f"#reset={token}", "expiresAt": expires, "emailSent": sent, "emailError": error}


@router.post("/admin/users/{user_id}/sessions/revoke")
async def admin_revoke_sessions_v24(user_id: str, admin: dict = Depends(require_admin_write)) -> dict:
    store.execute("UPDATE v24_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (_now(), user_id))
    _audit(admin, "admin_sessions_revoked", {"userId": user_id})
    return {"ok": True}


@router.post("/admin/teams")
async def create_team_v24(payload: dict = Body(...), admin: dict = Depends(require_admin_write)) -> dict:
    name = str(payload.get("name") or "").strip()[:100]
    if not name: raise HTTPException(status_code=400, detail="اسم الفريق مطلوب.")
    team_id = uuid.uuid4().hex[:12]; now = _now()
    store.execute("INSERT INTO v24_teams(id,name,created_at,updated_at) VALUES(?,?,?,?)", (team_id, name, now, now))
    for user_id in list(dict.fromkeys(str(x) for x in payload.get("memberIds", [])))[:100]:
        if store.fetchone("SELECT id FROM v24_users WHERE id=?", (user_id,)):
            try: store.execute("INSERT INTO v24_team_members(team_id,user_id) VALUES(?,?)", (team_id, user_id))
            except Exception: pass
    _audit(admin, "team_created", {"teamId": team_id, "name": name})
    return {"id": team_id, "name": name}


@router.put("/admin/teams/{team_id}")
async def update_team_v24(team_id: str, payload: dict = Body(...), admin: dict = Depends(require_admin_write)) -> dict:
    team = store.fetchone("SELECT * FROM v24_teams WHERE id=?", (team_id,))
    if not team: raise HTTPException(status_code=404, detail="الفريق غير موجود.")
    if payload.get("name") is not None:
        store.execute("UPDATE v24_teams SET name=?,updated_at=? WHERE id=?", (str(payload.get("name") or team["name"])[:100], _now(), team_id))
    if payload.get("memberIds") is not None:
        store.execute("DELETE FROM v24_team_members WHERE team_id=?", (team_id,))
        for user_id in list(dict.fromkeys(str(x) for x in payload.get("memberIds", [])))[:100]:
            if store.fetchone("SELECT id FROM v24_users WHERE id=?", (user_id,)):
                try: store.execute("INSERT INTO v24_team_members(team_id,user_id) VALUES(?,?)", (team_id, user_id))
                except Exception: pass
    _audit(admin, "team_updated", {"teamId": team_id})
    return {"ok": True}


@router.delete("/admin/teams/{team_id}")
async def delete_team_v24(team_id: str, admin: dict = Depends(require_admin_write)) -> dict:
    if not store.fetchone("SELECT id FROM v24_teams WHERE id=?", (team_id,)): raise HTTPException(status_code=404, detail="الفريق غير موجود.")
    store.execute("DELETE FROM v24_team_members WHERE team_id=?", (team_id,)); store.execute("DELETE FROM v24_acl WHERE principal_type='team' AND principal_id=?", (team_id,)); store.execute("DELETE FROM v24_teams WHERE id=?", (team_id,))
    _audit(admin, "team_deleted", {"teamId": team_id})
    return {"ok": True}


@router.post("/admin/acl")
async def add_acl_v24(payload: dict = Body(...), admin: dict = Depends(require_admin_write)) -> dict:
    rt = str(payload.get("resourceType") or ""); rid = str(payload.get("resourceId") or ""); pt = str(payload.get("principalType") or "user"); pid = str(payload.get("principalId") or ""); permission = str(payload.get("permission") or "view")
    if rt not in RESOURCE_TYPES or pt not in {"user", "team"} or permission not in PERMISSIONS:
        raise HTTPException(status_code=400, detail="ACL غير صالح.")
    if not any(item.get("type") == rt and item.get("id") == rid for item in _resource_catalog()): raise HTTPException(status_code=404, detail="المورد غير موجود.")
    if pt == "user" and not store.fetchone("SELECT id FROM v24_users WHERE id=?", (pid,)): raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
    if pt == "team" and not store.fetchone("SELECT id FROM v24_teams WHERE id=?", (pid,)): raise HTTPException(status_code=404, detail="الفريق غير موجود.")
    store.execute("DELETE FROM v24_acl WHERE resource_type=? AND resource_id=? AND principal_type=? AND principal_id=?", (rt, rid, pt, pid))
    entry_id = uuid.uuid4().hex[:14]
    store.execute("INSERT INTO v24_acl(id,resource_type,resource_id,principal_type,principal_id,permission,owner_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
                  (entry_id, rt, rid, pt, pid, permission, payload.get("ownerUserId"), _now()))
    _audit(admin, "acl_granted", {"resourceType": rt, "resourceId": rid, "principalType": pt, "principalId": pid, "permission": permission})
    return {"id": entry_id, "resourceType": rt, "resourceId": rid, "principalType": pt, "principalId": pid, "permission": permission}


@router.delete("/admin/acl/{acl_id}")
async def delete_acl_v24(acl_id: str, admin: dict = Depends(require_admin_write)) -> dict:
    if not store.fetchone("SELECT id FROM v24_acl WHERE id=?", (acl_id,)): raise HTTPException(status_code=404, detail="ACL غير موجود.")
    store.execute("DELETE FROM v24_acl WHERE id=?", (acl_id,)); _audit(admin, "acl_revoked", {"aclId": acl_id})
    return {"ok": True}


@router.get("/oidc/info")
async def oidc_info_v24() -> dict:
    return {"configured": _oidc_ready(), "issuer": OIDC_ISSUER or None, "autoProvision": OIDC_AUTO_PROVISION}


@router.get("/oidc/start")
async def oidc_start_v24() -> RedirectResponse:
    discovery = _oidc_discovery(); state = _signed_state("#secure")
    query = urllib.parse.urlencode({"response_type": "code", "client_id": OIDC_CLIENT_ID, "redirect_uri": OIDC_REDIRECT_URI, "scope": OIDC_SCOPES, "state": state})
    return RedirectResponse(f"{discovery['authorization_endpoint']}?{query}")


@router.get("/oidc/callback")
async def oidc_callback_v24(request: Request, code: str = Query(...), state: str = Query(...)):
    state_data = _verify_state(state); discovery = _oidc_discovery()
    form = {"grant_type": "authorization_code", "code": code, "redirect_uri": OIDC_REDIRECT_URI, "client_id": OIDC_CLIENT_ID}
    if OIDC_CLIENT_SECRET: form["client_secret"] = OIDC_CLIENT_SECRET
    try:
        req = urllib.request.Request(discovery["token_endpoint"], data=urllib.parse.urlencode(form).encode("utf-8"), headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=12) as response: tokens = json.loads(response.read().decode("utf-8"))
        access = tokens.get("access_token")
        user_req = urllib.request.Request(discovery["userinfo_endpoint"], headers={"Authorization": f"Bearer {access}"})
        with urllib.request.urlopen(user_req, timeout=12) as response: claims = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"فشل OIDC exchange: {str(exc)[:300]}") from exc
    user = _upsert_oidc_user(claims)
    redirect = RedirectResponse(url=f"{_base_url(request)}/{state_data.get('return', '#secure')}")
    session = _issue_session(redirect, request, user); _audit(user, "oidc_login", {"sessionId": session["id"], "issuer": OIDC_ISSUER})
    return redirect
