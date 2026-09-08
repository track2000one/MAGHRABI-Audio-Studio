from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend" / "app"


class MaskTrackingContractTests(unittest.TestCase):
    def test_workspace_is_mounted_and_navigation_exposes_masks(self) -> None:
        app = (FRONTEND / "StudioProApp.tsx").read_text(encoding="utf-8")
        nav = (FRONTEND / "StudioWorkspaceNav.tsx").read_text(encoding="utf-8")
        editor = (FRONTEND / "StudioEffectsMasksPro.tsx").read_text(encoding="utf-8")
        self.assertIn("StudioEffectsMasksPro", app)
        self.assertIn("MASKS", nav)
        self.assertIn("maghrabi-open-mask-suite", nav)
        for token in (
            "EFFECTS / MASKS / TRACKING PRO",
            "background-blur",
            "spotlight",
            "privacyTrackingPoints",
            "AUTO TRACK · BLOCK MATCH",
            "patchSignature",
            "signatureScore",
            "CHROMA KEY / SCREEN",
            "APPLY TO CLIP",
        ):
            self.assertIn(token, editor)

    def test_backend_engine_supports_feathered_animated_masks(self) -> None:
        engine = (BACKEND / "video_tools_mask_tracking.py").read_text(encoding="utf-8")
        entry = (BACKEND / "entry.py").read_text(encoding="utf-8")
        for token in (
            '"ellipse"',
            '"background-blur"',
            '"spotlight"',
            "privacyTrackingPoints",
            "privacyFeather",
            "geq=lum=",
            "alphamerge",
            "boxblur",
            "_piecewise_expr",
            "install_mask_tracking_engine",
        ):
            self.assertIn(token, engine)
        self.assertIn("install_mask_tracking_engine()", entry)

    def test_mask_engine_is_patched_into_v12_render_ancestry(self) -> None:
        engine = (BACKEND / "video_tools_mask_tracking.py").read_text(encoding="utf-8")
        self.assertIn("video_tools_v9", engine)
        self.assertIn("module._validate_v5 = validate_mask_tracking", engine)
        self.assertIn("module._render_advanced_clip = render_mask_tracking", engine)
        self.assertIn("video_tools_v5.PRIVACY_EFFECTS.update(MASK_EFFECTS)", engine)


if __name__ == "__main__":
    unittest.main()
