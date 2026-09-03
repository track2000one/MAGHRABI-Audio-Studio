from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .main import require_auth
from .video_tools import _run_ffmpeg

router = APIRouter(prefix="/api/video/v13", tags=["video-studio-v13"])

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
PROXY_DIR = DATA_DIR / "video_proxy_queue"
PROXY_DIR.mkdir(parents=True, exist_ok=True)

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-v13-proxy")
_LOCK = threading.Lock()
_SCHEDULED: set[str] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _folder(job_id: str) -> Path:
    return PROXY_DIR / job_id


def _state_path(job_id: str) -> Path:
    return _folder(job_id) / "job.json"


def _write(job_id: str, state: dict) -> None:
    folder = _folder(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / "job.json.tmp"
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(_state_path(job_id))


def _read(job_id: str) -> dict:
    path = _state_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="مهمة Proxy غير موجودة.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="تعذر قراءة حالة Proxy.") from exc


def _public(state: dict) -> dict:
    return {
        "id": state.get("id"),
        "name": state.get("name"),
        "status": state.get("status"),
        "progress": state.get("progress", 0),
        "profile": state.get("profile"),
        "createdAt": state.get("createdAt"),
        "startedAt": state.get("startedAt"),
        "finishedAt": state.get("finishedAt"),
        "message": state.get("message"),
        "error": state.get("error"),
        "resultReady": bool(state.get("resultReady")),
        "sourceName": state.get("sourceName"),
    }


async def _save_upload(upload: UploadFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    await upload.close()


def _render_proxy(job_id: str) -> None:
    state = _read(job_id)
    folder = _folder(job_id)
    source = folder / state["sourceFile"]
    output = folder / "proxy.mp4"
    try:
        state.update(
            status="processing",
            progress=12,
            startedAt=state.get("startedAt") or _now(),
            message="يتم إنشاء Proxy/Conform في الخلفية.",
            error=None,
        )
        _write(job_id, state)

        profile = str(state.get("profile", "540p"))
        width = 1280 if profile == "720p" else 960
        _run_ffmpeg([
            "ffmpeg", "-hide_banner", "-y", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a?",
            "-vf", f"scale='min({width},iw)':-2:flags=fast_bilinear,fps=30,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "29",
            "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", str(output),
        ])

        state.update(
            status="done",
            progress=100,
            finishedAt=_now(),
            resultReady=True,
            message="اكتمل إنشاء Proxy. سيبقى التصدير النهائي من الملف الأصلي.",
            error=None,
        )
        _write(job_id, state)
    except Exception as exc:
        state.update(
            status="failed",
            progress=100,
            finishedAt=_now(),
            resultReady=False,
            message="فشل إنشاء Proxy.",
            error=str(exc)[:2000],
        )
        _write(job_id, state)
    finally:
        with _LOCK:
            _SCHEDULED.discard(job_id)


def _schedule(job_id: str) -> None:
    with _LOCK:
        if job_id in _SCHEDULED:
            return
        _SCHEDULED.add(job_id)
    _EXECUTOR.submit(_render_proxy, job_id)


def _resume() -> None:
    states: list[dict] = []
    for path in PROXY_DIR.glob("*/job.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("status") == "processing":
                state.update(
                    status="queued",
                    progress=0,
                    message="أعيدت جدولة Proxy بعد إعادة تشغيل الخدمة.",
                    error=None,
                )
                _write(str(state.get("id")), state)
            if state.get("status") == "queued":
                states.append(state)
        except Exception as exc:
            print(f"[v13-proxy] skipped {path}: {exc}", flush=True)
    states.sort(key=lambda item: str(item.get("createdAt", "")))
    for state in states:
        if state.get("id"):
            _schedule(str(state["id"]))


@router.post("/proxy-queue")
async def enqueue_proxy_v13(
    file: UploadFile = File(...),
    profile: Literal["540p", "720p"] = Form("540p"),
    _username: str = Depends(require_auth),
) -> dict:
    suffix = Path(file.filename or "video.mp4").suffix.lower() or ".mp4"
    if suffix not in {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}:
        raise HTTPException(status_code=400, detail="صيغة الفيديو غير مدعومة لإنشاء Proxy.")
    job_id = uuid.uuid4().hex
    folder = _folder(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    rel = f"source{suffix}"
    try:
        await _save_upload(file, folder / rel)
        state = {
            "id": job_id,
            "name": f"Proxy · {file.filename or 'video'}",
            "sourceName": file.filename or "video",
            "sourceFile": rel,
            "profile": profile,
            "status": "queued",
            "progress": 0,
            "createdAt": _now(),
            "startedAt": None,
            "finishedAt": None,
            "message": "تمت إضافة الملف إلى Proxy/Conform Queue.",
            "error": None,
            "resultReady": False,
        }
        _write(job_id, state)
        _schedule(job_id)
        return _public(state)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@router.get("/proxy-jobs")
async def list_proxy_jobs_v13(_username: str = Depends(require_auth)) -> dict:
    jobs: list[dict] = []
    for path in PROXY_DIR.glob("*/job.json"):
        try:
            jobs.append(_public(json.loads(path.read_text(encoding="utf-8"))))
        except Exception:
            continue
    jobs.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
    return {"jobs": jobs[:100]}


@router.get("/proxy-jobs/{job_id}")
async def get_proxy_job_v13(job_id: str, _username: str = Depends(require_auth)) -> dict:
    return _public(_read(job_id))


@router.get("/proxy-jobs/{job_id}/result")
async def get_proxy_result_v13(job_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    state = _read(job_id)
    output = _folder(job_id) / "proxy.mp4"
    if state.get("status") != "done" or not output.exists():
        raise HTTPException(status_code=409, detail="Proxy غير جاهز بعد.")
    return FileResponse(output, media_type="video/mp4", filename=f"MAGHRABI-proxy-{job_id[:8]}.mp4")


@router.post("/proxy-jobs/{job_id}/retry")
async def retry_proxy_v13(job_id: str, _username: str = Depends(require_auth)) -> dict:
    state = _read(job_id)
    if state.get("status") == "processing":
        raise HTTPException(status_code=409, detail="Proxy قيد التنفيذ حاليًا.")
    output = _folder(job_id) / "proxy.mp4"
    if output.exists():
        output.unlink()
    state.update(
        status="queued",
        progress=0,
        startedAt=None,
        finishedAt=None,
        resultReady=False,
        message="تمت إعادة Proxy إلى Queue.",
        error=None,
    )
    _write(job_id, state)
    _schedule(job_id)
    return _public(state)


@router.delete("/proxy-jobs/{job_id}")
async def delete_proxy_v13(job_id: str, _username: str = Depends(require_auth)) -> dict:
    state = _read(job_id)
    if state.get("status") == "processing":
        raise HTTPException(status_code=409, detail="لا يمكن حذف Proxy أثناء التنفيذ.")
    shutil.rmtree(_folder(job_id), ignore_errors=True)
    return {"ok": True, "id": job_id}


_resume()
