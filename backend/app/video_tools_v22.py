from __future__ import annotations

import hashlib
import json
import secrets
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .main import require_auth
from . import video_tools_v21 as v21

router = APIRouter(prefix="/api/video/v22", tags=["video-studio-v22"])

REVIEW_DIR = v21.DATA_DIR / "video_review"
ROOMS_DIR = REVIEW_DIR / "rooms"
ROOMS_DIR.mkdir(parents=True, exist_ok=True)
_LOCK = threading.RLock()
ROLES = {"viewer", "commenter", "reviewer"}
DECISIONS = {"approved", "changes_requested"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _room_dir(room_id: str) -> Path:
    return ROOMS_DIR / room_id


def _room_path(room_id: str) -> Path:
    return _room_dir(room_id) / "room.json"


def _read_room(room_id: str) -> dict:
    path = _room_path(room_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Review Room غير موجودة.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="تعذر قراءة Review Room.") from exc


def _write_room(room_id: str, state: dict) -> None:
    folder = _room_dir(room_id)
    folder.mkdir(parents=True, exist_ok=True)
    state["updatedAt"] = _now()
    temp = folder / "room.json.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(_room_path(room_id))


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _activity(state: dict, action: str, actor: str, details: dict | None = None) -> None:
    events = state.setdefault("activity", [])
    events.append({
        "id": uuid.uuid4().hex[:14],
        "action": action,
        "actor": actor[:120],
        "details": details or {},
        "createdAt": _now(),
    })
    if len(events) > 500:
        del events[:-500]


def _active_version(state: dict) -> dict:
    version_id = state.get("activeVersionId")
    version = next((item for item in state.get("versions", []) if item.get("id") == version_id), None)
    if version is None:
        raise HTTPException(status_code=409, detail="لا توجد Version فعالة للمراجعة.")
    return version


def _approval_state(state: dict) -> dict:
    versions = state.get("versions", [])
    active_id = state.get("activeVersionId")
    if not active_id or not versions:
        return {"status": "draft", "approvals": 0, "changesRequested": 0, "openComments": 0, "gatePassed": False}

    reviewer_ids = {item.get("id") for item in state.get("members", []) if item.get("active", True) and item.get("role") == "reviewer"}
    decisions = [item for item in state.get("decisions", []) if item.get("versionId") == active_id and item.get("memberId") in reviewer_ids]
    latest_by_member: dict[str, dict] = {}
    for item in decisions:
        latest_by_member[str(item.get("memberId"))] = item
    approvals = sum(1 for item in latest_by_member.values() if item.get("decision") == "approved")
    changes = sum(1 for item in latest_by_member.values() if item.get("decision") == "changes_requested")
    open_comments = sum(1 for item in state.get("comments", []) if item.get("versionId") == active_id and item.get("status") == "open")
    gate = state.get("approvalGate") or {}
    min_approvals = max(1, min(20, int(gate.get("minApprovals", 1))))
    block_open = bool(gate.get("blockOpenComments", False))
    gate_passed = approvals >= min_approvals and changes == 0 and (not block_open or open_comments == 0)

    if gate_passed:
        status = "approved"
    elif changes > 0:
        status = "changes_requested"
    elif state.get("reviewStartedAt"):
        status = "in_review"
    else:
        status = "draft"
    return {
        "status": status,
        "approvals": approvals,
        "changesRequested": changes,
        "openComments": open_comments,
        "minApprovals": min_approvals,
        "blockOpenComments": block_open,
        "gatePassed": gate_passed,
    }


def _refresh_status(state: dict) -> dict:
    approval = _approval_state(state)
    state["status"] = approval["status"]
    state["approval"] = approval
    if approval["gatePassed"]:
        state["approvedAt"] = state.get("approvedAt") or _now()
        state["approvedVersionId"] = state.get("activeVersionId")
    else:
        state["approvedAt"] = None
        state["approvedVersionId"] = None
    return approval


def _public_member(member: dict, *, internal: bool) -> dict:
    value = {
        "id": member.get("id"),
        "name": member.get("name"),
        "role": member.get("role"),
        "active": bool(member.get("active", True)),
        "createdAt": member.get("createdAt"),
    }
    if internal:
        value.update(email=member.get("email"), tokenLast4=member.get("tokenLast4"))
    return value


def _public_room(state: dict, *, internal: bool = True) -> dict:
    approval = _approval_state(state)
    result = {
        "id": state.get("id"),
        "name": state.get("name"),
        "status": approval["status"],
        "archived": bool(state.get("archived", False)),
        "v21ProjectId": state.get("v21ProjectId"),
        "v21ItemId": state.get("v21ItemId"),
        "createdAt": state.get("createdAt"),
        "updatedAt": state.get("updatedAt"),
        "reviewStartedAt": state.get("reviewStartedAt"),
        "approvedAt": state.get("approvedAt"),
        "activeVersionId": state.get("activeVersionId"),
        "approvedVersionId": state.get("approvedVersionId"),
        "approval": approval,
        "approvalGate": state.get("approvalGate"),
        "versions": [{k: item.get(k) for k in ("id", "number", "label", "sourceName", "createdAt", "notes", "fromChildJobId")} for item in state.get("versions", [])],
        "members": [_public_member(item, internal=internal) for item in state.get("members", []) if internal or item.get("active", True)],
        "comments": list(state.get("comments", [])),
        "decisions": list(state.get("decisions", [])),
    }
    if internal:
        result["activity"] = list(reversed(state.get("activity", [])))[:250]
    return result


def _copy_version_from_v21(state: dict, project_id: str, item_id: str, label: str | None = None, notes: str = "") -> dict:
    item, result_path = v21._item_path(project_id, item_id, "result")
    if not result_path.exists():
        raise HTTPException(status_code=409, detail="نتيجة V21 غير جاهزة لإضافتها كنسخة مراجعة.")
    version_number = len(state.get("versions", [])) + 1
    version_id = uuid.uuid4().hex[:12]
    versions_dir = _room_dir(state["id"]) / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    target = versions_dir / f"v{version_number:03d}-{version_id}.mp4"
    shutil.copy2(result_path, target)
    child_id = item.get("childJobId")
    version = {
        "id": version_id,
        "number": version_number,
        "label": (label or f"Version {version_number}")[:100],
        "sourceName": item.get("sourceName"),
        "file": str(target.relative_to(_room_dir(state["id"]))),
        "createdAt": _now(),
        "notes": notes[:1000],
        "fromChildJobId": child_id,
    }
    state.setdefault("versions", []).append(version)
    state["activeVersionId"] = version_id
    state["reviewStartedAt"] = None
    state["decisions"] = [item for item in state.get("decisions", []) if item.get("versionId") != version_id]
    _refresh_status(state)
    return version


async def _save_uploaded_version(state: dict, upload: UploadFile, label: str, notes: str) -> dict:
    version_number = len(state.get("versions", [])) + 1
    version_id = uuid.uuid4().hex[:12]
    versions_dir = _room_dir(state["id"]) / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    target = versions_dir / f"v{version_number:03d}-{version_id}.mp4"
    with target.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    await upload.close()
    version = {
        "id": version_id,
        "number": version_number,
        "label": (label or f"Version {version_number}")[:100],
        "sourceName": upload.filename or target.name,
        "file": str(target.relative_to(_room_dir(state["id"]))),
        "createdAt": _now(),
        "notes": notes[:1000],
        "fromChildJobId": None,
    }
    state.setdefault("versions", []).append(version)
    state["activeVersionId"] = version_id
    state["reviewStartedAt"] = None
    _refresh_status(state)
    return version


def _version_path(state: dict, version_id: str) -> tuple[dict, Path]:
    version = next((item for item in state.get("versions", []) if item.get("id") == version_id), None)
    if version is None:
        raise HTTPException(status_code=404, detail="Version غير موجودة.")
    path = _room_dir(state["id"]) / str(version["file"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="ملف Version غير موجود.")
    return version, path


def _member_from_token(state: dict, token: str | None) -> dict:
    if not token:
        raise HTTPException(status_code=401, detail="Review Token مطلوب.")
    digest = _hash_token(token)
    member = next((item for item in state.get("members", []) if item.get("active", True) and secrets.compare_digest(str(item.get("tokenHash", "")), digest)), None)
    if member is None:
        raise HTTPException(status_code=401, detail="Review Token غير صالح أو تم تعطيله.")
    return member


def _require_public_role(member: dict, allowed: set[str]) -> None:
    if member.get("role") not in allowed:
        raise HTTPException(status_code=403, detail="صلاحية رابط المراجعة لا تسمح بهذه العملية.")


def _sources() -> list[dict]:
    output: list[dict] = []
    for path in v21.PROJECTS_DIR.glob("*/project.json"):
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for item in project.get("items", []):
            if item.get("status") == "done" and item.get("resultReady") and item.get("childJobId"):
                output.append({
                    "projectId": project.get("id"),
                    "projectName": project.get("name"),
                    "itemId": item.get("id"),
                    "sourceName": item.get("sourceName"),
                    "childJobId": item.get("childJobId"),
                    "finishedAt": item.get("finishedAt"),
                })
    output.sort(key=lambda item: str(item.get("finishedAt") or ""), reverse=True)
    return output[:300]


@router.get("/sources")
async def sources_v22(_username: str = Depends(require_auth)) -> dict:
    return {"sources": _sources()}


@router.get("/rooms")
async def rooms_v22(include_archived: bool = False, _username: str = Depends(require_auth)) -> dict:
    items = []
    for path in ROOMS_DIR.glob("*/room.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("archived") and not include_archived:
                continue
            items.append(_public_room(state))
        except Exception:
            continue
    items.sort(key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
    return {"rooms": items[:200]}


@router.post("/rooms")
async def create_room_v22(
    project_id: str = Form(...),
    item_id: str = Form(...),
    name: str = Form("MAGHRABI Review Room"),
    min_approvals: int = Form(1),
    block_open_comments: bool = Form(False),
    _username: str = Depends(require_auth),
) -> dict:
    room_id = uuid.uuid4().hex
    state = {
        "id": room_id,
        "name": (name or "MAGHRABI Review Room")[:120],
        "v21ProjectId": project_id,
        "v21ItemId": item_id,
        "status": "draft",
        "archived": False,
        "createdAt": _now(),
        "updatedAt": _now(),
        "reviewStartedAt": None,
        "approvedAt": None,
        "approvedVersionId": None,
        "activeVersionId": None,
        "approvalGate": {"minApprovals": max(1, min(20, min_approvals)), "blockOpenComments": bool(block_open_comments)},
        "versions": [],
        "members": [],
        "comments": [],
        "decisions": [],
        "activity": [],
    }
    folder = _room_dir(room_id)
    folder.mkdir(parents=True, exist_ok=False)
    try:
        version = _copy_version_from_v21(state, project_id, item_id, "Version 1", "Initial snapshot from Creator V21")
        _activity(state, "room_created", _username, {"versionId": version["id"], "projectId": project_id, "itemId": item_id})
        _write_room(room_id, state)
        return _public_room(state)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@router.get("/rooms/{room_id}")
async def room_v22(room_id: str, _username: str = Depends(require_auth)) -> dict:
    return _public_room(_read_room(room_id))


@router.post("/rooms/{room_id}/versions/from-v21")
async def add_version_v22(room_id: str, label: str = Form(""), notes: str = Form(""), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        version = _copy_version_from_v21(state, str(state["v21ProjectId"]), str(state["v21ItemId"]), label or None, notes)
        _activity(state, "version_added", _username, {"versionId": version["id"], "source": "v21"})
        _write_room(room_id, state)
        return _public_room(state)


@router.post("/rooms/{room_id}/versions/upload")
async def upload_version_v22(room_id: str, file: UploadFile = File(...), label: str = Form(""), notes: str = Form(""), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
    version = await _save_uploaded_version(state, file, label, notes)
    with _LOCK:
        _activity(state, "version_added", _username, {"versionId": version["id"], "source": "upload"})
        _write_room(room_id, state)
    return _public_room(state)


@router.post("/rooms/{room_id}/active-version")
async def active_version_v22(room_id: str, version_id: str = Form(...), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        _version_path(state, version_id)
        state["activeVersionId"] = version_id
        state["reviewStartedAt"] = None
        _refresh_status(state)
        _activity(state, "active_version_changed", _username, {"versionId": version_id})
        _write_room(room_id, state)
        return _public_room(state)


@router.get("/rooms/{room_id}/versions/{version_id}/video")
async def version_video_v22(room_id: str, version_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    state = _read_room(room_id)
    version, path = _version_path(state, version_id)
    return FileResponse(path, media_type="video/mp4", filename=f"MAGHRABI-review-v{version.get('number',1)}.mp4")


@router.post("/rooms/{room_id}/members")
async def add_member_v22(room_id: str, payload: dict = Body(...), _username: str = Depends(require_auth)) -> dict:
    role = str(payload.get("role") or "reviewer")
    if role not in ROLES:
        raise HTTPException(status_code=400, detail="Role غير مدعوم.")
    name = str(payload.get("name") or "Reviewer").strip()[:100]
    email = str(payload.get("email") or "").strip()[:180]
    token = secrets.token_urlsafe(32)
    member = {
        "id": uuid.uuid4().hex[:12],
        "name": name or "Reviewer",
        "email": email,
        "role": role,
        "tokenHash": _hash_token(token),
        "tokenLast4": token[-4:],
        "active": True,
        "createdAt": _now(),
    }
    with _LOCK:
        state = _read_room(room_id)
        state.setdefault("members", []).append(member)
        _activity(state, "member_added", _username, {"memberId": member["id"], "name": member["name"], "role": role})
        _write_room(room_id, state)
    return {"room": _public_room(state), "member": _public_member(member, internal=True), "reviewToken": token, "shareFragment": f"#review={room_id}:{token}"}


@router.post("/rooms/{room_id}/members/{member_id}/rotate")
async def rotate_member_v22(room_id: str, member_id: str, _username: str = Depends(require_auth)) -> dict:
    token = secrets.token_urlsafe(32)
    with _LOCK:
        state = _read_room(room_id)
        member = next((item for item in state.get("members", []) if item.get("id") == member_id), None)
        if member is None:
            raise HTTPException(status_code=404, detail="عضو المراجعة غير موجود.")
        member["tokenHash"] = _hash_token(token)
        member["tokenLast4"] = token[-4:]
        member["active"] = True
        _activity(state, "review_link_rotated", _username, {"memberId": member_id})
        _write_room(room_id, state)
    return {"member": _public_member(member, internal=True), "reviewToken": token, "shareFragment": f"#review={room_id}:{token}"}


@router.post("/rooms/{room_id}/members/{member_id}/active")
async def member_active_v22(room_id: str, member_id: str, active: bool = Form(...), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        member = next((item for item in state.get("members", []) if item.get("id") == member_id), None)
        if member is None:
            raise HTTPException(status_code=404, detail="عضو المراجعة غير موجود.")
        member["active"] = bool(active)
        _refresh_status(state)
        _activity(state, "member_status_changed", _username, {"memberId": member_id, "active": bool(active)})
        _write_room(room_id, state)
        return _public_room(state)


@router.post("/rooms/{room_id}/approval-gate")
async def approval_gate_v22(room_id: str, payload: dict = Body(...), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        state["approvalGate"] = {
            "minApprovals": max(1, min(20, int(payload.get("minApprovals", 1)))),
            "blockOpenComments": bool(payload.get("blockOpenComments", False)),
        }
        _refresh_status(state)
        _activity(state, "approval_gate_updated", _username, state["approvalGate"])
        _write_room(room_id, state)
        return _public_room(state)


@router.post("/rooms/{room_id}/start-review")
async def start_review_v22(room_id: str, _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        _active_version(state)
        state["reviewStartedAt"] = _now()
        _refresh_status(state)
        _activity(state, "review_started", _username, {"versionId": state.get("activeVersionId")})
        _write_room(room_id, state)
        return _public_room(state)


@router.post("/rooms/{room_id}/comments/{comment_id}/resolve")
async def resolve_comment_v22(room_id: str, comment_id: str, resolved: bool = Form(True), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        comment = next((item for item in state.get("comments", []) if item.get("id") == comment_id), None)
        if comment is None:
            raise HTTPException(status_code=404, detail="Comment غير موجود.")
        comment["status"] = "resolved" if resolved else "open"
        comment["resolvedAt"] = _now() if resolved else None
        _refresh_status(state)
        _activity(state, "comment_resolved" if resolved else "comment_reopened", _username, {"commentId": comment_id})
        _write_room(room_id, state)
        return _public_room(state)


@router.get("/rooms/{room_id}/approved-delivery")
async def approved_delivery_v22(room_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    with _LOCK:
        state = _read_room(room_id)
        approval = _refresh_status(state)
        if not approval["gatePassed"]:
            raise HTTPException(status_code=409, detail="Approval Gate لم يكتمل بعد؛ لا يمكن تنزيل Final Delivery.")
        version_id = str(state.get("approvedVersionId") or state.get("activeVersionId"))
        version, path = _version_path(state, version_id)
        _activity(state, "approved_delivery_downloaded", _username, {"versionId": version_id})
        _write_room(room_id, state)
    return FileResponse(path, media_type="video/mp4", filename=f"MAGHRABI-APPROVED-{state.get('name','review')}-v{version.get('number',1)}.mp4")


@router.post("/rooms/{room_id}/archive")
async def archive_room_v22(room_id: str, archived: bool = Form(True), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        state["archived"] = bool(archived)
        _activity(state, "room_archived" if archived else "room_restored", _username)
        _write_room(room_id, state)
        return _public_room(state)


@router.delete("/rooms/{room_id}")
async def delete_room_v22(room_id: str, _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        _read_room(room_id)
        shutil.rmtree(_room_dir(room_id), ignore_errors=True)
    return {"ok": True, "id": room_id}


# Public review endpoints. The token is sent in a header by the SPA; it is not embedded in the API URL.
@router.get("/review/{room_id}")
async def public_review_v22(room_id: str, x_maghrabi_review_token: str | None = Header(None)) -> dict:
    state = _read_room(room_id)
    member = _member_from_token(state, x_maghrabi_review_token)
    result = _public_room(state, internal=False)
    result["viewer"] = _public_member(member, internal=False)
    return result


@router.get("/review/{room_id}/versions/{version_id}/video")
async def public_video_v22(room_id: str, version_id: str, x_maghrabi_review_token: str | None = Header(None)) -> FileResponse:
    state = _read_room(room_id)
    _member_from_token(state, x_maghrabi_review_token)
    version, path = _version_path(state, version_id)
    return FileResponse(path, media_type="video/mp4", filename=f"MAGHRABI-review-v{version.get('number',1)}.mp4")


@router.post("/review/{room_id}/comments")
async def public_comment_v22(room_id: str, payload: dict = Body(...), x_maghrabi_review_token: str | None = Header(None)) -> dict:
    with _LOCK:
        state = _read_room(room_id)
        member = _member_from_token(state, x_maghrabi_review_token)
        _require_public_role(member, {"commenter", "reviewer"})
        version_id = str(payload.get("versionId") or state.get("activeVersionId") or "")
        _version_path(state, version_id)
        try:
            at = max(0.0, min(24 * 3600.0, float(payload.get("time", 0))))
        except (TypeError, ValueError):
            at = 0.0
        text = str(payload.get("text") or "").strip()[:2000]
        if not text:
            raise HTTPException(status_code=400, detail="اكتب نص التعليق أولًا.")
        comment = {
            "id": uuid.uuid4().hex[:14],
            "versionId": version_id,
            "time": at,
            "text": text,
            "status": "open",
            "authorName": member.get("name"),
            "authorRole": member.get("role"),
            "memberId": member.get("id"),
            "createdAt": _now(),
            "resolvedAt": None,
        }
        state.setdefault("comments", []).append(comment)
        _refresh_status(state)
        _activity(state, "review_comment_added", str(member.get("name")), {"commentId": comment["id"], "versionId": version_id, "time": at})
        _write_room(room_id, state)
        return {"comment": comment, "approval": _approval_state(state)}


@router.post("/review/{room_id}/decision")
async def public_decision_v22(room_id: str, payload: dict = Body(...), x_maghrabi_review_token: str | None = Header(None)) -> dict:
    decision = str(payload.get("decision") or "")
    if decision not in DECISIONS:
        raise HTTPException(status_code=400, detail="قرار المراجعة غير صالح.")
    with _LOCK:
        state = _read_room(room_id)
        member = _member_from_token(state, x_maghrabi_review_token)
        _require_public_role(member, {"reviewer"})
        version_id = str(payload.get("versionId") or state.get("activeVersionId") or "")
        _version_path(state, version_id)
        note = str(payload.get("note") or "").strip()[:2000]
        state["decisions"] = [item for item in state.get("decisions", []) if not (item.get("versionId") == version_id and item.get("memberId") == member.get("id"))]
        item = {
            "id": uuid.uuid4().hex[:14],
            "versionId": version_id,
            "memberId": member.get("id"),
            "memberName": member.get("name"),
            "decision": decision,
            "note": note,
            "createdAt": _now(),
        }
        state.setdefault("decisions", []).append(item)
        approval = _refresh_status(state)
        _activity(state, "review_decision", str(member.get("name")), {"decision": decision, "versionId": version_id})
        _write_room(room_id, state)
        return {"decision": item, "approval": approval, "status": state.get("status")}
