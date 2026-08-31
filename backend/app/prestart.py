from __future__ import annotations

import json
import os
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"


def main() -> None:
    if not JOBS_DIR.exists():
        print("[prestart] no jobs directory", flush=True)
        return

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

    print(f"[prestart] stale pending jobs closed: {closed}", flush=True)


if __name__ == "__main__":
    main()
