from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .main import require_auth
from . import video_tools_v12 as v12
from . import video_tools_v20_runtime as v20runtime

router = APIRouter(prefix="/api/video/v21", tags=["video-studio-v21"])
V20 = v20runtime.base

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
ORCHESTRATOR_DIR = DATA_DIR / "video_orchestrator"
PROJECTS_DIR = ORCHESTRATOR_DIR / "projects"
TEMPLATES_PATH = ORCHESTRATOR_DIR / "templates.json"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

_PRIORITY = {"low": 10, "normal": 20, "high": 30, "urgent": 40}
_DELIVERIES = set(V20.PRESETS.keys())
_LOCK = threading.RLock()
_WAKE = threading.Event()
_DISPATCHER_STARTED = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def _project_path(project_id: str) -> Path:
    return _project_dir(project_id) / "project.json"


def _read_project(project_id: str) -> dict:
    path = _project_path(project_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="مشروع Orchestrator غير موجود.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="تعذر قراءة مشروع Orchestrator.") from exc


def _write_project(project_id: str, state: dict) -> None:
    folder = _project_dir(project_id)
    folder.mkdir(parents=True, exist_ok=True)
    state["updatedAt"] = _now()
    temp = folder / "project.json.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(_project_path(project_id))


def _read_templates() -> list[dict]:
    if not TEMPLATES_PATH.exists():
        return []
    try:
        value = json.loads(TEMPLATES_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except Exception:
        return []


def _write_templates(items: list[dict]) -> None:
    ORCHESTRATOR_DIR.mkdir(parents=True, exist_ok=True)
    temp = TEMPLATES_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(items[:40], ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(TEMPLATES_PATH)


def _preset_config(preset: str) -> dict:
    if preset not in V20.PIPELINE_PRESETS or preset.startswith("__v21_"):
        raise HTTPException(status_code=400, detail="Production Preset غير مدعوم.")
    return dict(V20.PIPELINE_PRESETS[preset])


def _normalize_template(payload: dict, existing_id: str | None = None) -> dict:
    base_preset = str(payload.get("basePreset") or "youtube_creator")
    base = _preset_config(base_preset)
    name = str(payload.get("name") or base.get("label") or "Custom Pipeline").strip()[:80]
    if not name:
        name = "Custom Pipeline"
    delivery = str(payload.get("delivery") or base.get("delivery") or "youtube_1080")
    if delivery not in _DELIVERIES:
        delivery = str(base.get("delivery") or "youtube_1080")
    stabilize = str(payload.get("stabilize") if payload.get("stabilize") is not None else base.get("stabilize", "auto"))
    if stabilize not in {"auto", "off"}:
        stabilize = "auto"
    reframe_raw = payload.get("reframe", base.get("reframe"))
    reframe = str(reframe_raw) if reframe_raw in {"portrait", "square"} else None
    language = str(payload.get("language") or "ar")[:12]
    try:
        threshold = max(.08, min(.85, float(payload.get("sceneThreshold", .35))))
    except (TypeError, ValueError):
        threshold = .35
    try:
        highlight_duration = max(5.0, min(120.0, float(payload.get("highlightDuration", base.get("highlightDuration", 45)))))
    except (TypeError, ValueError):
        highlight_duration = float(base.get("highlightDuration", 45))
    config = {
        "label": name,
        "description": str(payload.get("description") or f"Custom template based on {base.get('label', base_preset)}")[:300],
        "delivery": delivery,
        "productionAnalysis": bool(payload.get("productionAnalysis", base.get("productionAnalysis", True))),
        "highlight": bool(payload.get("highlight", base.get("highlight", False))),
        "stabilize": stabilize,
        "dialogue": bool(payload.get("dialogue", base.get("dialogue", True))),
        "transcribe": bool(payload.get("transcribe", base.get("transcribe", False))),
        "burnCaptions": bool(payload.get("burnCaptions", base.get("burnCaptions", False))),
        "reframe": reframe,
        "highlightDuration": highlight_duration,
    }
    return {
        "id": existing_id or uuid.uuid4().hex[:12],
        "name": name,
        "basePreset": base_preset,
        "language": language,
        "sceneThreshold": threshold,
        "config": config,
        "createdAt": str(payload.get("createdAt") or _now()),
        "updatedAt": _now(),
    }


def _template_by_id(template_id: str | None) -> dict | None:
    if not template_id:
        return None
    return next((item for item in _read_templates() if item.get("id") == template_id), None)


def _child_public(item: dict) -> dict | None:
    child_id = item.get("childJobId")
    if not child_id:
        return None
    try:
        state = V20._read_state(str(child_id))
        return V20._public_state(state)
    except Exception:
        return None


def _public_item(item: dict) -> dict:
    output = {
        "id": item.get("id"),
        "sourceName": item.get("sourceName"),
        "sizeBytes": item.get("sizeBytes"),
        "status": item.get("status"),
        "attempts": item.get("attempts", 0),
        "error": item.get("error"),
        "createdAt": item.get("createdAt"),
        "startedAt": item.get("startedAt"),
        "finishedAt": item.get("finishedAt"),
        "childJobId": item.get("childJobId"),
        "resultReady": bool(item.get("resultReady")),
        "reportReady": bool(item.get("reportReady")),
        "captionsReady": bool(item.get("captionsReady")),
        "progress": item.get("progress", 0),
        "stage": item.get("stage"),
        "message": item.get("message"),
    }
    child = _child_public(item)
    if child and item.get("status") == "processing":
        output.update(
            progress=child.get("progress", output["progress"]),
            stage=child.get("stage", output["stage"]),
            message=child.get("message", output["message"]),
            resultReady=child.get("resultReady", False),
            reportReady=child.get("reportReady", False),
            captionsReady=child.get("captionsReady", False),
        )
    return output


def _stats(items: list[dict]) -> dict:
    statuses = [str(item.get("status")) for item in items]
    total = len(items)
    terminal = sum(1 for value in statuses if value in {"done", "failed", "cancelled"})
    return {
        "total": total,
        "queued": statuses.count("queued"),
        "processing": statuses.count("processing"),
        "done": statuses.count("done"),
        "failed": statuses.count("failed"),
        "cancelled": statuses.count("cancelled"),
        "progress": round((terminal / total) * 100) if total else 0,
    }


def _public_project(state: dict) -> dict:
    items = [_public_item(item) for item in state.get("items", [])]
    return {
        "id": state.get("id"),
        "name": state.get("name"),
        "status": state.get("status"),
        "priority": state.get("priority"),
        "pauseRequested": bool(state.get("pauseRequested")),
        "preset": state.get("preset"),
        "presetLabel": state.get("presetLabel"),
        "templateId": state.get("templateId"),
        "templateName": state.get("templateName"),
        "createdAt": state.get("createdAt"),
        "updatedAt": state.get("updatedAt"),
        "startedAt": state.get("startedAt"),
        "finishedAt": state.get("finishedAt"),
        "settings": state.get("settings"),
        "stats": _stats(items),
        "items": items,
    }


def _source_suffix(name: str) -> str:
    suffix = Path(name).suffix.lower()
    return suffix if suffix and len(suffix) <= 10 else ".mp4"


def _prepare_child(project: dict, item: dict) -> str:
    child_id = uuid.uuid4().hex
    child_folder = V20._job_dir(child_id)
    child_folder.mkdir(parents=True, exist_ok=False)
    source = _project_dir(project["id"]) / str(item["sourceFile"])
    suffix = _source_suffix(str(item.get("sourceName") or source.name))
    child_rel = f"input/source{suffix}"
    target = child_folder / child_rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)

    dynamic_preset = f"__v21_{child_id}"
    config = dict(project["pipelineConfig"])
    V20.PIPELINE_PRESETS[dynamic_preset] = config
    settings = project.get("settings") or {}
    child_state = {
        "id": child_id,
        "name": f"{project['name']} · {item.get('sourceName', 'Source')}",
        "preset": dynamic_preset,
        "presetLabel": project.get("templateName") or project.get("presetLabel") or config.get("label"),
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "message": "تم إرسال العنصر من Creator V21 إلى V20 Pipeline Engine.",
        "error": None,
        "createdAt": _now(),
        "startedAt": None,
        "finishedAt": None,
        "resultReady": False,
        "reportReady": False,
        "captionsReady": False,
        "sourceFile": child_rel,
        "language": str(settings.get("language") or "ar")[:12],
        "sceneThreshold": max(.08, min(.85, float(settings.get("sceneThreshold", .35)))),
        "highlightDuration": max(5.0, min(120.0, float(settings.get("highlightDuration", config.get("highlightDuration", 45))))),
        "steps": [],
        "managedBy": "v21",
        "parentProjectId": project["id"],
        "parentItemId": item["id"],
    }
    V20._write_state(child_id, child_state)
    return child_id


def _finalize_project(state: dict) -> None:
    items = state.get("items", [])
    statuses = [item.get("status") for item in items]
    if any(value in {"queued", "processing"} for value in statuses):
        state["status"] = "queued"
        return
    if statuses and all(value == "done" for value in statuses):
        state["status"] = "done"
    elif statuses and all(value in {"failed", "cancelled"} for value in statuses):
        state["status"] = "failed"
    else:
        state["status"] = "partial"
    state["finishedAt"] = _now()


def _process_one(project_id: str) -> None:
    with _LOCK:
        state = _read_project(project_id)
        if state.get("pauseRequested"):
            state["status"] = "paused"
            _write_project(project_id, state)
            return
        item = next((value for value in state.get("items", []) if value.get("status") == "queued"), None)
        if item is None:
            _finalize_project(state)
            _write_project(project_id, state)
            return
        state["status"] = "processing"
        state["startedAt"] = state.get("startedAt") or _now()
        item["status"] = "processing"
        item["startedAt"] = _now()
        item["finishedAt"] = None
        item["error"] = None
        item["attempts"] = int(item.get("attempts", 0)) + 1
        item["progress"] = 1
        item["stage"] = "handoff"
        item["message"] = "تجهيز العنصر لمحرك V20."
        _write_project(project_id, state)

    child_id = None
    dynamic_key = None
    try:
        child_id = _prepare_child(state, item)
        dynamic_key = f"__v21_{child_id}"
        with _LOCK:
            state = _read_project(project_id)
            current_item = next(value for value in state["items"] if value["id"] == item["id"])
            current_item["childJobId"] = child_id
            current_item["stage"] = "pipeline"
            current_item["message"] = "V20 Production Pipeline قيد التنفيذ."
            _write_project(project_id, state)

        V20._run_pipeline(child_id)
        child = V20._read_state(child_id)
        with _LOCK:
            state = _read_project(project_id)
            current_item = next(value for value in state["items"] if value["id"] == item["id"])
            current_item.update(
                status="done" if child.get("status") == "done" else "failed",
                progress=100,
                stage=child.get("stage"),
                message=child.get("message"),
                error=child.get("error"),
                finishedAt=_now(),
                resultReady=bool(child.get("resultReady")),
                reportReady=bool(child.get("reportReady")),
                captionsReady=bool(child.get("captionsReady")),
            )
            if state.get("pauseRequested"):
                state["status"] = "paused"
            else:
                _finalize_project(state)
            _write_project(project_id, state)
    except Exception as exc:
        with _LOCK:
            try:
                state = _read_project(project_id)
                current_item = next(value for value in state["items"] if value["id"] == item["id"])
                current_item.update(status="failed", progress=100, stage="failed", message="فشل العنصر.", error=str(exc)[:2000], finishedAt=_now())
                if state.get("pauseRequested"):
                    state["status"] = "paused"
                else:
                    _finalize_project(state)
                _write_project(project_id, state)
            except Exception:
                pass
    finally:
        if dynamic_key:
            V20.PIPELINE_PRESETS.pop(dynamic_key, None)
        _WAKE.set()


def _queued_projects() -> list[dict]:
    items: list[dict] = []
    for path in PROJECTS_DIR.glob("*/project.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("status") == "queued" and not state.get("pauseRequested"):
                items.append(state)
        except Exception:
            continue
    items.sort(key=lambda item: (-_PRIORITY.get(str(item.get("priority")), 20), str(item.get("createdAt", ""))))
    return items


def _dispatch_loop() -> None:
    while True:
        project = None
        with _LOCK:
            queued = _queued_projects()
            if queued:
                project = queued[0]
        if project:
            _process_one(str(project["id"]))
            continue
        _WAKE.wait(2.0)
        _WAKE.clear()


def _recover_projects() -> None:
    for path in PROJECTS_DIR.glob("*/project.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            changed = False
            if state.get("status") in {"processing", "pausing"}:
                state["status"] = "paused" if state.get("pauseRequested") else "queued"
                changed = True
            for item in state.get("items", []):
                if item.get("status") == "processing":
                    child_id = item.get("childJobId")
                    if child_id:
                        shutil.rmtree(V20._job_dir(str(child_id)), ignore_errors=True)
                    item.update(status="queued", childJobId=None, progress=0, stage="queued", message="أعيدت جدولة العنصر بعد إعادة تشغيل الخدمة.", error=None, startedAt=None, finishedAt=None, resultReady=False, reportReady=False, captionsReady=False)
                    changed = True
            if changed:
                _write_project(str(state["id"]), state)
        except Exception as exc:
            print(f"[v21] recovery skipped {path}: {exc}", flush=True)


def _start_dispatcher() -> None:
    global _DISPATCHER_STARTED
    with _LOCK:
        if _DISPATCHER_STARTED:
            return
        _DISPATCHER_STARTED = True
        thread = threading.Thread(target=_dispatch_loop, name="video-v21-orchestrator", daemon=True)
        thread.start()


def _overview() -> dict:
    projects = []
    for path in PROJECTS_DIR.glob("*/project.json"):
        try:
            projects.append(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            continue
    statuses = [str(item.get("status")) for item in projects]
    v20_jobs = 0
    for path in V20.PIPELINE_DIR.glob("*/job.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("managedBy") != "v21":
                v20_jobs += 1
        except Exception:
            continue
    v12_jobs = sum(1 for _ in v12.QUEUE_DIR.glob("*/job.json"))
    return {
        "projects": len(projects),
        "queued": statuses.count("queued"),
        "processing": statuses.count("processing") + statuses.count("pausing"),
        "paused": statuses.count("paused"),
        "done": statuses.count("done"),
        "partial": statuses.count("partial"),
        "failed": statuses.count("failed"),
        "legacy": {"v20Jobs": v20_jobs, "v12RenderJobs": v12_jobs},
        "storage": str(ORCHESTRATOR_DIR),
        "pauseSemantics": "finish-current-item-then-pause",
    }


@router.get("/info")
async def info_v21(_username: str = Depends(require_auth)) -> dict:
    presets = [
        {"id": key, **value}
        for key, value in V20.PIPELINE_PRESETS.items()
        if not key.startswith("__v21_")
    ]
    return {
        "presets": presets,
        "templates": _read_templates(),
        "priorities": list(_PRIORITY.keys()),
        "deliveries": sorted(_DELIVERIES),
        "overview": _overview(),
    }


@router.post("/templates")
async def create_template_v21(payload: dict = Body(...), _username: str = Depends(require_auth)) -> dict:
    item = _normalize_template(payload)
    with _LOCK:
        items = _read_templates()
        items.insert(0, item)
        _write_templates(items)
    return item


@router.put("/templates/{template_id}")
async def update_template_v21(template_id: str, payload: dict = Body(...), _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        items = _read_templates()
        old = next((item for item in items if item.get("id") == template_id), None)
        if old is None:
            raise HTTPException(status_code=404, detail="Preset Template غير موجود.")
        merged = {**old, **payload, "createdAt": old.get("createdAt")}
        updated = _normalize_template(merged, existing_id=template_id)
        items = [updated if item.get("id") == template_id else item for item in items]
        _write_templates(items)
    return updated


@router.delete("/templates/{template_id}")
async def delete_template_v21(template_id: str, _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        items = _read_templates()
        next_items = [item for item in items if item.get("id") != template_id]
        if len(next_items) == len(items):
            raise HTTPException(status_code=404, detail="Preset Template غير موجود.")
        _write_templates(next_items)
    return {"ok": True, "id": template_id}


@router.post("/projects")
async def create_project_v21(
    files: list[UploadFile] = File(...),
    project_name: str = Form("MAGHRABI Production Batch"),
    preset: str = Form("youtube_creator"),
    template_id: str | None = Form(None),
    priority: str = Form("normal"),
    language: str = Form("ar"),
    scene_threshold: float = Form(.35),
    highlight_duration: float = Form(45),
    _username: str = Depends(require_auth),
) -> dict:
    if not files:
        raise HTTPException(status_code=400, detail="أضف ملف فيديو واحدًا على الأقل.")
    if len(files) > 20:
        raise HTTPException(status_code=400, detail="الحد الأقصى للدفعة الواحدة 20 ملف فيديو.")
    if priority not in _PRIORITY:
        priority = "normal"
    template = _template_by_id(template_id)
    if template_id and template is None:
        raise HTTPException(status_code=404, detail="Preset Template غير موجود.")
    if template:
        preset = str(template.get("basePreset") or preset)
        pipeline_config = dict(template["config"])
        settings = {
            "language": str(template.get("language") or language)[:12],
            "sceneThreshold": float(template.get("sceneThreshold", scene_threshold)),
            "highlightDuration": float(template["config"].get("highlightDuration", highlight_duration)),
        }
        preset_label = str(pipeline_config.get("label") or template.get("name"))
    else:
        pipeline_config = _preset_config(preset)
        settings = {
            "language": (language or "ar")[:12],
            "sceneThreshold": max(.08, min(.85, scene_threshold)),
            "highlightDuration": max(5.0, min(120.0, highlight_duration)),
        }
        preset_label = str(pipeline_config.get("label") or preset)

    project_id = uuid.uuid4().hex
    folder = _project_dir(project_id)
    folder.mkdir(parents=True, exist_ok=False)
    items: list[dict] = []
    try:
        for index, upload in enumerate(files):
            suffix = _source_suffix(upload.filename or "source.mp4")
            item_id = uuid.uuid4().hex[:12]
            rel = f"sources/{index:02d}-{item_id}{suffix}"
            destination = folder / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            size = 0
            with destination.open("wb") as handle:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    size += len(chunk)
            await upload.close()
            items.append({
                "id": item_id,
                "sourceFile": rel,
                "sourceName": upload.filename or f"video-{index + 1}{suffix}",
                "sizeBytes": size,
                "status": "queued",
                "attempts": 0,
                "error": None,
                "childJobId": None,
                "createdAt": _now(),
                "startedAt": None,
                "finishedAt": None,
                "resultReady": False,
                "reportReady": False,
                "captionsReady": False,
                "progress": 0,
                "stage": "queued",
                "message": "بانتظار Orchestrator.",
            })
        state = {
            "id": project_id,
            "name": (project_name or "MAGHRABI Production Batch")[:120],
            "status": "queued",
            "priority": priority,
            "pauseRequested": False,
            "preset": preset,
            "presetLabel": preset_label,
            "templateId": template.get("id") if template else None,
            "templateName": template.get("name") if template else None,
            "pipelineConfig": pipeline_config,
            "settings": settings,
            "createdAt": _now(),
            "updatedAt": _now(),
            "startedAt": None,
            "finishedAt": None,
            "items": items,
        }
        _write_project(project_id, state)
        _WAKE.set()
        return _public_project(state)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@router.get("/projects")
async def projects_v21(_username: str = Depends(require_auth)) -> dict:
    items = []
    for path in PROJECTS_DIR.glob("*/project.json"):
        try:
            items.append(_public_project(json.loads(path.read_text(encoding="utf-8"))))
        except Exception:
            continue
    items.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
    return {"projects": items[:100], "overview": _overview()}


@router.get("/projects/{project_id}")
async def project_v21(project_id: str, _username: str = Depends(require_auth)) -> dict:
    return _public_project(_read_project(project_id))


@router.post("/projects/{project_id}/pause")
async def pause_project_v21(project_id: str, _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_project(project_id)
        if state.get("status") in {"done", "failed", "partial"}:
            raise HTTPException(status_code=409, detail="المشروع منتهٍ ولا يحتاج Pause.")
        state["pauseRequested"] = True
        state["status"] = "pausing" if any(item.get("status") == "processing" for item in state.get("items", [])) else "paused"
        _write_project(project_id, state)
    return _public_project(state)


@router.post("/projects/{project_id}/resume")
async def resume_project_v21(project_id: str, _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_project(project_id)
        if not any(item.get("status") == "queued" for item in state.get("items", [])):
            raise HTTPException(status_code=409, detail="لا توجد عناصر معلقة لاستئنافها.")
        state["pauseRequested"] = False
        state["status"] = "queued"
        state["finishedAt"] = None
        _write_project(project_id, state)
    _WAKE.set()
    return _public_project(state)


@router.post("/projects/{project_id}/priority")
async def priority_project_v21(project_id: str, priority: str = Form(...), _username: str = Depends(require_auth)) -> dict:
    if priority not in _PRIORITY:
        raise HTTPException(status_code=400, detail="الأولوية غير مدعومة.")
    with _LOCK:
        state = _read_project(project_id)
        state["priority"] = priority
        _write_project(project_id, state)
    _WAKE.set()
    return _public_project(state)


@router.post("/projects/{project_id}/items/{item_id}/retry")
async def retry_item_v21(project_id: str, item_id: str, _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_project(project_id)
        item = next((value for value in state.get("items", []) if value.get("id") == item_id), None)
        if item is None:
            raise HTTPException(status_code=404, detail="عنصر الدفعة غير موجود.")
        if item.get("status") == "processing":
            raise HTTPException(status_code=409, detail="العنصر قيد التنفيذ حاليًا.")
        old_child = item.get("childJobId")
        if old_child:
            shutil.rmtree(V20._job_dir(str(old_child)), ignore_errors=True)
        item.update(status="queued", childJobId=None, error=None, startedAt=None, finishedAt=None, resultReady=False, reportReady=False, captionsReady=False, progress=0, stage="queued", message="أعيد العنصر إلى Orchestrator.")
        state["pauseRequested"] = False
        state["status"] = "queued"
        state["finishedAt"] = None
        _write_project(project_id, state)
    _WAKE.set()
    return _public_project(state)


def _item_path(project_id: str, item_id: str, kind: str) -> tuple[dict, Path]:
    state = _read_project(project_id)
    item = next((value for value in state.get("items", []) if value.get("id") == item_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="عنصر الدفعة غير موجود.")
    if kind == "source":
        return item, _project_dir(project_id) / str(item["sourceFile"])
    child_id = item.get("childJobId")
    if not child_id:
        raise HTTPException(status_code=409, detail="لا توجد نتيجة معالجة لهذا العنصر بعد.")
    names = {"result": "result.mp4", "report": "report.json", "captions": "captions.srt"}
    return item, V20._job_dir(str(child_id)) / names[kind]


@router.get("/projects/{project_id}/items/{item_id}/source")
async def source_item_v21(project_id: str, item_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    item, path = _item_path(project_id, item_id, "source")
    if not path.exists():
        raise HTTPException(status_code=404, detail="ملف المصدر غير موجود.")
    return FileResponse(path, media_type="video/mp4", filename=str(item.get("sourceName") or path.name))


@router.get("/projects/{project_id}/items/{item_id}/result")
async def result_item_v21(project_id: str, item_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    item, path = _item_path(project_id, item_id, "result")
    if not path.exists():
        raise HTTPException(status_code=409, detail="نتيجة العنصر غير جاهزة.")
    return FileResponse(path, media_type="video/mp4", filename=f"MAGHRABI-v21-{item_id}.mp4")


@router.get("/projects/{project_id}/items/{item_id}/report")
async def report_item_v21(project_id: str, item_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    _item, path = _item_path(project_id, item_id, "report")
    if not path.exists():
        raise HTTPException(status_code=409, detail="تقرير العنصر غير جاهز.")
    return FileResponse(path, media_type="application/json", filename=f"MAGHRABI-v21-report-{item_id}.json")


@router.get("/projects/{project_id}/items/{item_id}/captions")
async def captions_item_v21(project_id: str, item_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    _item, path = _item_path(project_id, item_id, "captions")
    if not path.exists():
        raise HTTPException(status_code=404, detail="لا يوجد ملف Captions لهذا العنصر.")
    return FileResponse(path, media_type="text/plain; charset=utf-8", filename=f"MAGHRABI-v21-captions-{item_id}.srt")


@router.delete("/projects/{project_id}")
async def delete_project_v21(project_id: str, _username: str = Depends(require_auth)) -> dict:
    with _LOCK:
        state = _read_project(project_id)
        if any(item.get("status") == "processing" for item in state.get("items", [])):
            raise HTTPException(status_code=409, detail="لا يمكن حذف مشروع أثناء معالجة عنصر. استخدم Pause وانتظر اكتمال العنصر الجاري.")
        for item in state.get("items", []):
            child_id = item.get("childJobId")
            if child_id:
                shutil.rmtree(V20._job_dir(str(child_id)), ignore_errors=True)
        shutil.rmtree(_project_dir(project_id), ignore_errors=True)
    return {"ok": True, "id": project_id}


_recover_projects()
_start_dispatcher()
_WAKE.set()
