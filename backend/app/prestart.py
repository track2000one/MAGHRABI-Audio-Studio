from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
VIDEO_DIR = DATA_DIR / "video"
TOOLS_DIR = DATA_DIR / "tools"


def close_stale_audio_jobs() -> int:
    if not JOBS_DIR.exists():
        return 0

    closed = 0
    for path in JOBS_DIR.glob("*/job.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("status") not in {"queued", "processing"}:
                continue

            state.update(
                status="failed",
                stage="failed",
                progress=100,
                started_at=None,
                message="توقفت المهمة السابقة بسبب إعادة تشغيل الخدمة. أعد رفع الملف لبدء معالجة جديدة.",
                error="Interrupted by service restart",
            )
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(state, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temporary.replace(path)
            closed += 1
        except Exception as exc:
            print(f"[prestart] skipped {path}: {exc}", flush=True)
    return closed


def clean_temporary_workspaces(root: Path, pattern: str) -> int:
    if not root.exists():
        return 0
    removed = 0
    for path in root.glob(pattern):
        if not path.is_dir():
            continue
        try:
            shutil.rmtree(path, ignore_errors=False)
            removed += 1
        except Exception as exc:
            print(f"[prestart] could not remove {path}: {exc}", flush=True)
    return removed


def main() -> None:
    closed = close_stale_audio_jobs()
    video_removed = clean_temporary_workspaces(VIDEO_DIR, "render-*")
    tools_removed = clean_temporary_workspaces(TOOLS_DIR, "*-*")
    print(
        f"[prestart] stale audio jobs closed: {closed}; "
        f"video workspaces removed: {video_removed}; "
        f"audio tool workspaces removed: {tools_removed}",
        flush=True,
    )


if __name__ == "__main__":
    main()
