from __future__ import annotations

import unittest

from app.main import extract_demucs_percent


class DemucsProgressParsingTests(unittest.TestCase):
    def test_model_download_progress_is_not_treated_as_audio_separation(self) -> None:
        line = "100%|██████████| 80.2M/80.2M [00:00<00:00, 297MB/s]"
        self.assertIsNone(extract_demucs_percent(line))

    def test_audio_separation_progress_is_reported(self) -> None:
        line = "56%|███████████████████████████████████████▍ | 87.75/157.95 [11:57<09:33,  8.17s/seconds]"
        self.assertEqual(extract_demucs_percent(line), 56)


if __name__ == "__main__":
    unittest.main()
