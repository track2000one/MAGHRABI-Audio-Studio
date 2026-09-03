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

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .main import require_auth
from .video_tools import _duration, _has_audio, _probe, _run_ffmpeg
from . import video_tools_v15_safe as v15safe
from . import video_tools_v16 as v16
from . import video_tools_v17 as v17
from . import video_tools_v19 as v19
from . import video_tools_v19_runtime as v19runtime
from .video_tools_v14 import PRESETS, _run_loudness, _validate_audio, _validate_grade
from .video_tools_v18 import _stt_capability, _stt_request

router = APIRouter(prefix="/api/video/v20", tags=["video-studio-v20"])

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
PIPELINE_DIR = DATA_DIR / "video_pipeline_queue"
PIPELINE_DIR.mkdir(parents=True, exist_ok=True)

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-v20-pipeline")
_LOCK = threading.Lock()
_SCHEDULED: set[str] = set()

V15 = v15safe.base

PIPELINE_PRESETS: dict[str, dict] = {
    "youtube_creator": {
        "label": "YouTube Creator",
        "description": "تحليل المشاهد، تثبيت تلقائي عند الحاجة، تنظيف الحوار، Auto Color، STT اختياري، Master YouTube وQC.",
        "delivery": "youtube_1080",
        "productionAnalysis": True,
        "highlight": False,
        "stabilize": "auto",
        "dialogue": True,
        "transcribe": True,
        "burnCaptions": False,
        "reframe": None,
        "highlightDuration": 45,
    },
    "short_reel": {
        "label": "Short Reel",
        "description": "اختيار Highlights، تثبيت تلقائي، تنظيف الحوار، 9:16 Reframe، Captions تلقائية عند توفر STT، وتسليم TikTok/Reel.",
        "delivery": "tiktok",
        "productionAnalysis": True,
        "highlight": True,
        "stabilize": "auto",
        "dialogue": True,
        "transcribe": True,
        "burnCaptions": True,
        "reframe": "portrait",
        "highlightDuration": 45,
    },
    "interview": {
        "label": "Interview",
        "description": "يحافظ على التسلسل الكامل مع تنظيف الحوار، Auto Color، STT عربي اختياري، Master 1080p وQC.",
        "delivery": "youtube_1080",
        "productionAnalysis": True,
        "highlight": False,
        "stabilize": "auto",
        "dialogue": True,
        "transcribe": True,
        "burnCaptions": False,
        "reframe": None,
        "highlightDuration": 60,
    },
    "sports_highlight": {
        "label": "Sports Highlight",
        "description": "Scene + motion/audio scoring، Highlight Reel تلقائي، تثبيت عند الحاجة، Auto Color وتسليم 1080p.",
        "delivery": "youtube_1080",
        "productionAnalysis": True,
        "highlight": True,
        "stabilize": "auto",
        "dialogue": False,
        "transcribe": False,
        "burnCaptions": False,
        "reframe": None,
        "highlightDuration": 60,
    },
    "podcast_video": {
        "label": "Podcast Video",
        "description": "تنظيف صوت قوي، STT عربي اختياري، Captions عند توفر Worker، Auto Color وتسليم YouTube 1080p.",
        "delivery": "youtube_1080",
        "productionAnalysis": False,
        "highlight": False,
        "stabilize": "off",
        "dialogue": True,
        "transcribe": True,
        "burnCaptions": True,
        "reframe": None,
        "highlightDuration": 60,
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _job_dir(job_id: str) -> Path:
    return PIPELINE_DIR / job_id


def _state_path(job_id: str) -> Path:
    return _job_dir(job_id) / "job.json"


def _read_state(job_id: str) -> dict:
    path = _state_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="مهمة Production Pipeline غير موجودة.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="تعذر قراءة حالة Production Pipeline.") from exc


def _write_state(job_id: str, state: dict) -> None:
    folder = _job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    temp = folder / "job.json.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(_state_path(job_id))


def _public_state(state: dict) -> dict:
    return {
        "id": state.get("id"),
        "name": state.get("name"),
        "preset": state.get("preset"),
        "presetLabel": state.get("presetLabel"),
        "status": state.get("status"),
        "stage": state.get("stage"),
        "progress": state.get("progress", 0),
        "message": state.get("message"),
        "error": state.get("error"),
        "createdAt": state.get("createdAt"),
        "startedAt": state.get("startedAt"),
        "finishedAt": state.get("finishedAt"),
        "resultReady": bool(state.get("resultReady")),
        "reportReady": bool(state.get("reportReady")),
        "captionsReady": bool(state.get("captionsReady")),
        "steps": state.get("steps", []),
        "source": state.get("source"),
        "output": state.get("output"),
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


def _step(state: dict, job_id: str, step_id: str, label: str, status: str, progress: int, message: str, details: dict | None = None) -> None:
    steps = state.setdefault("steps", [])
    item = next((value for value in steps if value.get("id") == step_id), None)
    if item is None:
        item = {"id": step_id, "label": label, "status": "pending", "startedAt": None, "finishedAt": None, "message": None}
        steps.append(item)
    if status == "running" and not item.get("startedAt"):
        item["startedAt"] = _now()
    if status in {"done", "skipped", "warning", "failed"}:
        item["finishedAt"] = _now()
    item.update(status=status, message=message)
    if details is not None:
        item["details"] = details
    state.update(stage=step_id, progress=progress, message=message)
    _write_state(job_id, state)


def _neutral_grade(suggestion: dict | None) -> dict:
    raw = {
        "brightness": 0,
        "contrast": 1,
        "saturation": 1,
        "gamma": 0,
        "lift": {"r": 0, "g": 0, "b": 0},
        "gammaWheel": {"r": 0, "g": 0, "b": 0},
        "gain": {"r": 0, "g": 0, "b": 0},
        "curves": {
            "r": {"shadows": 0, "mids": 0, "highlights": 0},
            "g": {"shadows": 0, "mids": 0, "highlights": 0},
            "b": {"shadows": 0, "mids": 0, "highlights": 0},
        },
    }
    if suggestion:
        item = suggestion.get("suggestion") or {}
        raw["brightness"] = item.get("brightness", 0)
        raw["contrast"] = item.get("contrast", 1)
        raw["saturation"] = item.get("saturation", 1)
        raw["gammaWheel"] = item.get("gammaWheel", raw["gammaWheel"])
    return _validate_grade(json.dumps(raw))


def _audio_master(preset_name: str, dialogue_cleaned: bool) -> dict:
    preset = PRESETS[preset_name]
    raw = {
        "low": 0,
        "mid": 0,
        "high": 0,
        "compressor": not dialogue_cleaned,
        "thresholdDb": -18,
        "ratio": 3,
        "attack": 20,
        "release": 250,
        "limiter": True,
        "ceilingDb": -1,
        "normalize": True,
        "targetLufs": preset["lufs"],
    }
    return _validate_audio(json.dumps(raw), preset)


def _ensure_sdr(source: Path, destination: Path) -> tuple[Path, dict]:
    info = V15._source_color_info(source)
    if not info.get("isHdr"):
        return source, info
    filters = V15._color_management_filters(info, "auto")
    if not filters:
        raise HTTPException(status_code=501, detail="تعذر إنشاء HDR→SDR filter chain آمنة.")
    probe = _probe(source)
    command = [
        "ffmpeg", "-hide_banner", "-y", "-i", str(source),
        "-vf", ",".join(filters),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    ]
    if _has_audio(probe):
        command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    else:
        command += ["-an"]
    command += ["-movflags", "+faststart", str(destination)]
    _run_ffmpeg(command)
    return destination, V15._source_color_info(destination)


def _dialogue_clean(source: Path, destination: Path) -> tuple[Path, list[str]]:
    probe = _probe(source)
    if not _has_audio(probe):
        return source, []
    filters, used = v16._dialogue_filters()
    _run_ffmpeg([
        "ffmpeg", "-hide_banner", "-y", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
        "-af", ",".join(filters), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", str(destination),
    ])
    return destination, used


def _reframe(source: Path, destination: Path, target: str) -> Path:
    probe = _probe(source)
    duration = _duration(probe)
    width, height = v16._video_dimensions(probe)
    focus = v16._cropdetect_focus(source, duration, width, height)
    out_w, out_h = (1080, 1920) if target == "portrait" else (1080, 1080)
    crop_w, crop_h, crop_x, crop_y = v16._reframe_crop(width, height, focus["focusX"], focus["focusY"], out_w / out_h)
    command = [
        "ffmpeg", "-hide_banner", "-y", "-i", str(source),
        "-vf", f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y},scale={out_w}:{out_h}:flags=lanczos,setsar=1,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
    ]
    if _has_audio(probe):
        command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    else:
        command += ["-an"]
    command += ["-movflags", "+faststart", str(destination)]
    _run_ffmpeg(command)
    return destination


def _write_srt(path: Path, segments: list[dict]) -> int:
    def stamp(seconds: float) -> str:
        safe = max(0.0, float(seconds))
        hours = int(safe // 3600)
        minutes = int((safe % 3600) // 60)
        secs = int(safe % 60)
        ms = int(round((safe - int(safe)) * 1000))
        if ms >= 1000:
            secs += 1
            ms -= 1000
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"

    cleaned = []
    for item in segments[:500]:
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        start = max(0.0, float(item.get("start", 0)))
        end = max(start + .05, float(item.get("end", start + 1)))
        cleaned.append({"start": start, "end": end, "text": text})
    lines = []
    for index, item in enumerate(cleaned, 1):
        lines.extend([str(index), f"{stamp(item['start'])} --> {stamp(item['end'])}", item["text"], ""])
    path.write_text("\n".join(lines), encoding="utf-8")
    return len(cleaned)


def _transcribe(source: Path, folder: Path, language: str) -> tuple[dict | None, Path | None, str | None]:
    capability = _stt_capability()
    if not capability.get("configured"):
        return None, None, "Speech-to-Text Worker غير مهيأ؛ تم تخطي النسخ التلقائي."
    probe = _probe(source)
    if not _has_audio(probe):
        return None, None, "المصدر بلا صوت؛ تم تخطي Speech-to-Text."
    speech = folder / "speech-for-stt.m4a"
    _run_ffmpeg([
        "ffmpeg", "-hide_banner", "-y", "-i", str(source), "-vn",
        "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", str(speech),
    ])
    data = speech.read_bytes()
    payload = _stt_request(data, "audio/mp4", language[:12])
    segments = payload.get("segments") if isinstance(payload, dict) else None
    if not isinstance(segments, list):
        segments = []
    transcript_path = folder / "transcript.json"
    transcript_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    srt_path = folder / "captions.srt"
    count = _write_srt(srt_path, segments)
    if count < 1:
        srt_path = None
    return payload, srt_path, None


def _burn_captions(source: Path, destination: Path, segments: list[dict], folder: Path) -> tuple[Path, str | None]:
    if not segments:
        return source, "لا توجد Timed Segments لحرق Captions."
    if "subtitles" not in V15._filters_available():
        return source, "فلتر subtitles/libass غير متاح؛ تم الاحتفاظ بملف SRT فقط."
    probe = _probe(source)
    width, height = v17._video_dimensions(probe)
    captions = []
    duration = _duration(probe)
    for item in segments[:240]:
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        start = max(0.0, min(duration, float(item.get("start", 0))))
        end = max(start + .05, min(duration, float(item.get("end", start + 1))))
        captions.append({"start": start, "end": end, "text": text})
    if not captions:
        return source, "لم توجد Captions صالحة للحرق."
    ass = folder / "pipeline-captions.ass"
    v17._write_ass(ass, captions, width, height)
    vf = f"subtitles='{ass}':fontsdir='/usr/share/fonts/truetype/dejavu'"
    command = [
        "ffmpeg", "-hide_banner", "-y", "-i", str(source), "-vf", vf,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    ]
    if _has_audio(probe):
        command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    else:
        command += ["-an"]
    command += ["-movflags", "+faststart", str(destination)]
    _run_ffmpeg(command)
    return destination, None


def _run_pipeline(job_id: str) -> None:
    state = _read_state(job_id)
    folder = _job_dir(job_id)
    source = folder / state["sourceFile"]
    config = PIPELINE_PRESETS[state["preset"]]
    current = source
    report: dict = {"jobId": job_id, "preset": state["preset"], "presetLabel": config["label"], "createdAt": state.get("createdAt")}
    dialogue_cleaned = False
    transcript_payload: dict | None = None
    srt_path: Path | None = None

    try:
        state.update(status="processing", startedAt=state.get("startedAt") or _now(), error=None, resultReady=False, reportReady=False)
        _write_state(job_id, state)

        _step(state, job_id, "inspect", "Source Inspection", "running", 5, "يتم فحص المصدر وبيانات الألوان والصوت.")
        probe = _probe(current)
        color = V15._source_color_info(current)
        source_meta = {
            "duration": _duration(probe),
            "hasAudio": _has_audio(probe),
            "color": color,
            "sizeBytes": source.stat().st_size,
        }
        state["source"] = source_meta
        report["source"] = source_meta
        _step(state, job_id, "inspect", "Source Inspection", "done", 10, "اكتمل فحص المصدر.", source_meta)

        _step(state, job_id, "color-normalize", "HDR / Color Safety", "running", 14, "التحقق من سلامة Color Management قبل المعالجة.")
        if color.get("isHdr"):
            normalized = folder / "01-sdr-normalized.mp4"
            current, normalized_info = _ensure_sdr(current, normalized)
            report["colorNormalization"] = {"converted": True, "output": normalized_info}
            _step(state, job_id, "color-normalize", "HDR / Color Safety", "done", 20, "تم تحويل HDR إلى Rec.709 SDR بأمان.", normalized_info)
        else:
            report["colorNormalization"] = {"converted": False}
            _step(state, job_id, "color-normalize", "HDR / Color Safety", "skipped", 20, "المصدر SDR؛ لا يحتاج Tone Mapping.")

        analysis = None
        if config["productionAnalysis"]:
            _step(state, job_id, "analysis", "Production Analysis", "running", 24, "تحليل المشاهد والحركة والصوت وتقدير Highlights.")
            analysis = v19._production_analysis(current, float(state.get("sceneThreshold", .35)))
            report["productionAnalysis"] = analysis
            _step(state, job_id, "analysis", "Production Analysis", "done", 30, f"تم تحليل {analysis.get('analyzedCount', 0)} مشهدًا.", {"sceneCount": analysis.get("sceneCount"), "highlightCount": len(analysis.get("highlights") or [])})
        else:
            _step(state, job_id, "analysis", "Production Analysis", "skipped", 30, "هذا الـPreset لا يحتاج Scene/Highlight Analysis.")

        if config["highlight"]:
            _step(state, job_id, "auto-cut", "Auto Cut / Highlight Reel", "running", 34, "اختيار أفضل اللقطات وبناء Highlight Reel.")
            highlight = folder / "02-highlight.mp4"
            meta = v19runtime._render_highlight_reel(current, highlight, float(state.get("sceneThreshold", .35)), float(state.get("highlightDuration") or config["highlightDuration"]))
            current = highlight
            report["highlightReel"] = meta
            _step(state, job_id, "auto-cut", "Auto Cut / Highlight Reel", "done", 40, f"تم بناء Highlight Reel بمدة {meta.get('duration', 0):.1f} ثانية.", {"duration": meta.get("duration"), "segments": len(meta.get("segments") or [])})
        else:
            _step(state, job_id, "auto-cut", "Auto Cut / Highlight Reel", "skipped", 40, "الـPreset يحافظ على التسلسل الكامل.")

        if config["stabilize"] == "auto":
            _step(state, job_id, "stabilize", "Camera Motion / Stabilization", "running", 43, "تحليل حركة الكاميرا وتحديد الحاجة للتثبيت.")
            camera = v19._camera_motion(current)
            report["cameraMotion"] = camera
            if float(camera.get("stability", 1)) < .72:
                stabilized = folder / "03-stabilized.mp4"
                try:
                    engine = v19._stabilize(current, stabilized, .65)
                    current = stabilized
                    _step(state, job_id, "stabilize", "Camera Motion / Stabilization", "done", 49, f"تم تثبيت الفيديو باستخدام {engine}.", {"engine": engine, "stabilityBefore": camera.get("stability")})
                except Exception as exc:
                    report["stabilizationWarning"] = str(exc)
                    _step(state, job_id, "stabilize", "Camera Motion / Stabilization", "warning", 49, "تم اكتشاف اهتزاز، لكن فلتر التثبيت غير متاح أو فشل؛ ستستمر المهمة بدون Stabilization.", {"warning": str(exc)[:500]})
            else:
                _step(state, job_id, "stabilize", "Camera Motion / Stabilization", "skipped", 49, "الكاميرا مستقرة بما يكفي؛ لا حاجة لإعادة الترميز للتثبيت.", {"stability": camera.get("stability")})
        else:
            _step(state, job_id, "stabilize", "Camera Motion / Stabilization", "skipped", 49, "Stabilization معطلة في هذا الـPreset.")

        if config["dialogue"]:
            _step(state, job_id, "dialogue", "Dialogue Cleanup", "running", 52, "تنظيف الحوار وضبط الديناميكية والوضوح.")
            cleaned = folder / "04-dialogue-clean.mp4"
            next_path, filters = _dialogue_clean(current, cleaned)
            if next_path == current:
                _step(state, job_id, "dialogue", "Dialogue Cleanup", "skipped", 58, "المصدر بلا صوت؛ تم تخطي Dialogue Cleanup.")
            else:
                current = next_path
                dialogue_cleaned = True
                report["dialogueFilters"] = filters
                _step(state, job_id, "dialogue", "Dialogue Cleanup", "done", 58, "اكتمل تنظيف الحوار.", {"filters": filters})
        else:
            _step(state, job_id, "dialogue", "Dialogue Cleanup", "skipped", 58, "Dialogue Cleanup غير مطلوبة لهذا الـPreset.")

        if config.get("reframe"):
            _step(state, job_id, "reframe", "Smart Reframe", "running", 61, "تحويل الكادر إلى المقاس المستهدف وفق Active Picture.")
            reframed = folder / "05-reframed.mp4"
            current = _reframe(current, reframed, str(config["reframe"]))
            _step(state, job_id, "reframe", "Smart Reframe", "done", 66, "اكتمل Reframe إلى 9:16." if config["reframe"] == "portrait" else "اكتمل Reframe.")
        else:
            _step(state, job_id, "reframe", "Smart Reframe", "skipped", 66, "لا يحتاج هذا الـPreset إلى تغيير Aspect Ratio قبل Master.")

        if config["transcribe"]:
            _step(state, job_id, "transcribe", "Speech-to-Text", "running", 69, "محاولة النسخ الزمني عبر STT Worker الخارجي.")
            transcript_payload, srt_path, warning = _transcribe(current, folder, str(state.get("language") or "ar"))
            if warning:
                report["transcriptionWarning"] = warning
                _step(state, job_id, "transcribe", "Speech-to-Text", "skipped", 74, warning)
            else:
                segments = transcript_payload.get("segments") if isinstance(transcript_payload, dict) else []
                state["captionsReady"] = bool(srt_path and srt_path.exists())
                report["transcription"] = {"text": transcript_payload.get("text") if isinstance(transcript_payload, dict) else None, "segmentCount": len(segments or [])}
                _step(state, job_id, "transcribe", "Speech-to-Text", "done", 74, f"اكتمل Speech-to-Text مع {len(segments or [])} مقطعًا زمنيًا.")
        else:
            _step(state, job_id, "transcribe", "Speech-to-Text", "skipped", 74, "Speech-to-Text معطلة في هذا الـPreset.")

        if config["burnCaptions"]:
            _step(state, job_id, "captions", "Auto Captions", "running", 76, "تجهيز Captions للتثبيت على الصورة عند توفر Timed Segments.")
            segments = transcript_payload.get("segments") if isinstance(transcript_payload, dict) else []
            captioned = folder / "06-captioned.mp4"
            next_path, warning = _burn_captions(current, captioned, segments if isinstance(segments, list) else [], folder)
            if warning:
                report["captionWarning"] = warning
                _step(state, job_id, "captions", "Auto Captions", "warning", 80, warning)
            else:
                current = next_path
                _step(state, job_id, "captions", "Auto Captions", "done", 80, "تم تثبيت Captions على الفيديو.")
        else:
            _step(state, job_id, "captions", "Auto Captions", "skipped", 80, "Burn Captions غير مفعلة في هذا الـPreset؛ يبقى SRT منفصلًا عند توفره.")

        _step(state, job_id, "master", "Auto Color + Audio Master", "running", 83, "تطبيق Auto Color المحافظ وMastering النهائي حسب منصة التسليم.")
        auto_color = v16._auto_color_suggestion(current)
        grade = _neutral_grade(auto_color)
        preset_name = str(config["delivery"])
        audio = _audio_master(preset_name, dialogue_cleaned)
        secondary = {"enabled": False, "family": "reds", "cyan": 0.0, "magenta": 0.0, "yellow": 0.0, "black": 0.0}
        window = {"enabled": False, "x": .2, "y": .2, "width": .5, "height": .5, "brightness": 0.0, "contrast": 1.0, "saturation": 1.0}
        repair = {"noiseReduction": False, "noiseStrength": .35, "deesser": False, "deesserIntensity": .35, "stereoWidth": 1.0}
        final = folder / "result.mp4"
        V15._run_master(current, final, preset_name, grade, audio, secondary, window, repair, "auto")
        report["autoColor"] = auto_color
        report["deliveryPreset"] = preset_name
        _step(state, job_id, "master", "Auto Color + Audio Master", "done", 92, f"اكتمل Master النهائي: {PRESETS[preset_name]['label']}.")

        _step(state, job_id, "qc", "Final QC", "running", 95, "فحص Black/Freeze/Silence وLoudness للملف النهائي.")
        qc = V15._run_qc(final)
        loudness = None
        if _has_audio(_probe(final)):
            try:
                loudness = _run_loudness(final)
            except Exception as exc:
                report["loudnessWarning"] = str(exc)
        report["qc"] = qc
        report["loudness"] = loudness
        state["output"] = {
            "duration": _duration(_probe(final)),
            "sizeBytes": final.stat().st_size,
            "deliveryPreset": preset_name,
            "qcSummary": qc.get("summary"),
            "loudness": loudness,
        }
        _step(state, job_id, "qc", "Final QC", "done", 99, "اكتمل Final QC.", {"summary": qc.get("summary"), "loudness": loudness})

        report["steps"] = state.get("steps", [])
        report["finishedAt"] = _now()
        (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        state.update(
            status="done",
            stage="done",
            progress=100,
            finishedAt=_now(),
            message="اكتملت Automated Production Pipeline بنجاح.",
            error=None,
            resultReady=True,
            reportReady=True,
            captionsReady=bool(srt_path and srt_path.exists()),
        )
        _write_state(job_id, state)
    except Exception as exc:
        try:
            state = _read_state(job_id)
        except Exception:
            state = {"id": job_id, "steps": []}
        if state.get("stage"):
            steps = state.setdefault("steps", [])
            item = next((value for value in steps if value.get("id") == state.get("stage")), None)
            if item and item.get("status") == "running":
                item.update(status="failed", finishedAt=_now(), message=str(exc)[:1000])
        state.update(
            status="failed",
            progress=100,
            finishedAt=_now(),
            message="فشلت Automated Production Pipeline.",
            error=str(exc)[:2000],
            resultReady=False,
            reportReady=False,
        )
        _write_state(job_id, state)


def _run_job_sync(job_id: str) -> None:
    try:
        _run_pipeline(job_id)
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
    queued = []
    for path in PIPELINE_DIR.glob("*/job.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("status") == "processing":
                state.update(status="queued", stage="queued", progress=0, startedAt=None, finishedAt=None, error=None, message="أعيدت جدولة Pipeline بعد إعادة تشغيل الخدمة.", steps=[])
                _write_state(str(state.get("id")), state)
            if state.get("status") == "queued":
                queued.append(state)
        except Exception as exc:
            print(f"[v20-pipeline] skipped {path}: {exc}", flush=True)
    queued.sort(key=lambda item: str(item.get("createdAt", "")))
    for state in queued:
        if state.get("id"):
            _schedule(str(state["id"]))


@router.get("/presets")
async def presets_v20(_username: str = Depends(require_auth)) -> dict:
    stt = _stt_capability()
    return {
        "presets": [{"id": key, **value} for key, value in PIPELINE_PRESETS.items()],
        "stt": stt,
        "storage": str(PIPELINE_DIR),
    }


@router.post("/queue")
async def queue_v20(
    file: UploadFile = File(...),
    preset: str = Form("youtube_creator"),
    name: str = Form("MAGHRABI V20 Pipeline"),
    language: str = Form("ar"),
    scene_threshold: float = Form(.35),
    highlight_duration: float | None = Form(None),
    _username: str = Depends(require_auth),
) -> dict:
    if preset not in PIPELINE_PRESETS:
        raise HTTPException(status_code=400, detail="Production Preset غير مدعوم.")
    job_id = uuid.uuid4().hex
    folder = _job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=False)
    suffix = Path(file.filename or "").suffix.lower()
    if not suffix or len(suffix) > 10:
        suffix = ".mp4"
    source_rel = f"input/source{suffix}"
    try:
        await _save_upload(file, folder / source_rel)
        config = PIPELINE_PRESETS[preset]
        state = {
            "id": job_id,
            "name": (name or config["label"])[:120],
            "preset": preset,
            "presetLabel": config["label"],
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "message": "تمت إضافة المهمة إلى Automated Production Pipeline.",
            "error": None,
            "createdAt": _now(),
            "startedAt": None,
            "finishedAt": None,
            "resultReady": False,
            "reportReady": False,
            "captionsReady": False,
            "sourceFile": source_rel,
            "language": (language or "ar")[:12],
            "sceneThreshold": max(.08, min(.85, scene_threshold)),
            "highlightDuration": max(5.0, min(120.0, highlight_duration if highlight_duration is not None else config["highlightDuration"])),
            "steps": [],
        }
        _write_state(job_id, state)
        _schedule(job_id)
        return _public_state(state)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@router.get("/jobs")
async def jobs_v20(_username: str = Depends(require_auth)) -> dict:
    items = []
    for path in PIPELINE_DIR.glob("*/job.json"):
        try:
            items.append(_public_state(json.loads(path.read_text(encoding="utf-8"))))
        except Exception:
            continue
    items.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
    return {"jobs": items[:100]}


@router.get("/jobs/{job_id}")
async def job_v20(job_id: str, _username: str = Depends(require_auth)) -> dict:
    return _public_state(_read_state(job_id))


@router.get("/jobs/{job_id}/result")
async def result_v20(job_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    state = _read_state(job_id)
    path = _job_dir(job_id) / "result.mp4"
    if state.get("status") != "done" or not path.exists():
        raise HTTPException(status_code=409, detail="نتيجة Production Pipeline غير جاهزة بعد.")
    return FileResponse(path, media_type="video/mp4", filename=f"MAGHRABI-v20-{state.get('preset','production')}-{job_id[:8]}.mp4")


@router.get("/jobs/{job_id}/report")
async def report_v20(job_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    _read_state(job_id)
    path = _job_dir(job_id) / "report.json"
    if not path.exists():
        raise HTTPException(status_code=409, detail="تقرير Production Pipeline غير جاهز بعد.")
    return FileResponse(path, media_type="application/json", filename=f"MAGHRABI-v20-report-{job_id[:8]}.json")


@router.get("/jobs/{job_id}/captions")
async def captions_v20(job_id: str, _username: str = Depends(require_auth)) -> FileResponse:
    _read_state(job_id)
    path = _job_dir(job_id) / "captions.srt"
    if not path.exists():
        raise HTTPException(status_code=404, detail="لا يوجد ملف Captions لهذه المهمة.")
    return FileResponse(path, media_type="text/plain; charset=utf-8", filename=f"MAGHRABI-v20-captions-{job_id[:8]}.srt")


@router.post("/jobs/{job_id}/retry")
async def retry_v20(job_id: str, _username: str = Depends(require_auth)) -> dict:
    state = _read_state(job_id)
    if state.get("status") == "processing":
        raise HTTPException(status_code=409, detail="المهمة قيد التنفيذ حاليًا.")
    folder = _job_dir(job_id)
    for name in ["result.mp4", "report.json", "captions.srt", "transcript.json"]:
        path = folder / name
        if path.exists():
            path.unlink()
    state.update(status="queued", stage="queued", progress=0, startedAt=None, finishedAt=None, resultReady=False, reportReady=False, captionsReady=False, error=None, message="تمت إعادة المهمة إلى V20 Pipeline.", steps=[])
    _write_state(job_id, state)
    _schedule(job_id)
    return _public_state(state)


@router.delete("/jobs/{job_id}")
async def delete_v20(job_id: str, _username: str = Depends(require_auth)) -> dict:
    state = _read_state(job_id)
    if state.get("status") == "processing":
        raise HTTPException(status_code=409, detail="لا يمكن حذف Pipeline أثناء التنفيذ.")
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
    return {"ok": True, "id": job_id}


_resume_jobs()
