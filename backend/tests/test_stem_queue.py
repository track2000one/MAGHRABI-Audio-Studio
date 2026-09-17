from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.stem_queue import choose_active_job, find_duplicate_pending_job, queue_position


class StemQueueTests(unittest.TestCase):
    def test_processing_job_is_preferred_as_active_job(self) -> None:
        states = [
            {"id": "queued-old", "status": "queued", "queued_at": 10.0},
            {"id": "processing", "status": "processing", "queued_at": 20.0},
            {"id": "queued-new", "status": "queued", "queued_at": 30.0},
        ]
        self.assertEqual(choose_active_job(states)["id"], "processing")

    def test_oldest_queued_job_is_active_when_nothing_is_processing(self) -> None:
        states = [
            {"id": "queued-new", "status": "queued", "queued_at": 30.0},
            {"id": "queued-old", "status": "queued", "queued_at": 10.0},
        ]
        self.assertEqual(choose_active_job(states)["id"], "queued-old")

    def test_duplicate_prefers_processing_copy_of_same_hash_and_mode(self) -> None:
        states = [
            {"id": "queued-copy", "status": "queued", "queued_at": 10.0, "content_sha256": "abc", "mode": "4stems"},
            {"id": "processing-copy", "status": "processing", "queued_at": 20.0, "content_sha256": "abc", "mode": "4stems"},
            {"id": "other-mode", "status": "processing", "queued_at": 5.0, "content_sha256": "abc", "mode": "2stems"},
        ]
        duplicate = find_duplicate_pending_job(states, content_sha256="abc", mode="4stems")
        self.assertIsNotNone(duplicate)
        self.assertEqual(duplicate["id"], "processing-copy")

    def test_completed_job_is_not_reused_as_pending_duplicate(self) -> None:
        states = [
            {"id": "done", "status": "completed", "queued_at": 10.0, "content_sha256": "abc", "mode": "4stems"},
        ]
        self.assertIsNone(find_duplicate_pending_job(states, content_sha256="abc", mode="4stems"))

    def test_queue_position_is_one_based_and_ignores_processing_jobs(self) -> None:
        states = [
            {"id": "processing", "status": "processing", "queued_at": 5.0},
            {"id": "first", "status": "queued", "queued_at": 10.0},
            {"id": "second", "status": "queued", "queued_at": 20.0},
        ]
        self.assertEqual(queue_position(states, "first"), 1)
        self.assertEqual(queue_position(states, "second"), 2)
        self.assertEqual(queue_position(states, "processing"), 0)


if __name__ == "__main__":
    unittest.main()
