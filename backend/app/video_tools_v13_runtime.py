from __future__ import annotations

from pathlib import Path

from . import managed_workers_v27 as managed
from . import video_tools_v13 as base

router = base.router
_original_render_proxy = base._render_proxy


def _managed_render_proxy(job_id: str) -> None:
    state = base._read(job_id)
    generation = managed.next_generation_if_completed("v13-proxy", job_id, int(state.get("v27Generation") or 1))
    if generation != int(state.get("v27Generation") or 1):
        state["v27Generation"] = generation
        base._write(job_id, state)
    folder = base._folder(job_id)
    source = folder / str(state.get("sourceFile") or "")
    handle = managed.acquire(
        prefix="v13-proxy",
        identity_key=job_id,
        generation=generation,
        state=state,
        paths=[source],
        circuit="ffmpeg-proxy",
    )
    if not handle.acquired:
        managed.release_local_scheduled(base._LOCK, base._SCHEDULED, job_id)
        return
    try:
        _original_render_proxy(job_id)
        final = base._read(job_id)
        if final.get("status") == "done":
            managed.complete(handle, base._folder(job_id) / "proxy.mp4")
        else:
            managed.fail(handle, str(final.get("error") or "V13 proxy failed"), final)
    except Exception as exc:
        managed.fail(handle, str(exc), state)
        raise


base._render_proxy = _managed_render_proxy


def reconcile() -> dict:
    scheduled = 0
    retried = 0
    dlq = 0
    completed_synced = 0
    for path in base.PROXY_DIR.glob("*/job.json"):
        try:
            state = base._read(path.parent.name)
            job_id = str(state.get("id") or path.parent.name)
            generation = int(state.get("v27Generation") or 1)
            job_key = managed.generation_key("v13-proxy", job_id, generation)
            row = managed.lease_row(job_key)
            result = base._folder(job_id) / "proxy.mp4"
            if row and row.get("state") == "completed":
                if state.get("status") == "done" and result.exists():
                    completed_synced += 1
                    continue
                if state.get("status") == "queued":
                    state["v27Generation"] = generation + 1
                    base._write(job_id, state)
                    row = None
            if row and row.get("state") == "dlq":
                if state.get("status") != "done":
                    state.update(
                        status="failed", progress=100, finishedAt=state.get("finishedAt") or base._now(),
                        resultReady=False, message="تم نقل Proxy إلى V27 Dead Letter Queue بعد استنفاد المحاولات.",
                        error=str(row.get("last_error") or state.get("error") or "Retry attempts exhausted")[:2000],
                    )
                    base._write(job_id, state)
                dlq += 1
                continue
            if state.get("status") == "failed" and row and row.get("state") == "retry_wait" and managed.retry_due(row):
                managed.patch_state_for_retry(state, message="انتهى Retry Backoff؛ أعيدت Proxy تلقائيًا إلى Managed Queue.")
                base._write(job_id, state)
                base._schedule(job_id)
                retried += 1
                continue
            if state.get("status") == "queued" and managed.retry_due(row):
                base._schedule(job_id)
                scheduled += 1
        except Exception:
            continue
    return {"queue": "v13-proxy", "scheduled": scheduled, "retried": retried, "dlq": dlq, "completedSynced": completed_synced}
