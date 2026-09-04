from __future__ import annotations

from pathlib import Path

from . import managed_workers_v27 as managed
from . import video_tools_v12 as base

router = base.router
_original_run_job_sync = base._run_job_sync


def _input_paths(job_id: str, state: dict) -> list[Path]:
    folder = base._job_dir(job_id)
    paths = [folder / "manifest.json"]
    for key in ("videoFiles", "audioFiles", "imageFiles"):
        paths.extend(folder / str(item) for item in state.get(key, []) if item)
    if state.get("lutFile"):
        paths.append(folder / str(state["lutFile"]))
    return paths


def _managed_run_job_sync(job_id: str) -> None:
    state = base._read_state(job_id)
    generation = managed.next_generation_if_completed("v12-render", job_id, int(state.get("v27Generation") or 1))
    if generation != int(state.get("v27Generation") or 1):
        state["v27Generation"] = generation
        base._write_state(job_id, state)
    handle = managed.acquire(
        prefix="v12-render",
        identity_key=job_id,
        generation=generation,
        state=state,
        paths=_input_paths(job_id, state),
        circuit="ffmpeg-render",
    )
    if not handle.acquired:
        managed.release_local_scheduled(base._LOCK, base._SCHEDULED, job_id)
        return
    try:
        _original_run_job_sync(job_id)
        final = base._read_state(job_id)
        if final.get("status") == "done":
            managed.complete(handle, base._job_dir(job_id) / "result.mp4")
        else:
            managed.fail(handle, str(final.get("error") or "V12 render failed"), final)
    except Exception as exc:
        managed.fail(handle, str(exc), state)
        raise


base._run_job_sync = _managed_run_job_sync


def reconcile() -> dict:
    scheduled = 0
    retried = 0
    dlq = 0
    completed_synced = 0
    for path in base.QUEUE_DIR.glob("*/job.json"):
        try:
            state = base._read_state(path.parent.name)
            job_id = str(state.get("id") or path.parent.name)
            generation = int(state.get("v27Generation") or 1)
            job_key = managed.generation_key("v12-render", job_id, generation)
            row = managed.lease_row(job_key)
            result = base._job_dir(job_id) / "result.mp4"
            if row and row.get("state") == "completed":
                if state.get("status") == "done" and result.exists():
                    completed_synced += 1
                    continue
                if state.get("status") == "queued":
                    state["v27Generation"] = generation + 1
                    base._write_state(job_id, state)
                    generation += 1
                    row = None
            if row and row.get("state") == "dlq":
                if state.get("status") != "done":
                    state.update(
                        status="failed", stage="failed", progress=100, finishedAt=state.get("finishedAt") or base._now(),
                        resultReady=False, message="تم نقل Render إلى V27 Dead Letter Queue بعد استنفاد المحاولات.",
                        error=str(row.get("last_error") or state.get("error") or "Retry attempts exhausted")[:2000],
                    )
                    base._write_state(job_id, state)
                dlq += 1
                continue
            if state.get("status") == "failed" and row and row.get("state") == "retry_wait" and managed.retry_due(row):
                managed.patch_state_for_retry(state, message="انتهى Retry Backoff؛ أعيدت Render تلقائيًا إلى Managed Queue.")
                base._write_state(job_id, state)
                base._schedule(job_id)
                retried += 1
                continue
            if state.get("status") == "queued" and managed.retry_due(row):
                base._schedule(job_id)
                scheduled += 1
        except Exception:
            continue
    return {"queue": "v12-render", "scheduled": scheduled, "retried": retried, "dlq": dlq, "completedSynced": completed_synced}
