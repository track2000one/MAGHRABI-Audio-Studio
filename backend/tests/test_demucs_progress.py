from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.stem_progress import demucs_progress_state, demucs_stall_reason, extract_demucs_percent


class DemucsProgressParsingTests(unittest.TestCase):
    def test_model_download_progress_is_not_treated_as_audio_separation(self) -> None:
        line = "100%|██████████| 80.2M/80.2M [00:00<00:00, 297MB/s]"
        self.assertIsNone(extract_demucs_percent(line))

    def test_audio_separation_progress_is_reported(self) -> None:
        line = "56%|███████████████████████████████████████▍ | 87.75/157.95 [11:57<09:33,  8.17s/seconds]"
        self.assertEqual(extract_demucs_percent(line), 56)

    def test_engine_100_percent_moves_ui_to_finalizing_stage(self) -> None:
        state = demucs_progress_state(100)
        self.assertEqual(state["stage"], "finalizing")
        self.assertGreaterEqual(state["progress"], 90)
        self.assertNotIn("تقدم المحرك 100%", state["message"])

    def test_engine_progress_below_100_stays_in_separation_stage(self) -> None:
        state = demucs_progress_state(56)
        self.assertEqual(state["stage"], "separating")
        self.assertGreaterEqual(state["progress"], 25)
        self.assertLess(state["progress"], 90)
        self.assertIn("56%", state["message"])

    def test_watchdog_times_out_engine_that_finished_but_never_exits(self) -> None:
        reason = demucs_stall_reason(
            now=400.0,
            last_output_at=100.0,
            engine_completed_at=100.0,
            stall_timeout_seconds=900,
            finalize_timeout_seconds=240,
        )
        self.assertIsNotNone(reason)
        self.assertIn("الملفات النهائية", reason or "")

    def test_watchdog_allows_normal_silent_processing_window(self) -> None:
        reason = demucs_stall_reason(
            now=500.0,
            last_output_at=100.0,
            engine_completed_at=None,
            stall_timeout_seconds=900,
            finalize_timeout_seconds=240,
        )
        self.assertIsNone(reason)

    def test_watchdog_times_out_long_precompletion_stall(self) -> None:
        reason = demucs_stall_reason(
            now=1001.0,
            last_output_at=100.0,
            engine_completed_at=None,
            stall_timeout_seconds=900,
            finalize_timeout_seconds=240,
        )
        self.assertIsNotNone(reason)
        self.assertIn("إرسال تقدم", reason or "")


if __name__ == "__main__":
    unittest.main()
