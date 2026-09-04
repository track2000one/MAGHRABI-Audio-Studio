from __future__ import annotations

from . import video_tools_v29 as base

router = base.router
install_v29 = base.install_v29

_original_run_load_test = base._run_load_test


def _safe_run_load_test(test_id: str, kind: str, duration: float, concurrency: int) -> None:
    try:
        # PostgreSQL serializes synthetic capacity tests across API replicas.
        # SQLite falls back to the process-local lock; V29 reports that it is
        # not distributed-safe in that mode.
        with base.rel26.distributed_lock("v29:global-capacity-test", blocking=True) as acquired:
            if not acquired:
                raise RuntimeError("تعذر الحصول على Capacity Test global lock.")
            _original_run_load_test(test_id, kind, duration, concurrency)
    except Exception as exc:
        try:
            base.store.finish_load_test(
                test_id,
                state="failed",
                operations=0,
                errors=1,
                p50_ms=None,
                p95_ms=None,
                p99_ms=None,
                ops_per_second=None,
                details={"error": str(exc)[:1000], "syntheticOnly": True, "runtimeGuard": True},
            )
            base.rel26.event(
                "v29_capacity_test_failed",
                severity="error",
                node_id=base.v26.NODE_ID,
                details={"testId": test_id, "kind": kind, "error": str(exc)[:500]},
            )
        except Exception:
            pass
    finally:
        # The base implementation releases this on the successful path. If an
        # exception happens before that point, make sure the replica is not
        # permanently blocked from starting another capacity test.
        try:
            if base._TEST_LOCK.locked():
                base._TEST_LOCK.release()
        except RuntimeError:
            pass


# FastAPI endpoint functions resolve this module global at request time, so
# replacing it here hardens the existing V29 route without duplicating routes.
base._run_load_test = _safe_run_load_test
