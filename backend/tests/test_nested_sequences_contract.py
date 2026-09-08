from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend" / "app"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class NestedSequencesContractTests(unittest.TestCase):
    def test_nested_editor_is_mounted_and_exposes_real_editing_controls(self) -> None:
        app = read(FRONTEND / "StudioProApp.tsx")
        panel = read(FRONTEND / "StudioNestedSequencesPro.tsx")
        store = read(FRONTEND / "lib" / "nestedSequenceProjectSettings.ts")

        self.assertIn("StudioNestedSequencesPro", app)
        for token in (
            "Compound Clips / Nested Sequences 2.0",
            "CREATE FROM IN/OUT",
            "SYNC PARENT",
            "DUPLICATE",
            "UNPACK",
            "NESTED INSPECTOR",
            "PARENT START",
            "DURATION",
            "LOCAL START",
            "SOURCE IN",
            "SOURCE OUT",
            "SPEED",
            "VOLUME",
            "RENDER CONTRACT",
            "V1",
            "V2",
            "V3",
            "A1",
            "A2",
            "A3",
        ):
            self.assertIn(token, panel)

        for token in (
            "captureNestedSequence",
            "nestedSequenceToManifest",
            "injectActiveNestedSequences",
            "compoundSequences",
            "timelineStartAt",
            "videoOverlays",
            "audioTracks",
            "rangesOverlap",
            "Snap to complete V1 clip boundaries",
        ):
            self.assertIn(token, store)

    def test_queue_bridge_injects_nested_manifests_without_changing_v12_api(self) -> None:
        panel = read(FRONTEND / "StudioNestedSequencesPro.tsx")
        store = read(FRONTEND / "lib" / "nestedSequenceProjectSettings.ts")

        self.assertIn("/api/video/v12/queue", panel)
        self.assertIn("init.body instanceof FormData", panel)
        self.assertIn("injectActiveNestedSequences(parsed)", panel)
        self.assertIn("manifest: nestedSequenceToManifest(sequence)", store)

    def test_backend_flattens_child_before_parent_finishing_pipeline(self) -> None:
        engine = read(BACKEND / "video_tools_nested_sequences.py")
        entry = read(BACKEND / "entry.py")

        for token in (
            "install_nested_sequence_engine",
            "_prepare_parent_for_compounds",
            "_replace_parent_main_clips",
            "_replace_parent_range_media",
            "_subtract_overlay_ranges",
            "_subtract_audio_ranges",
            "compoundSequenceId",
            "video_tools_v12._materialize_timeline_gaps = materialize_with_nested_placeholders",
            "video_tools_v12.render_video_v11 = render_with_nested_sequences",
            "child_manifest.pop(\"compoundSequences\", None)",
            "base_materialize",
            "lut_file=None",
            "generated_index",
            "Nested Sequences المتداخلة",
            "حدود Compound يجب أن تكون على حدود V1 Clips كاملة",
        ):
            self.assertIn(token, engine)

        self.assertLess(entry.index("install_mask_tracking_engine()"), entry.index("install_nested_sequence_engine()"))
        self.assertLess(entry.index("install_nested_sequence_engine()"), entry.index("install_compositing_engine()"))
        self.assertLess(entry.index("install_nested_sequence_engine()"), entry.index("install_color_grading_engine()"))
        self.assertLess(entry.index("install_nested_sequence_engine()"), entry.index("install_text_designer_engine()"))

    def test_nested_engine_is_bounded_and_non_recursive(self) -> None:
        engine = read(BACKEND / "video_tools_nested_sequences.py")
        for token in (
            "MAX_NESTED_SEQUENCES = 12",
            "MAX_NESTED_DURATION = 900.0",
            "MAX_NESTED_CLIPS = 120",
            "Nested-in-Nested recursion غير مفعلة",
            "if len(raw) > MAX_NESTED_SEQUENCES",
            "if len(clips) > MAX_NESTED_CLIPS",
        ):
            self.assertIn(token, engine)


if __name__ == "__main__":
    unittest.main()
