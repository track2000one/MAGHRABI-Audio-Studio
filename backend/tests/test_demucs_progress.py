from __future__ import annotations

import unittest

from app.main import demucs_progress_state, extract_demucs_percent


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


if __name__ == "__main__":
    unittest.main()
