from __future__ import annotations

from fastapi import Depends

from . import video_tools_v24 as base
from . import video_tools_v22 as v22

router = base.router


@router.get("/me/review/{room_id}")
async def review_room_v24(room_id: str, user: dict = Depends(base.require_user)) -> dict:
    permission = base._require_resource(user, "v22_room", room_id, "view")
    state = v22._read_room(room_id)
    approval = v22._approval_state(state)
    return {
        "id": state.get("id"),
        "name": state.get("name"),
        "status": approval.get("status"),
        "permission": permission,
        "activeVersionId": state.get("activeVersionId"),
        "approvedVersionId": state.get("approvedVersionId"),
        "approval": approval,
        "versions": [
            {key: item.get(key) for key in ("id", "number", "label", "sourceName", "createdAt", "notes")}
            for item in state.get("versions", [])
        ],
        "comments": list(state.get("comments", [])),
        "decisions": list(state.get("decisions", [])),
    }
