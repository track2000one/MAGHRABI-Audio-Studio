from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "250"))
DEMUCS_MODEL = os.getenv("DEMUCS_MODEL", "htdemucs")
MAX_WORKERS = max(1, int(os.getenv("MAX_WORKERS", "1")))
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "").strip()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
AUTH_SECRET = os.getenv("AUTH_SECRET", "")
SESSION_COOKIE = "maghrabi_audio_session"
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", str(12 * 60 * 60)))

JOBS_DIR.mkdir(parents=True, exist_ok=True)
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="audio-separator")
store_lock = threading.Lock()
active_lock = threading.Lock()
active_jobs: set[str] = set()
app = FastAPI(title="MAGHRABI Audio Studio API", version="0.3.0")


class LoginRequest(BaseModel):
    username: str
    password: str


class JobResponse(BaseModel):
    id: str
    original_name: str
    mode: Literal["2stems", "4stems"]
    status: Literal["queued", "processing", "completed", "failed"]
    progress: int
    stage: str = "queued"
    message: str
    elapsed_seconds: int = 0
    stems: dict[str, str]
    error: str | None = None


def auth_configured() -> bool:
    return bool(ADMIN_USERNAME and ADMIN_PASSWORD and AUTH_SECRET and len(AUTH_SECRET) >= 32)


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_session_token(username: str) -> str:
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    payload = f"{username}|{expires_at}".encode("utf-8")
    encoded = _b64encode(payload)
    signature = hmac.new(AUTH_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{_b64encode(signature)}"


def verify_session_token(token: str | None) -> str | None:
    if not token or not auth_configured() or "." not in token:
        return None
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected_signature = hmac.new(
            AUTH_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(_b64decode(supplied_signature), expected_signature):
            return None
        username, expires_text = _b64decode(encoded).decode("utf-8").rsplit("|", 1)
        if username != ADMIN_USERNAME or int(expires_text) < int(time.time()):
            return None
        return username
    except (ValueError, TypeError, UnicodeDecodeError):
        return None


def current_user(request: Request) -> str | None:
    return verify_session_token(request.cookies.get(SESSION_COOKIE))


def require_auth(request: Request) -> str:
    username = current_user(request)
    if not username:
        raise HTTPException(status_code=401, detail="يلزم تسجيل الدخول للمتابعة.")
    return username


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict:
    username = current_user(request)
    return {
        "configured": auth_configured(),
        "authenticated": bool(username),
        "username": username,
    }


@app.post("/api/auth/login")
def login(payload: LoginRequest, response: Response) -> dict:
    if not auth_configured():
        raise HTTPException(
            status_code=503,
            detail="إعداد تسجيل الدخول غير مكتمل في Railway. أضف ADMIN_USERNAME وADMIN_PASSWORD وAUTH_SECRET.",
        )
    username_ok = hmac.compare_digest(payload.username.strip(), ADMIN_USERNAME)
    password_ok = hmac.compare_digest(payload.password, ADMIN_PASSWORD)
    if not (username_ok and password_ok):
        raise HTTPException(status_code=401, detail="اسم المستخدم أو كلمة المرور غير صحيحة.")

    response.set_cookie(
        key=SESSION_COOKIE,
        value=create_session_token(ADMIN_USERNAME),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )
    return {"authenticated": True, "username": ADMIN_USERNAME}


@app.post("/api/auth/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
    return {"authenticated": False}


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


def elapsed_seconds_for(state: dict) -> int:
    if state.get("status") in {"completed", "failed"}:
        return int(state.get("elapsed_seconds", 0) or 0)
    started_at = state.get("started_at")
    if isinstance(started_at, (int, float)):
        return max(0, int(time.time() - started_at))
    return 0


def public_state(state: dict) -> dict:
    public = dict(state)
    public.pop("input_path", None)
    public.pop("started_at", None)
    public["elapsed_seconds"] = elapsed_seconds_for(state)
    public.setdefault("stage", "queued")
    public["stems"] = {
        name: f"/api/jobs/{state['id']}/files/{Path(path).name}"
        for name, path in state.get("stems", {}).items()
    }
    return public


def finish_timing(state: dict) -> int:
    started_at = state.get("started_at")
    if isinstance(started_at, (int, float)):
        return max(0, int(time.time() - started_at))
    return int(state.get("elapsed_seconds", 0) or 0)


def extract_demucs_percent(line: str) -> int | None:
    match = re.search(r"(?<!\d)(\d{1,3})%\|", line)
    if not match:
        match = re.search(r"(?<!\d)(\d{1,3})%", line)
    if not match:
        return None
    return max(0, min(100, int(match.group(1))))


def run_demucs_with_progress(job_id: str, command: list[str]) -> tuple[int, str]:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    if process.stdout is None:
        raise RuntimeError("تعذر قراءة مخرجات محرك Demucs.")

    tail: deque[str] = deque(maxlen=40)
    buffer = ""
    last_mapped_progress = 24
    last_demucs_percent = -1

    def handle_line(raw_line: str) -> None:
        nonlocal last_mapped_progress, last_demucs_percent
        line = raw_line.strip()
        if not line:
            return
        tail.append(line)
        print(f"[demucs:{job_id}] {line}", flush=True)
        demucs_percent = extract_demucs_percent(line)
        if demucs_percent is None or demucs_percent <= last_demucs_percent:
            return
        last_demucs_percent = demucs_percent
        mapped_progress = min(88, 25 + round(demucs_percent * 0.63))
        if mapped_progress <= last_mapped_progress:
            return
        last_mapped_progress = mapped_progress
        update_state(
            job_id,
            status="processing",
            stage="separating",
            progress=mapped_progress,
            message=f"جاري فصل المسارات وتحليل الصوت — تقدم المحرك {demucs_percent}%.",
        )

    while True:
        char = process.stdout.read(1)
        if char == "":
            if process.poll() is not None:
                break
            time.sleep(0.05)
            continue
        if char in "\r\n":
            handle_line(buffer)
            buffer = ""
        else:
            buffer += char
    if buffer:
        handle_line(buffer)
    return_code = process.wait()
    return return_code, "\n".join(tail)


def run_separation(job_id: str) -> None:
    print(f"[worker] starting job {job_id}", flush=True)
    try:
        state = read_state(job_id)
        input_path = Path(state["input_path"])
        if not input_path.exists():
            raise RuntimeError("الملف الأصلي للمهمة غير موجود.")

        started_at = time.time()
        output_root = job_dir(job_id) / "demucs"
        exports_dir = job_dir(job_id) / "stems"
        exports_dir.mkdir(parents=True, exist_ok=True)

        update_state(
            job_id,
            status="processing",
            stage="loading_model",
            progress=10,
            started_at=started_at,
            elapsed_seconds=0,
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
            stage="separating",
            progress=25,
            message="بدأ تحليل الصوت وفصل المسارات. سيظهر التقدم تلقائياً أثناء المعالجة...",
        )
        print(f"[worker] running Demucs for {job_id}: {' '.join(command)}", flush=True)
        return_code, output_tail = run_demucs_with_progress(job_id, command)
        print(f"[worker] Demucs exit code for {job_id}: {return_code}", flush=True)
        if return_code != 0:
            raise RuntimeError(output_tail or "Demucs exited with an unknown error")

        update_state(
            job_id,
            stage="finalizing",
            progress=90,
            message="اكتمل تحليل الصوت، ويتم الآن تجهيز ملفات المسارات للمعاينة والتحميل...",
        )
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

        final_state = read_state(job_id)
        update_state(
            job_id,
            status="completed",
            stage="completed",
            progress=100,
            elapsed_seconds=finish_timing(final_state),
            message="اكتملت عملية الفصل بنجاح.",
            stems=stems,
            error=None,
        )
        print(f"[worker] completed job {job_id}", flush=True)
    except Exception as exc:
        print(f"[worker] job {job_id} failed: {exc}", flush=True)
        try:
            failure_state = read_state(job_id)
            update_state(
                job_id,
                status="failed",
                stage="failed",
                progress=100,
                elapsed_seconds=finish_timing(failure_state),
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
            failure_state = read_state(job_id)
            update_state(
                job_id,
                status="failed",
                stage="failed",
                progress=100,
                elapsed_seconds=finish_timing(failure_state),
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
                stage="queued",
                progress=6,
                started_at=None,
                elapsed_seconds=0,
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
        "auth_configured": auth_configured(),
        "api_version": "0.3.0",
    }


@app.post("/api/jobs", response_model=JobResponse, status_code=202)
async def create_job(
    file: UploadFile = File(...),
    mode: Literal["2stems", "4stems"] = Form("4stems"),
    _username: str = Depends(require_auth),
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
                raise HTTPException(status_code=413, detail=f"الحد الأعلى لحجم الملف هو {MAX_UPLOAD_MB} MB.")
            output.write(chunk)
    await file.close()

    state = {
        "id": job_id,
        "original_name": original_name,
        "mode": mode,
        "status": "queued",
        "stage": "queued",
        "progress": 5,
        "message": "تم رفع الملف وإضافته إلى قائمة المعالجة.",
        "input_path": str(input_path),
        "started_at": None,
        "elapsed_seconds": 0,
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
            stage="failed",
            progress=100,
            message="تعذر تشغيل عامل معالجة الصوت.",
            error=str(exc)[-4000:],
        )
        raise HTTPException(status_code=500, detail="تعذر تشغيل عامل معالجة الصوت.") from exc
    return JobResponse(**public_state(read_state(job_id)))


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str, _username: str = Depends(require_auth)) -> JobResponse:
    return JobResponse(**public_state(read_state(job_id)))


@app.get("/api/jobs/{job_id}/files/{filename}")
def get_stem(job_id: str, filename: str, _username: str = Depends(require_auth)) -> FileResponse:
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
