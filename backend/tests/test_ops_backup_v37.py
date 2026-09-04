from __future__ import annotations

import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ops_backup_v37 import create_backup, restore_backup, verify_backup


class BackupV37Tests(unittest.TestCase):
    def test_roundtrip_excludes_transient_directories(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            data = root / "data"
            data.mkdir()
            (data / "video_supply_chain").mkdir()
            (data / "video_supply_chain" / "state.json").write_text('{"ok":true}', encoding="utf-8")
            (data / "jobs").mkdir()
            (data / "jobs" / "temporary.bin").write_bytes(b"not-backed-up")
            backup = root / "backup.tar.gz"
            created = create_backup(data, backup)
            self.assertEqual(created["fileCount"], 1)
            verified = verify_backup(backup)
            self.assertTrue(verified["valid"], verified)
            restored = root / "restored"
            result = restore_backup(backup, restored)
            self.assertEqual(result["restored"], 1)
            self.assertEqual(
                (restored / "video_supply_chain" / "state.json").read_text(encoding="utf-8"),
                '{"ok":true}',
            )
            self.assertFalse((restored / "jobs").exists())

    def test_tampered_payload_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            data = root / "data"
            data.mkdir()
            (data / "control.json").write_text("trusted", encoding="utf-8")
            backup = root / "backup.tar.gz"
            create_backup(data, backup)
            tampered = root / "tampered.tar.gz"
            with tarfile.open(backup, "r:gz") as source, tarfile.open(tampered, "w:gz") as target:
                manifest = source.extractfile("manifest.json")
                assert manifest is not None
                payload = manifest.read()
                info = tarfile.TarInfo("manifest.json")
                info.size = len(payload)
                target.addfile(info, io.BytesIO(payload))
                bad = b"tampered"
                info = tarfile.TarInfo("data/control.json")
                info.size = len(bad)
                target.addfile(info, io.BytesIO(bad))
            result = verify_backup(tampered)
            self.assertFalse(result["valid"])
            self.assertTrue(any(item.get("reason") == "sha256" for item in result["failures"]))

    def test_path_traversal_member_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            backup = root / "unsafe.tar.gz"
            manifest = {"schema": "maghrabi-control-plane-backup/v1", "fileCount": 0, "files": []}
            payload = json.dumps(manifest).encode()
            with tarfile.open(backup, "w:gz") as archive:
                info = tarfile.TarInfo("manifest.json")
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
                unsafe = b"x"
                info = tarfile.TarInfo("../escape.txt")
                info.size = len(unsafe)
                archive.addfile(info, io.BytesIO(unsafe))
            with self.assertRaises(ValueError):
                verify_backup(backup)


if __name__ == "__main__":
    unittest.main()
