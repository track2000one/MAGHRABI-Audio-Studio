from __future__ import annotations

import asyncio
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
from .video_tools_v11 import render_video_v11

router = APIRouter(prefix="/api/video/v12", tags=["video-studio-v12"])

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
QUEUE_DIR = DATA_DIR / "video_queue"
QUEUE_DIR.mkdir(parents=True, exist_ok=True)

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-v12-queue")
_LOCK = threading.Lock()
_SCHEDULED: set[str] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _job_dir(job_id: str) -> Path:
    return QUEUE_DIR / job_id


def _state_path(job_id: str) -> Path:
    return _job_dir(job_id) / "job.json"


def _read_state(job_id: str) -> dict:
    path = _state_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="مهمة Render غير موجودة.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="تعذر قراءة حالة مهمة Render.") from exc


def _write_state(job_id: str, state: dict) -> None:
    folder = _job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "job.json"
    temp = folder / "job.json.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def _public_state(state: dict) -> dict:
    return {
        "id": state.get("id"),
        "name": state.get("name"),
        "status": state.get("status"),
        "stage": state.get("stage"),
        "progress": state.get("progress", 0),
        "outputSize": state.get("outputSize"),
        "quality": state.get("quality"),
        "createdAt": state.get("createdAt"),
        "startedAt": state.get("startedAt"),
        "finishedAt": state.get("finishedAt"),
        "message": state.get("message"),
        "error": state.get("error"),
        "resultReady": bool(state.get("resultReady")),
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


def _suffix(upload: UploadFile, fallback: str) -> str:
    suffix = Path(upload.filename or "").suffix.lower()
    if not suffix or len(suffix) > 10:
        return fallback
    return suffix


def _upload_from_path(path: Path, handles: list) -> UploadFile:
    handle = path.open("rb")
    handles.append(handle)
    return UploadFile(file=handle, filename=path.name)


async def _render_job(job_id: str) -> None:
    state = _read_state(job_id)
    folder = _job_dir(job_id)
    handles: list = []
    response = None
    try:
        state.update(
            status="rendering",
            stage="rendering",
            progress=10,
            startedAt=state.get("startedAt") or _now(),
            message="يتم الآن تنفيذ Render عبر FFmpeg.",
            error=None,
        )
        _write_state(job_id, state)

        video_files = [_upload_from_path(folder / item, handles) for item in state.get("videoFiles", [])]
        audio_files = [_upload_from_path(folder / item, handles) for item in state.get("audioFiles", [])]
        image_files = [_upload_from_path(folder / item, handles) for item in state.get("imageFiles", [])]
        lut_path = folder / state["lutFile"] if state.get("lutFile") else None
        lut_file = _upload_from_path(lut_path, handles) if lut_path and lut_path.exists() else None
        manifest = (folder / "manifest.json").read_text(encoding="utf-8")

        response = await render_video_v11(
            video_files=video_files,
            audio_files=audio_files,
            image_files=image_files,
            lut_file=lut_file,
            manifest=manifest,
            output_size=state.get("outputSize", "720p"),
            quality=state.get("quality", "standard"),
            _username="v12-queue-worker",
        )
        source = Path(str(response.path))
        output = folder / "result.mp4"
        shutil.copy2(source, output)
        state.update(
            status="done",
            stage="done",
            progress=100,
            finishedAt=_now(),
            message="اكتمل Render بنجاح.",
            resultReady=True,
            error=None,
        )
        _write_state(job_id, state)
    except Exception as exc:
        try:
            state = _read_state(job_id)
        except Exception:
            state = {"id": job_id}
        state.update(
            status="failed",
            stage="failed",
            progress=100,
            finishedAt=_now(),
            message="فشل تنفيذ Render.",
            resultReady=False,
            error=str(exc)[:2000],
        )
        _write_state(job_id, state)
    finally:
        for handle in handles:
            try:
                handle.close()
            except Exception:
                pass
        if response is not None and response.background is not None:
            try:
                await response.background()
            except Exception:
                pass


def _run_job_sync(job_id: str) -> None:
    try:
        asyncio.run(_render_job(job_id))
    finally:
        with _LOCK:
            _SCHEDULED.discard(job_id)


def _schedule(job_id: str) -> None:
    with _LOCK:
        if job_id in _SCHEDULED:
            return
        _SCHEDULED.add(job_id)
    _EXECUTOR.submit(_run_job_sync, job_id)


def _resume_jobs() -> None:
    states: list[dict] = []
    for path in QUEUE_DIR.glob("*/job.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("status") == "rendering":
                state.update(
                    status="queued",
                    stage="queued",
                    progress=0,
                    message="أعيدت جدولة المهمة بعد إعادة تشغيل الخدمة.",
                    error=None,
                )
                _write_state(str(state.get("id")), state)
            if state.get("status") == "queued":
                states.append(state)
        except Exception as exc:
            print(f"[v12-queue] skipped {path}: {exc}", flush=True)
    states.sort(key=lambda item: str(item.get("createdAt", "")))
    for state in states:
        if state.get("id"):
            _schedule(str(state["id"]))


@router.post("/queue")
async def enqueue_render_v12(
    video_files: list[UploadFile] = File(...),
    audio_files: list[UploadFile] | None = File(None),
    image_files: list[UploadFile] | None = File(None),
    lut_file: UploadFile | None = File(None),
    manifest: str = Form(...),
    output_size: Literal["720p", "1080p", "portrait", "square"] = Form("720p"),
    quality: Literal["draft", "standard", "high"] = Form("standard"),
    name: str = Form("MAGHRABI V12 Render"),
    _username: str = Depends(require_auth),
) -> dict:
    if not video_files:
        raise HTTPException(status_code=400, detail="أضف ملف فيديو واحدًا على الأقل.")
    try:
        json.loads(manifest)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Manifest المشروع غير صالح.") from exc

    audio_files = audio_files or []
    image_files = image_files or []
    job_id = uuid.uuid4().hex
    folder = _job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)

    video_paths: list[str] = []
    audio_paths: list[str] = []
    image_paths: list[str] = []
    try:
        for index, upload in enumerate(video_files):
            rel = f"inputs/video-{index:02d}{_suffix(upload, '.mp4')}"
            await _save_upload(upload, folder / rel)
            video_paths.append(rel)
        for index, upload in enumerate(audio_files):
            rel = f"inputs/audio-{index:02d}{_suffix(upload, '.wav')}"
            await _save_upload(upload, folder / rel)
            audio_paths.append(rel)
        for index, upload in enumerate(image_files):
            rel = f"inputs/image-{index:02d}{_suffix(upload, '.png')}"
            await _save_upload(upload, folder / rel)
            image_paths.append(rel)
        lut_rel = None
        if lut_file is not None:
            lut_rel = "inputs/master-lut.cube"
            await _save_upload(lut_file, folder / lut_rel)

        (folder / "manifest.json").write_text(manifest, encoding="utf-8")
        state = {
            "id": job_id,
            "name": (name or "MAGHRABI V12 Render")[:120],
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "outputSize": output_size,
            "quality": quality,
            "createdAt": _now(),
            "startedAt": None,
            "finishedAt": None,
            "message": "تمت إضافة المهمة إلى Render Queue.",
            "error": None,
            "resultReady": False,
            "videoFiles": video_paths,
            "audioFiles": audio_paths,
            "imageFiles": image_paths,
            "lutFile": lut_rel,
        }
        _write_state(job_id, state)
        _schedule(job_id)
        return _public_state(state)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@router.get("/jobs")
async def list_render_jobs_v12(_username: str = Depends(require_auth)) -> dict:
    items: list[dict] = []
    for path in QUEUE_DIR.glob("*/job.json"):
        try:
            items.append(_public_state(json.loads(path.read_text(encoding="utf-8"))))
        except Exception:
            continue
    items.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
    return {"jobs": items[:100]}


@router.get("/jobs/{job_id}")
async def get_render_job_v12(job_id: str, _username: str = Depends(require_auth)) -> dict:
    return _public_state(_read_state(job_id))


@router.get("/jobs/{job_id}/result")
async def get_render_result_v12(job_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    state = _read_state(job_id)
    output = _job_dir(job_id) / "result.mp4"
    if state.get("status") != "done" or not output.exists():
        raise HTTPException(status_code=409, detail="نتيجة Render غير جاهزة بعد.")
    return FileResponse(output, media_type="video/mp4", filename=f"MAGHRABI-v12-{job_id[:8]}.mp4")


@router.post("/jobs/{job_id}/retry")
async def retry_render_job_v12(job_id: str, _username: str = Depends(require_auth)) -> dict:
    state = _read_state(job_id)
    if state.get("status") == "rendering":
        raise HTTPException(status_code=409, detail="المهمة قيد التنفيذ حاليًا.")
    output = _job_dir(job_id) / "result.mp4"
    if output.exists():
        output.unlink()
    state.update(
        status="queued",
        stage="queued",
        progress=0,
        startedAt=None,
        finishedAt=None,
        resultReady=False,
        error=None,
        message="تمت إعادة المهمة إلى Render Queue.",
    )
    _write_state(job_id, state)
    _schedule(job_id)
    return _public_state(state)


@router.delete("/jobs/{job_id}")
async def delete_render_job_v12(job_id: str, _username: str = Depends(require_auth)) -> dict:
    state = _read_state(job_id)
    if state.get("status") == "rendering":
        raise HTTPException(status_code=409, detail="لا يمكن حذف مهمة أثناء تنفيذ Render.")
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
    return {"ok": True, "id": job_id}


_resume_jobs()
