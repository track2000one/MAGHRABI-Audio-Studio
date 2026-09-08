from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class CompositingProContractTests(unittest.TestCase):
    def test_frontend_workspace_is_mounted(self):
        app = (ROOT / "frontend/src/StudioProApp.tsx").read_text(encoding="utf-8")
        ui = (ROOT / "frontend/src/StudioCompositingPro.tsx").read_text(encoding="utf-8")
        self.assertIn("StudioCompositingPro", app)
        for token in (
            "ADVANCED COMPOSITING PRO",
            "Adjustment Layers",
            "Blend Modes",
            "EFFECTS STACK",
            "OPACITY KEYFRAME",
            "CREATE COMPOUND RANGE",
            "FILM GRAIN",
            "LIGHT LEAK",
            "LAYER TRANSFORM",
        ):
            self.assertIn(token, ui)

    def test_queue_bridge_injects_render_manifest(self):
        ui = (ROOT / "frontend/src/StudioCompositingPro.tsx").read_text(encoding="utf-8")
        settings = (ROOT / "frontend/src/lib/compositingProjectSettings.ts").read_text(encoding="utf-8")
        self.assertIn("/api/video/v12/queue", ui)
        self.assertIn("injectActiveCompositingSettings", ui)
        self.assertIn("adjustmentLayers", settings)
        self.assertIn("compoundGroups", settings)
        self.assertIn("MAX_LAYERS = 12", settings)
        self.assertIn("MAX_KEYFRAMES = 16", settings)

    def test_backend_uses_real_blend_expression_and_effects(self):
        backend = (ROOT / "backend/app/video_tools_compositing.py").read_text(encoding="utf-8")
        for token in (
            "blend=all_expr",
            "screen",
            "multiply",
            "overlay",
            "difference",
            "boxblur",
            "unsharp",
            "vignette",
            "noise=alls",
            "colorbalance",
            "opacityKeyframes",
            "crop=",
            "scale=",
        ):
            self.assertIn(token, backend)

    def test_pipeline_order_is_compositing_then_color_then_text(self):
        entry = (ROOT / "backend/app/entry.py").read_text(encoding="utf-8")
        comp = entry.index("install_compositing_engine()")
        color = entry.index("install_color_grading_engine()")
        text = entry.index("install_text_designer_engine()")
        self.assertLess(comp, color)
        self.assertLess(color, text)


if __name__ == "__main__":
    unittest.main()
