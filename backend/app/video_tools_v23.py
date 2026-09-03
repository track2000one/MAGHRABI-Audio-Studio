from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, Form, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse

from . import video_tools_v21 as v21
from . import video_tools_v22 as v22
from .main import AUTH_SECRET, SESSION_TTL_SECONDS, current_user

router = APIRouter(prefix="/api/video/v23", tags=["video-studio-v23"])

DATA_DIR = v21.DATA_DIR
IDENTITY_DIR = DATA_DIR / "video_identity"
USERS_PATH = IDENTITY_DIR / "users.json"
TEAMS_PATH = IDENTITY_DIR / "teams.json"
ACL_PATH = IDENTITY_DIR / "acl.json"
INVITES_PATH = IDENTITY_DIR / "invites.json"
AUDIT_PATH = IDENTITY_DIR / "audit.json"
IDENTITY_DIR.mkdir(parents=True, exist_ok=True)

SESSION_COOKIE = "maghrabi_enterprise_session"
SESSION_TTL = int(os.getenv("ENTERPRISE_SESSION_TTL_SECONDS", str(12 * 60 * 60)))
INVITE_TTL = int(os.getenv("ENTERPRISE_INVITE_TTL_SECONDS", str(7 * 24 * 60 * 60)))
PBKDF2_ITERATIONS = max(120_000, int(os.getenv("ENTERPRISE_PBKDF2_ITERATIONS", "310000")))
ROLES = {"admin", "producer", "editor", "reviewer", "viewer"}
PERMISSIONS = {"view": 10, "review": 20, "edit": 30, "manage": 40}
RESOURCE_TYPES = {"v21_project", "v22_room"}
_LOCK = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def _users() -> list[dict]:
    value = _read(USERS_PATH, [])
    return value if isinstance(value, list) else []


def _teams() -> list[dict]:
    value = _read(TEAMS_PATH, [])
    return value if isinstance(value, list) else []


def _acl() -> list[dict]:
    value = _read(ACL_PATH, [])
    return value if isinstance(value, list) else []


def _invites() -> list[dict]:
    value = _read(INVITES_PATH, [])
    return value if isinstance(value, list) else []


def _audit_items() -> list[dict]:
    value = _read(AUDIT_PATH, [])
    return value if isinstance(value, list) else []


def _audit(actor: dict, action: str, details: dict | None = None) -> None:
    with _LOCK:
        items = _audit_items()
        items.append({
            "id": uuid.uuid4().hex[:16],
            "actorId": actor.get("id"),
            "actorName": actor.get("name"),
            "actorRole": actor.get("role"),
            "action": action,
            "details": details or {},
            "createdAt": _now(),
        })
        _write(AUDIT_PATH, items[-2000:])


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _secret() -> bytes:
    if not AUTH_SECRET or len(AUTH_SECRET) < 32:
        raise HTTPException(status_code=503, detail="AUTH_SECRET يجب أن يكون مهيأ بطول 32 حرفًا على الأقل لتشغيل Enterprise Identity.")
    return AUTH_SECRET.encode("utf-8")


def _hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    if len(password) < 10:
        raise HTTPException(status_code=400, detail="كلمة المرور يجب ألا تقل عن 10 أحرف.")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return _b64(salt), _b64(digest)


def _verify_password(password: str, salt_text: str, digest_text: str) -> bool:
    try:
        salt = _unb64(salt_text)
        _salt, candidate = _hash_password(password, salt)
        return hmac.compare_digest(candidate, digest_text)
    except Exception:
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _session_token(user: dict) -> str:
    exp = int(time.time()) + SESSION_TTL
    payload = f"{user['id']}|{int(user.get('authVersion', 1))}|{exp}".encode("utf-8")
    encoded = _b64(payload)
    signature = hmac.new(_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{_b64(signature)}"


def _session_user(request: Request) -> dict | None:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw or "." not in raw:
        return None
    try:
        encoded, supplied = raw.split(".", 1)
        expected = hmac.new(_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(supplied)):
            return None
        user_id, version_text, exp_text = _unb64(encoded).decode("utf-8").split("|", 2)
        if int(exp_text) < int(time.time()):
            return None
        user = next((item for item in _users() if item.get("id") == user_id), None)
        if not user or not user.get("active") or user.get("status") != "active":
            return None
        if int(user.get("authVersion", 1)) != int(version_text):
            return None
        return user
    except Exception:
        return None


def _public_user(user: dict, *, internal: bool = False) -> dict:
    result = {
        "id": user.get("id"),
        "name": user.get("name"),
        "email": user.get("email"),
        "role": user.get("role"),
        "status": user.get("status"),
        "active": bool(user.get("active")),
        "createdAt": user.get("createdAt"),
        "lastLoginAt": user.get("lastLoginAt"),
    }
    if internal:
        result["authVersion"] = user.get("authVersion", 1)
    return result


def _legacy_actor(request: Request) -> dict | None:
    username = current_user(request)
    if not username:
        return None
    return {"id": "legacy-admin", "name": username, "email": None, "role": "admin", "status": "active", "active": True, "legacy": True}


def require_enterprise_user(request: Request) -> dict:
    user = _session_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="يلزم تسجيل الدخول بحساب الفريق.")
    return user


def require_admin(request: Request) -> dict:
    user = _session_user(request)
    if user and user.get("role") == "admin":
        return user
    legacy = _legacy_actor(request)
    if legacy:
        return legacy
    raise HTTPException(status_code=403, detail="تتطلب هذه العملية صلاحية Admin.")


def _user_by_id(user_id: str) -> dict | None:
    return next((item for item in _users() if item.get("id") == user_id), None)


def _team_ids_for_user(user_id: str) -> set[str]:
    return {str(team.get("id")) for team in _teams() if user_id in (team.get("memberIds") or [])}


def _permission_for(user: dict, resource_type: str, resource_id: str) -> str | None:
    if user.get("role") == "admin":
        return "manage"
    levels: list[str] = []
    team_ids = _team_ids_for_user(str(user.get("id")))
    for entry in _acl():
        if entry.get("resourceType") != resource_type or entry.get("resourceId") != resource_id:
            continue
        if entry.get("principalType") == "user" and entry.get("principalId") == user.get("id"):
            levels.append(str(entry.get("permission")))
        if entry.get("principalType") == "team" and entry.get("principalId") in team_ids:
            levels.append(str(entry.get("permission")))
    owners = [entry for entry in _acl() if entry.get("resourceType") == resource_type and entry.get("resourceId") == resource_id and entry.get("ownerUserId")]
    if any(entry.get("ownerUserId") == user.get("id") for entry in owners):
        levels.append("manage")
    valid = [value for value in levels if value in PERMISSIONS]
    return max(valid, key=lambda value: PERMISSIONS[value]) if valid else None


def _require_resource(user: dict, resource_type: str, resource_id: str, minimum: str = "view") -> str:
    permission = _permission_for(user, resource_type, resource_id)
    if not permission or PERMISSIONS[permission] < PERMISSIONS[minimum]:
        raise HTTPException(status_code=403, detail="لا تملك صلاحية كافية على هذا المورد.")
    return permission


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


def _public_acl(entry: dict) -> dict:
    return {key: entry.get(key) for key in ("id", "resourceType", "resourceId", "principalType", "principalId", "permission", "ownerUserId", "createdAt")}


@router.get("/auth/status")
async def status_v23(request: Request) -> dict:
    user = _session_user(request)
    legacy = _legacy_actor(request)
    return {"authenticated": bool(user), "user": _public_user(user) if user else None, "legacyAdmin": bool(legacy), "roles": sorted(ROLES)}


@router.post("/auth/login")
async def login_v23(response: Response, payload: dict = Body(...)) -> dict:
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    with _LOCK:
        users = _users()
        user = next((item for item in users if str(item.get("email", "")).lower() == email), None)
        if not user or not user.get("active") or user.get("status") != "active" or not _verify_password(password, str(user.get("passwordSalt", "")), str(user.get("passwordHash", ""))):
            raise HTTPException(status_code=401, detail="البريد الإلكتروني أو كلمة المرور غير صحيحة.")
        user["lastLoginAt"] = _now()
        _write(USERS_PATH, users)
    token = _session_token(user)
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL, httponly=True, secure=True, samesite="lax", path="/")
    _audit(user, "user_login")
    return {"authenticated": True, "user": _public_user(user)}


@router.post("/auth/logout")
async def logout_v23(request: Request, response: Response) -> dict:
    user = _session_user(request)
    if user:
        _audit(user, "user_logout")
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
    return {"authenticated": False}


@router.get("/invite/{token}/info")
async def invite_info_v23(token: str) -> dict:
    digest = _token_hash(token)
    invite = next((item for item in _invites() if item.get("tokenHash") == digest), None)
    if not invite or invite.get("usedAt") or invite.get("revokedAt") or int(invite.get("expiresAt", 0)) < int(time.time()):
        raise HTTPException(status_code=404, detail="الدعوة غير صالحة أو انتهت صلاحيتها.")
    return {"name": invite.get("name"), "email": invite.get("email"), "role": invite.get("role"), "expiresAt": invite.get("expiresAt")}


@router.post("/invite/{token}/accept")
async def accept_invite_v23(token: str, payload: dict = Body(...)) -> dict:
    digest = _token_hash(token)
    password = str(payload.get("password") or "")
    salt, hashed = _hash_password(password)
    with _LOCK:
        invites = _invites()
        invite = next((item for item in invites if item.get("tokenHash") == digest), None)
        if not invite or invite.get("usedAt") or invite.get("revokedAt") or int(invite.get("expiresAt", 0)) < int(time.time()):
            raise HTTPException(status_code=404, detail="الدعوة غير صالحة أو انتهت صلاحيتها.")
        users = _users()
        existing = next((item for item in users if str(item.get("email", "")).lower() == str(invite.get("email", "")).lower()), None)
        if existing and existing.get("status") == "active":
            raise HTTPException(status_code=409, detail="تم تفعيل هذا الحساب مسبقًا.")
        user = existing or {
            "id": uuid.uuid4().hex[:14],
            "createdAt": _now(),
            "authVersion": 1,
        }
        user.update(name=invite.get("name"), email=str(invite.get("email", "")).lower(), role=invite.get("role"), status="active", active=True, passwordSalt=salt, passwordHash=hashed)
        if existing is None:
            users.append(user)
        invite["usedAt"] = _now()
        invite["userId"] = user["id"]
        _write(USERS_PATH, users)
        _write(INVITES_PATH, invites)
    _audit(user, "invite_accepted")
    return {"ok": True, "user": _public_user(user)}


@router.get("/admin/overview")
async def overview_v23(admin: dict = Depends(require_admin)) -> dict:
    resources = _resource_catalog()
    return {
        "users": [_public_user(item, internal=True) for item in _users()],
        "teams": _teams(),
        "acl": [_public_acl(item) for item in _acl()],
        "resources": resources,
        "audit": list(reversed(_audit_items()))[:300],
        "roles": sorted(ROLES),
        "permissions": list(PERMISSIONS.keys()),
        "admin": _public_user(admin) if not admin.get("legacy") else admin,
    }


@router.post("/admin/invites")
async def create_invite_v23(payload: dict = Body(...), admin: dict = Depends(require_admin)) -> dict:
    name = str(payload.get("name") or "").strip()[:100]
    email = str(payload.get("email") or "").strip().lower()[:180]
    role = str(payload.get("role") or "viewer")
    if not name or "@" not in email:
        raise HTTPException(status_code=400, detail="الاسم والبريد الإلكتروني مطلوبان.")
    if role not in ROLES:
        raise HTTPException(status_code=400, detail="الدور غير مدعوم.")
    token = secrets.token_urlsafe(36)
    invite = {
        "id": uuid.uuid4().hex[:14], "name": name, "email": email, "role": role,
        "tokenHash": _token_hash(token), "tokenLast4": token[-4:], "createdAt": _now(),
        "expiresAt": int(time.time()) + INVITE_TTL, "usedAt": None, "revokedAt": None,
    }
    with _LOCK:
        items = _invites()
        for item in items:
            if str(item.get("email", "")).lower() == email and not item.get("usedAt"):
                item["revokedAt"] = _now()
        items.append(invite)
        _write(INVITES_PATH, items[-500:])
    _audit(admin, "invite_created", {"email": email, "role": role})
    return {"invite": {k: invite.get(k) for k in ("id", "name", "email", "role", "createdAt", "expiresAt", "tokenLast4")}, "token": token, "shareFragment": f"#invite={token}"}


@router.post("/admin/users/{user_id}/role")
async def user_role_v23(user_id: str, role: str = Form(...), admin: dict = Depends(require_admin)) -> dict:
    if role not in ROLES:
        raise HTTPException(status_code=400, detail="الدور غير مدعوم.")
    with _LOCK:
        users = _users(); user = next((item for item in users if item.get("id") == user_id), None)
        if not user: raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
        user["role"] = role; user["authVersion"] = int(user.get("authVersion", 1)) + 1
        _write(USERS_PATH, users)
    _audit(admin, "user_role_changed", {"userId": user_id, "role": role})
    return _public_user(user, internal=True)


@router.post("/admin/users/{user_id}/active")
async def user_active_v23(user_id: str, active: bool = Form(...), admin: dict = Depends(require_admin)) -> dict:
    with _LOCK:
        users = _users(); user = next((item for item in users if item.get("id") == user_id), None)
        if not user: raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
        user["active"] = bool(active); user["authVersion"] = int(user.get("authVersion", 1)) + 1
        _write(USERS_PATH, users)
    _audit(admin, "user_status_changed", {"userId": user_id, "active": bool(active)})
    return _public_user(user, internal=True)


@router.post("/admin/teams")
async def create_team_v23(payload: dict = Body(...), admin: dict = Depends(require_admin)) -> dict:
    name = str(payload.get("name") or "").strip()[:100]
    if not name: raise HTTPException(status_code=400, detail="اسم الفريق مطلوب.")
    member_ids = [str(value) for value in payload.get("memberIds", []) if _user_by_id(str(value))]
    team = {"id": uuid.uuid4().hex[:12], "name": name, "memberIds": list(dict.fromkeys(member_ids))[:100], "createdAt": _now(), "updatedAt": _now()}
    with _LOCK:
        items = _teams(); items.append(team); _write(TEAMS_PATH, items[-100:])
    _audit(admin, "team_created", {"teamId": team["id"], "name": name})
    return team


@router.put("/admin/teams/{team_id}")
async def update_team_v23(team_id: str, payload: dict = Body(...), admin: dict = Depends(require_admin)) -> dict:
    with _LOCK:
        items = _teams(); team = next((item for item in items if item.get("id") == team_id), None)
        if not team: raise HTTPException(status_code=404, detail="الفريق غير موجود.")
        if payload.get("name") is not None: team["name"] = str(payload.get("name") or "").strip()[:100] or team["name"]
        if payload.get("memberIds") is not None: team["memberIds"] = list(dict.fromkeys(str(value) for value in payload.get("memberIds", []) if _user_by_id(str(value))))[:100]
        team["updatedAt"] = _now(); _write(TEAMS_PATH, items)
    _audit(admin, "team_updated", {"teamId": team_id})
    return team


@router.delete("/admin/teams/{team_id}")
async def delete_team_v23(team_id: str, admin: dict = Depends(require_admin)) -> dict:
    with _LOCK:
        teams = _teams(); next_teams = [item for item in teams if item.get("id") != team_id]
        if len(next_teams) == len(teams): raise HTTPException(status_code=404, detail="الفريق غير موجود.")
        acl = [item for item in _acl() if not (item.get("principalType") == "team" and item.get("principalId") == team_id)]
        _write(TEAMS_PATH, next_teams); _write(ACL_PATH, acl)
    _audit(admin, "team_deleted", {"teamId": team_id})
    return {"ok": True}


@router.post("/admin/acl")
async def add_acl_v23(payload: dict = Body(...), admin: dict = Depends(require_admin)) -> dict:
    resource_type = str(payload.get("resourceType") or ""); resource_id = str(payload.get("resourceId") or "")
    principal_type = str(payload.get("principalType") or "user"); principal_id = str(payload.get("principalId") or "")
    permission = str(payload.get("permission") or "view")
    if resource_type not in RESOURCE_TYPES or permission not in PERMISSIONS or principal_type not in {"user", "team"}:
        raise HTTPException(status_code=400, detail="ACL غير صالح.")
    if not any(item.get("type") == resource_type and item.get("id") == resource_id for item in _resource_catalog()):
        raise HTTPException(status_code=404, detail="المورد غير موجود.")
    if principal_type == "user" and not _user_by_id(principal_id): raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
    if principal_type == "team" and not any(item.get("id") == principal_id for item in _teams()): raise HTTPException(status_code=404, detail="الفريق غير موجود.")
    with _LOCK:
        items = [item for item in _acl() if not (item.get("resourceType") == resource_type and item.get("resourceId") == resource_id and item.get("principalType") == principal_type and item.get("principalId") == principal_id and not item.get("ownerUserId"))]
        entry = {"id": uuid.uuid4().hex[:12], "resourceType": resource_type, "resourceId": resource_id, "principalType": principal_type, "principalId": principal_id, "permission": permission, "ownerUserId": None, "createdAt": _now()}
        items.append(entry); _write(ACL_PATH, items[-2000:])
    _audit(admin, "acl_granted", _public_acl(entry))
    return _public_acl(entry)


@router.post("/admin/ownership")
async def ownership_v23(payload: dict = Body(...), admin: dict = Depends(require_admin)) -> dict:
    resource_type = str(payload.get("resourceType") or ""); resource_id = str(payload.get("resourceId") or ""); owner_id = str(payload.get("ownerUserId") or "")
    if resource_type not in RESOURCE_TYPES or not _user_by_id(owner_id): raise HTTPException(status_code=400, detail="بيانات Ownership غير صالحة.")
    with _LOCK:
        items = [item for item in _acl() if not (item.get("resourceType") == resource_type and item.get("resourceId") == resource_id and item.get("ownerUserId"))]
        entry = {"id": uuid.uuid4().hex[:12], "resourceType": resource_type, "resourceId": resource_id, "principalType": "user", "principalId": owner_id, "permission": "manage", "ownerUserId": owner_id, "createdAt": _now()}
        items.append(entry); _write(ACL_PATH, items[-2000:])
    _audit(admin, "ownership_changed", {"resourceType": resource_type, "resourceId": resource_id, "ownerUserId": owner_id})
    return _public_acl(entry)


@router.delete("/admin/acl/{entry_id}")
async def delete_acl_v23(entry_id: str, admin: dict = Depends(require_admin)) -> dict:
    with _LOCK:
        items = _acl(); next_items = [item for item in items if item.get("id") != entry_id]
        if len(next_items) == len(items): raise HTTPException(status_code=404, detail="ACL entry غير موجود.")
        _write(ACL_PATH, next_items)
    _audit(admin, "acl_revoked", {"entryId": entry_id})
    return {"ok": True}


@router.get("/workspace")
async def workspace_v23(user: dict = Depends(require_enterprise_user)) -> dict:
    resources = []
    for item in _resource_catalog():
        permission = _permission_for(user, str(item["type"]), str(item["id"]))
        if permission:
            resources.append({**item, "permission": permission})
    return {"user": _public_user(user), "resources": resources}


@router.get("/workspace/rooms/{room_id}")
async def workspace_room_v23(room_id: str, user: dict = Depends(require_enterprise_user)) -> dict:
    permission = _require_resource(user, "v22_room", room_id, "view")
    state = v22._read_room(room_id)
    result = v22._public_room(state, internal=False)
    result["permission"] = permission
    return result


@router.get("/workspace/rooms/{room_id}/versions/{version_id}/video")
async def workspace_video_v23(room_id: str, version_id: str, user: dict = Depends(require_enterprise_user)) -> FileResponse:
    _require_resource(user, "v22_room", room_id, "view")
    state = v22._read_room(room_id); version, path = v22._version_path(state, version_id)
    return FileResponse(path, media_type="video/mp4", filename=f"MAGHRABI-enterprise-v{version.get('number',1)}.mp4")


@router.post("/workspace/rooms/{room_id}/comments")
async def workspace_comment_v23(room_id: str, payload: dict = Body(...), user: dict = Depends(require_enterprise_user)) -> dict:
    _require_resource(user, "v22_room", room_id, "review")
    with v22._LOCK:
        state = v22._read_room(room_id)
        version_id = str(payload.get("versionId") or state.get("activeVersionId") or ""); v22._version_path(state, version_id)
        text = str(payload.get("text") or "").strip()[:2000]
        if not text: raise HTTPException(status_code=400, detail="اكتب نص التعليق.")
        try: at = max(0.0, min(24 * 3600.0, float(payload.get("time", 0))))
        except Exception: at = 0.0
        comment = {"id": uuid.uuid4().hex[:14], "versionId": version_id, "time": at, "text": text, "status": "open", "authorName": user.get("name"), "authorRole": user.get("role"), "memberId": f"v23:{user.get('id')}", "createdAt": _now(), "resolvedAt": None}
        state.setdefault("comments", []).append(comment); v22._refresh_status(state); v22._activity(state, "enterprise_comment_added", str(user.get("name")), {"commentId": comment["id"], "time": at}); v22._write_room(room_id, state)
    _audit(user, "room_comment_added", {"roomId": room_id, "commentId": comment["id"]})
    return comment


@router.post("/workspace/rooms/{room_id}/decision")
async def workspace_decision_v23(room_id: str, payload: dict = Body(...), user: dict = Depends(require_enterprise_user)) -> dict:
    _require_resource(user, "v22_room", room_id, "review")
    if user.get("role") not in {"admin", "producer", "reviewer"}:
        raise HTTPException(status_code=403, detail="دور المستخدم لا يسمح باتخاذ قرار اعتماد.")
    decision = str(payload.get("decision") or "")
    if decision not in v22.DECISIONS: raise HTTPException(status_code=400, detail="قرار غير صالح.")
    with v22._LOCK:
        state = v22._read_room(room_id); version_id = str(payload.get("versionId") or state.get("activeVersionId") or ""); v22._version_path(state, version_id)
        member_id = f"v23:{user.get('id')}"
        state["decisions"] = [item for item in state.get("decisions", []) if not (item.get("versionId") == version_id and item.get("memberId") == member_id)]
        item = {"id": uuid.uuid4().hex[:14], "versionId": version_id, "memberId": member_id, "memberName": user.get("name"), "decision": decision, "note": str(payload.get("note") or "")[:2000], "createdAt": _now(), "enterprise": True}
        state.setdefault("decisions", []).append(item)
        # Enterprise reviewer decisions are included in the room status for visibility; V22 external gate remains intact.
        v22._activity(state, "enterprise_review_decision", str(user.get("name")), {"decision": decision, "versionId": version_id}); v22._write_room(room_id, state)
    _audit(user, "room_decision", {"roomId": room_id, "decision": decision, "versionId": version_id})
    return item
