from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend" / "app"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class ColorGradingContractTests(unittest.TestCase):
    def test_color_grading_ui_is_mounted_and_has_professional_controls(self) -> None:
        app = read(FRONTEND / "StudioProApp.tsx")
        panel = read(FRONTEND / "StudioColorGradingPro.tsx")
        settings = read(FRONTEND / "lib" / "creativeProjectSettings.ts")

        self.assertIn("StudioColorGradingPro", app)
        for token in (
            "COLOR GRADING PRO",
            "PRIMARY CORRECTION",
            "EXPOSURE",
            "HIGHLIGHTS",
            "SHADOWS",
            "TEMPERATURE",
            "TINT",
            "HSL / COLOR INTENSITY",
            "VIBRANCE",
            "LUMA CURVE",
            "LUMA WAVEFORM",
            "VECTORSCOPE",
            "LOAD MASTER LUT",
            "BEFORE",
            "AFTER",
        ):
            self.assertIn(token, panel)

        for token in (
            "CreativeColorGrade",
            "DEFAULT_COLOR_GRADE",
            "sanitizeColorGrade",
            "colorGrade:",
            "curveShadows",
            "curveMidtones",
            "curveHighlights",
            "sharpen",
        ):
            self.assertIn(token, settings)

    def test_master_grade_engine_is_installed_before_text_designer(self) -> None:
        engine = read(BACKEND / "video_tools_color_grading.py")
        text_engine = read(BACKEND / "video_tools_text_designer.py")
        entry = read(BACKEND / "entry.py")

        for token in (
            "_normalize_color_grade",
            "eq=brightness=",
            "curves=master=",
            "colorbalance=",
            "hue=h=",
            "vignette=angle=",
            "unsharp=5:5:",
            "install_color_grading_engine",
            "video_tools_v9._apply_master_lut = apply_lut_then_grade",
        ):
            self.assertIn(token, engine)

        self.assertIn("apply_lut_grade_then_text", text_engine)
        self.assertIn("video_tools_v9._apply_master_lut = apply_lut_grade_then_text", text_engine)
        self.assertLess(entry.index("install_color_grading_engine()"), entry.index("install_text_designer_engine()"))

    def test_export_manifest_carries_master_grade(self) -> None:
        settings = read(FRONTEND / "lib" / "creativeProjectSettings.ts")
        self.assertIn("colorGrade: sanitizeColorGrade(settings.colorGrade)", settings)
        self.assertIn("applyCreativeSettingsToManifest", settings)


if __name__ == "__main__":
    unittest.main()
