from __future__ import annotations

from . import video_tools_v23 as base
from . import video_tools_v22 as v22

router = base.router


def _enterprise_aware_approval_state(state: dict) -> dict:
    versions = state.get("versions", [])
    active_id = state.get("activeVersionId")
    if not active_id or not versions:
        return {"status": "draft", "approvals": 0, "changesRequested": 0, "openComments": 0, "gatePassed": False}

    reviewer_ids = {item.get("id") for item in state.get("members", []) if item.get("active", True) and item.get("role") == "reviewer"}
    decisions = [
        item for item in state.get("decisions", [])
        if item.get("versionId") == active_id and (item.get("memberId") in reviewer_ids or bool(item.get("enterprise")))
    ]
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


v22._approval_state = _enterprise_aware_approval_state
