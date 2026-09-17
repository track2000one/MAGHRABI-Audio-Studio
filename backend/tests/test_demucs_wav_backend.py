from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "Dockerfile"
COMPAT = ROOT / "backend" / "app" / "demucs_compat.py"
OVERLAY_INIT = ROOT / "backend" / "demucs_overlay" / "__init__.py"
OVERLAY_MAIN = ROOT / "backend" / "demucs_overlay" / "__main__.py"


class DemucsWavBackendTests(unittest.TestCase):
    def test_runtime_overlays_demucs_cli_entry_point(self) -> None:
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        overlay_init = OVERLAY_INIT.read_text(encoding="utf-8")
        overlay_main = OVERLAY_MAIN.read_text(encoding="utf-8")
        self.assertIn("COPY backend/demucs_overlay ./demucs", dockerfile)
        self.assertIn("extend_path", overlay_init)
        self.assertIn("from app.demucs_compat import main", overlay_main)

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
