from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MAIN = ROOT / "backend" / "app" / "main.py"
COMPAT = ROOT / "backend" / "app" / "demucs_compat.py"


class DemucsWavBackendTests(unittest.TestCase):
    def test_worker_uses_compat_runner_instead_of_broken_torchaudio_cli_save(self) -> None:
        source = MAIN.read_text(encoding="utf-8")
        self.assertIn('"-m",\n            "app.demucs_compat"', source)
        self.assertNotIn('"-m",\n            "demucs",', source)

    def test_compat_runner_writes_pcm_wav_without_torchaudio_save(self) -> None:
        source = COMPAT.read_text(encoding="utf-8")
        self.assertIn("wave.open", source)
        self.assertIn("setframerate", source)
        self.assertIn("setnchannels", source)
        self.assertIn("setsampwidth", source)
        self.assertNotIn("ta.save", source)
        self.assertNotIn("torchaudio.save", source)

    def test_compat_runner_patches_demucs_separate_save_audio(self) -> None:
        source = COMPAT.read_text(encoding="utf-8")
        self.assertIn("demucs_separate.save_audio = save_audio_compat", source)


if __name__ == "__main__":
    unittest.main()
