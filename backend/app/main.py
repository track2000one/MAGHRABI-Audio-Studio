from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "250"))
DEMUCS_MODEL = os.getenv("DEMUCS_MODEL", "htdemucs")
MAX_WORKERS = max(1, int(os.getenv("MAX_WORKERS", "1")))
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}

JOBS_DIR.mkdir(parents=True, exist_ok=True)
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="audio-separator")
store_lock = threading.Lock()
active_lock = threading.Lock()
active_jobs: set[str] = set()
app = FastAPI(title="MAGHRABI Audio Studio API", version="0.1.1")


class JobResponse(BaseModel):
    id: str
    original_name: str
    mode: Literal["2stems", "4stems"]
    status: Literal["queued", "processing", "completed", "failed"]
    progress: int
    message: str
    stems: dict[str, str]
    error: str | None = None


def job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def state_path(job_id: str) -> Path:
    return job_dir(job_id) / "job.json"


def read_state(job_id: str) -> dict:
    path = state_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Job not found")
    with store_lock:
        return json.loads(path.read_text(encoding="utf-8"))


def write_state(job_id: str, state: dict) -> None:
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / "job.tmp"
    with store_lock:
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(state_path(job_id))


def update_state(job_id: str, **changes) -> dict:
    state = read_state(job_id)
    state.update(changes)
    write_state(job_id, state)
    return state


def public_state(state: dict) -> dict:
    public = dict(state)
    public.pop("input_path", None)
    public["stems"] = {
        name: f"/api/jobs/{state['id']}/files/{Path(path).name}"
        for name, path in state.get("stems", {}).items()
    }
    return public


def run_separation(job_id: str) -> None:
    print(f"[worker] starting job {job_id}", flush=True)
    try:
        state = read_state(job_id)
        input_path = Path(state["input_path"])
        if not input_path.exists():
            raise RuntimeError("الملف الأصلي للمهمة غير موجود.")

        output_root = job_dir(job_id) / "demucs"
        exports_dir = job_dir(job_id) / "stems"
        exports_dir.mkdir(parents=True, exist_ok=True)

        update_state(
            job_id,
            status="processing",
            progress=10,
            message="يتم تشغيل محرك العزل وتجهيز نموذج الذكاء الاصطناعي...",
            error=None,
        )

        command = [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            DEMUCS_MODEL,
            "--out",
            str(output_root),
        ]
        if state["mode"] == "2stems":
            command.extend(["--two-stems", "vocals"])
        command.append(str(input_path))

        update_state(
            job_id,
            progress=25,
            message="جاري تحليل الملف وفصل المسارات. أول عملية قد تستغرق وقتاً لتنزيل نموذج الذكاء الاصطناعي...",
        )
        print(f"[worker] running Demucs for {job_id}: {' '.join(command)}", flush=True)

        process = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        print(f"[worker] Demucs exit code for {job_id}: {process.returncode}", flush=True)

        if process.returncode != 0:
            tail = "\n".join(process.stdout.splitlines()[-30:])
            raise RuntimeError(tail or "Demucs exited with an unknown error")

        update_state(job_id, progress=90, message="يتم تجهيز ملفات المسارات للمعاينة والتحميل...")
        expected = (
            ["vocals", "no_vocals"]
            if state["mode"] == "2stems"
            else ["vocals", "drums", "bass", "other"]
        )
        stems: dict[str, str] = {}
        for stem in expected:
            matches = list(output_root.rglob(f"{stem}.wav"))
            if not matches:
                continue
            target_name = "instrumental.wav" if stem == "no_vocals" else f"{stem}.wav"
            target = exports_dir / target_name
            shutil.copy2(matches[0], target)
            stems["instrumental" if stem == "no_vocals" else stem] = str(target)

        if not stems:
            raise RuntimeError("لم يتم العثور على المسارات الناتجة بعد انتهاء Demucs.")

        update_state(
            job_id,
            status="completed",
            progress=100,
            message="اكتملت عملية الفصل بنجاح.",
            stems=stems,
            error=None,
        )
        print(f"[worker] completed job {job_id}", flush=True)
    except Exception as exc:
        print(f"[worker] job {job_id} failed: {exc}", flush=True)
        try:
            update_state(
                job_id,
                status="failed",
                progress=100,
                message="فشلت عملية الفصل.",
                error=str(exc)[-4000:],
            )
        except Exception as state_exc:
            print(f"[worker] could not persist failure for {job_id}: {state_exc}", flush=True)


def _job_finished(job_id: str, future: Future) -> None:
    with active_lock:
        active_jobs.discard(job_id)
    try:
        exception = future.exception()
    except Exception as exc:
        exception = exc
    if exception:
        print(f"[worker] unhandled future error for {job_id}: {exception}", flush=True)
        try:
            update_state(
                job_id,
                status="failed",
                progress=100,
                message="تعذر تشغيل عامل معالجة الصوت.",
                error=str(exception)[-4000:],
            )
        except Exception:
            pass


def submit_job(job_id: str, *, recovered: bool = False) -> bool:
    with active_lock:
        if job_id in active_jobs:
            return False
        active_jobs.add(job_id)

    try:
        if recovered:
            update_state(
                job_id,
                status="queued",
                progress=6,
                message="تمت استعادة المهمة بعد إعادة تشغيل الخدمة، وسيبدأ العزل تلقائياً...",
                error=None,
            )
        future = executor.submit(run_separation, job_id)
        future.add_done_callback(lambda done, jid=job_id: _job_finished(jid, done))
        print(f"[worker] queued job {job_id} recovered={recovered}", flush=True)
        return True
    except Exception:
        with active_lock:
            active_jobs.discard(job_id)
        raise


def recover_pending_jobs() -> None:
    recovered_count = 0
    for path in JOBS_DIR.glob("*/job.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("status") not in {"queued", "processing"}:
                continue
            input_path = Path(state.get("input_path", ""))
            if not input_path.exists():
                continue
            if submit_job(state["id"], recovered=True):
                recovered_count += 1
        except Exception as exc:
            print(f"[worker] recovery skipped {path}: {exc}", flush=True)
    print(f"[worker] recovery finished, jobs restored: {recovered_count}", flush=True)


@app.on_event("startup")
def startup_recovery() -> None:
    recover_pending_jobs()


@app.get("/api/health")
def health() -> dict:
    with active_lock:
        active = len(active_jobs)
    return {
        "status": "ok",
        "service": "MAGHRABI Audio Studio",
        "engine": "demucs",
        "model": DEMUCS_MODEL,
        "worker": "ready",
        "active_jobs": active,
        "max_workers": MAX_WORKERS,
    }


@app.post("/api/jobs", response_model=JobResponse, status_code=202)
async def create_job(
    file: UploadFile = File(...),
    mode: Literal["2stems", "4stems"] = Form("4stems"),
) -> JobResponse:
    original_name = Path(file.filename or "audio").name
    extension = Path(original_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="صيغة الملف غير مدعومة.")

    job_id = uuid.uuid4().hex
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    input_path = folder / f"original{extension}"
    size = 0
    chunk_size = 1024 * 1024

    with input_path.open("wb") as output:
        while chunk := await file.read(chunk_size):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                output.close()
                input_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"الحد الأعلى لحجم الملف هو {MAX_UPLOAD_MB} MB.",
                )
            output.write(chunk)
    await file.close()

    state = {
        "id": job_id,
        "original_name": original_name,
        "mode": mode,
        "status": "queued",
        "progress": 5,
        "message": "تم رفع الملف وإضافته إلى قائمة المعالجة.",
        "input_path": str(input_path),
        "stems": {},
        "error": None,
    }
    write_state(job_id, state)

    try:
        submit_job(job_id)
    except Exception as exc:
        update_state(
            job_id,
            status="failed",
            progress=100,
            message="تعذر تشغيل عامل معالجة الصوت.",
            error=str(exc)[-4000:],
        )
        raise HTTPException(status_code=500, detail="تعذر تشغيل عامل معالجة الصوت.") from exc

    return JobResponse(**public_state(read_state(job_id)))


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str) -> JobResponse:
    return JobResponse(**public_state(read_state(job_id)))


@app.get("/api/jobs/{job_id}/files/{filename}")
def get_stem(job_id: str, filename: str) -> FileResponse:
    safe_name = Path(filename).name
    if safe_name != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    target = (job_dir(job_id) / "stems" / safe_name).resolve()
    expected_parent = (job_dir(job_id) / "stems").resolve()
    if target.parent != expected_parent or not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(target, media_type="audio/wav", filename=safe_name)


static_dir = Path("/app/static")
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")
