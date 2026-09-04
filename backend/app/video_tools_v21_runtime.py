from __future__ import annotations

import shutil
import time
from pathlib import Path

from . import managed_workers_v27 as managed
from . import video_tools_v21 as base

router = base.router
_original_process_one = base._process_one


def _queued_item(project: dict) -> dict | None:
    return next((item for item in project.get("items", []) if item.get("status") == "queued"), None)


def _managed_process_one(project_id: str) -> None:
    with base._LOCK:
        project = base._read_project(project_id)
        if project.get("pauseRequested"):
            return _original_process_one(project_id)
        item = _queued_item(project)
        if item is None:
            return _original_process_one(project_id)
        item_id = str(item["id"])
        identity_key = f"{project_id}:{item_id}"
        generation = managed.next_generation_if_completed("v21-item", identity_key, int(item.get("v27Generation") or 1))
        if generation != int(item.get("v27Generation") or 1):
            item["v27Generation"] = generation
            base._write_project(project_id, project)
        source = base._project_dir(project_id) / str(item.get("sourceFile") or "")
        lease_state = {
            "projectId": project_id,
            "itemId": item_id,
            "sourceName": item.get("sourceName"),
            "sizeBytes": item.get("sizeBytes"),
            "priority": project.get("priority"),
            "preset": project.get("preset"),
            "templateId": project.get("templateId"),
            "settings": project.get("settings"),
            "pipelineConfig": project.get("pipelineConfig"),
            "generation": generation,
        }
    handle = managed.acquire(
        prefix="v21-item",
        identity_key=identity_key,
        generation=generation,
        state=lease_state,
        paths=[source],
        circuit="orchestrator-pipeline",
    )
    if not handle.acquired:
        # Multiple replicas may select the same highest-priority project. The
        # lease winner proceeds; other dispatchers back off briefly.
        time.sleep(.35)
        return
    try:
        _original_process_one(project_id)
        final_project = base._read_project(project_id)
        final_item = next((value for value in final_project.get("items", []) if value.get("id") == item_id), None) or {}
        child_id = final_item.get("childJobId")
        result = base.V20._job_dir(str(child_id)) / "result.mp4" if child_id else None
        if final_item.get("status") == "done":
            managed.complete(handle, result)
        else:
            managed.fail(handle, str(final_item.get("error") or "V21 orchestrator item failed"), final_item)
    except Exception as exc:
        managed.fail(handle, str(exc), lease_state)
        raise


base._process_one = _managed_process_one


def reconcile() -> dict:
    retried = 0
    dlq = 0
    generation_advanced = 0
    projects_touched = 0
    for path in base.PROJECTS_DIR.glob("*/project.json"):
        try:
            project_id = path.parent.name
            with base._LOCK:
                project = base._read_project(project_id)
                changed = False
                for item in project.get("items", []):
                    item_id = str(item.get("id") or "")
                    if not item_id:
                        continue
                    identity_key = f"{project_id}:{item_id}"
                    generation = int(item.get("v27Generation") or 1)
                    job_key = managed.generation_key("v21-item", identity_key, generation)
                    row = managed.lease_row(job_key)
                    if row and row.get("state") == "completed" and item.get("status") == "queued":
                        item["v27Generation"] = generation + 1
                        generation_advanced += 1
                        changed = True
                        continue
                    if row and row.get("state") == "dlq":
                        if item.get("status") != "done":
                            item.update(
                                status="failed", progress=100, stage="dlq", finishedAt=item.get("finishedAt") or base._now(),
                                resultReady=False, reportReady=False, captionsReady=False,
                                message="تم نقل عنصر V21 إلى V27 Dead Letter Queue بعد استنفاد المحاولات.",
                                error=str(row.get("last_error") or item.get("error") or "Retry attempts exhausted")[:2000],
                            )
                            changed = True
                        dlq += 1
                        continue
                    if item.get("status") == "failed" and row and row.get("state") == "retry_wait" and managed.retry_due(row):
                        old_child = item.get("childJobId")
                        if old_child:
                            shutil.rmtree(base.V20._job_dir(str(old_child)), ignore_errors=True)
                        item.update(
                            status="queued", childJobId=None, error=None, startedAt=None, finishedAt=None,
                            resultReady=False, reportReady=False, captionsReady=False,
                            progress=0, stage="queued", message="انتهى Retry Backoff؛ أعيد العنصر تلقائيًا إلى V21 Orchestrator.",
                        )
                        project["pauseRequested"] = False
                        project["status"] = "queued"
                        project["finishedAt"] = None
                        retried += 1
                        changed = True
                if changed:
                    if any(item.get("status") == "queued" for item in project.get("items", [])) and not project.get("pauseRequested"):
                        project["status"] = "queued"
                        project["finishedAt"] = None
                    base._write_project(project_id, project)
                    projects_touched += 1
        except Exception:
            continue
    if projects_touched:
        base._WAKE.set()
    return {
        "queue": "v21-orchestrator",
        "retried": retried,
        "dlq": dlq,
        "generationAdvanced": generation_advanced,
        "projectsTouched": projects_touched,
    }
