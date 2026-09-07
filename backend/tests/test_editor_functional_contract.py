from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend" / "app"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class EditorFunctionalContractTests(unittest.TestCase):
    """Static regression contract for the product-facing Creator editor.

    This complements Creator Editor E2E Smoke: the smoke workflow proves the
    real FFmpeg render path, while these checks protect the UI-to-engine wiring
    from accidental removal during future refactors.
    """

    def test_v12_core_editing_controls_remain_wired(self) -> None:
        source = read(FRONTEND / "VideoStudioV12.tsx")
        required = {
            "program transport": "toggleProgram",
            "play state": "programPlaying",
            "video import": "addVideos",
            "audio import": "addAudio",
            "timeline drag payload": "setDragPayload",
            "timeline drop": "dropOnLane",
            "insert source": "insertSource",
            "razor": "razorAt",
            "lift/extract": "liftOrExtract",
            "speed inspector": "SPEED",
            "render queue": "enqueueVideoProjectV12",
            "audio detach": "extractVideoAudio",
        }
        for label, token in required.items():
            with self.subTest(label=label):
                self.assertIn(token, source)

    def test_advanced_timeline_motion_and_history_remain_available(self) -> None:
        move = read(FRONTEND / "StudioAdvancedTimelineEditPro.tsx")
        core = read(FRONTEND / "StudioEditingCorePro.tsx")
        precision = read(FRONTEND / "StudioPrecisionEditPro.tsx")

        for token in ("commitGroupMove", "snapCandidates", "autoScroll", "saveStoredVideoProject"):
            self.assertIn(token, move)
        for token in ("undoEditingHistory", "redoEditingHistory", "scheduleAutosave", "MARKER"):
            self.assertIn(token, core)
        for token in ("slip", "slide", "trim"):
            self.assertIn(token.lower(), precision.lower())

    def test_creative_suite_is_connected_to_v12_export_manifest(self) -> None:
        suite = read(FRONTEND / "StudioCreativeSuite.tsx")
        settings = read(FRONTEND / "lib" / "creativeProjectSettings.ts")

        self.assertIn("/api/video/v12/queue", suite)
        self.assertIn("applyCreativeSettingsToManifest", suite)
        self.assertIn("nextForm.set('manifest'", suite)

        for token in (
            "textTracks",
            "subtitleTracks",
            "transitionDuration",
            "audioDuckingEnabled",
            "duckingStrength",
            "speedRamp",
            "audioFadeIn",
            "audioFadeOut",
        ):
            self.assertIn(token, settings)

    def test_per_clip_finishing_is_mounted_and_survives_global_off(self) -> None:
        app = read(FRONTEND / "StudioProApp.tsx")
        finishing = read(FRONTEND / "StudioClipFinishingPro.tsx")
        settings = read(FRONTEND / "lib" / "creativeProjectSettings.ts")

        self.assertIn("StudioClipFinishingPro", app)
        for token in (
            "CLIP FINISHING PRO",
            "BASE SPEED",
            "SPEED RAMP · PER CLIP",
            "PROFESSIONAL LOOK · PER CLIP",
            "mutateClip",
            "clip.speedRamp = speedRamp",
            "clip.clipFinishingLook",
        ):
            self.assertIn(token, finishing)
        self.assertIn("if (settings.speedRamp !== 'off') next.speedRamp = settings.speedRamp", settings)
        self.assertIn("else next.speedRamp = next.speedRamp || 'off'", settings)

    def test_motion_keyframe_editor_and_engine_cover_full_transform(self) -> None:
        app = read(FRONTEND / "StudioProApp.tsx")
        editor = read(FRONTEND / "StudioKeyframeEditorPro.tsx")
        engine = read(BACKEND / "video_tools_motion_keyframes.py")
        entry = read(BACKEND / "entry.py")

        self.assertIn("StudioKeyframeEditorPro", app)
        for token in (
            "MOTION KEYFRAMES PRO",
            "Zoom · Pan · Rotation · Opacity · Easing",
            "transformKeyframes",
            "rotation",
            "opacity",
            "ease-in-out",
            "CINEMATIC PUSH",
            "KEN BURNS",
            "FADE MOTION",
        ):
            self.assertIn(token, editor)
        for token in (
            "_normalize_motion_keyframes",
            "rotation",
            "opacity",
            "rotate=angle=",
            "blend=all_expr=",
            "install_motion_keyframe_engine",
        ):
            self.assertIn(token, engine)
        self.assertIn("install_motion_keyframe_engine()", entry)

    def test_text_designer_is_live_and_export_connected(self) -> None:
        app = read(FRONTEND / "StudioProApp.tsx")
        designer = read(FRONTEND / "StudioTextDesignerPro.tsx")
        preview = read(FRONTEND / "StudioTitlePreviewPro.tsx")
        settings = read(FRONTEND / "lib" / "creativeProjectSettings.ts")
        engine = read(BACKEND / "video_tools_text_designer.py")
        entry = read(BACKEND / "entry.py")

        self.assertIn("StudioTextDesignerPro", app)
        for token in (
            "TEXT DESIGNER PRO",
            "STYLE PRESETS",
            "LOWER THIRD",
            "fontPreset",
            "boxPadding",
            "borderWidth",
            "shadowDistance",
            "slide-up",
            "slide-left",
            "slide-right",
            "pop",
        ):
            self.assertIn(token, designer)
        for token in ("fontPreset", "boxColor", "borderColor", "shadowColor", "animation", "professionalFields"):
            self.assertIn(token, settings)
        for token in ("styleFor", "WebkitTextStroke", "textShadow", "motion(title, time)"):
            self.assertIn(token, preview)
        for token in ("FONT_PRESETS", "drawtext=fontfile=", "alpha=", "borderw=", "shadowx=", "install_text_designer_engine"):
            self.assertIn(token, engine)
        self.assertIn("install_text_designer_engine()", entry)

    def test_professional_look_library_has_depth(self) -> None:
        settings = read(FRONTEND / "lib" / "creativeProjectSettings.ts")
        looks_section = settings.split("export const CREATIVE_TRANSITIONS", 1)[0]
        look_ids = set(re.findall(r"\{ id: '([a-z0-9-]+)', name:", looks_section))
        expected = {
            "clean-studio",
            "cinema-teal",
            "golden-hour",
            "travel-pop",
            "soft-portrait",
            "night-neon",
            "vintage-film",
            "steel-blue",
            "noir",
            "documentary",
            "commercial-crisp",
            "desert-luxe",
            "emerald-film",
            "rose-cinema",
            "moody-drama",
            "sports-punch",
        }
        self.assertTrue(expected.issubset(look_ids), expected - look_ids)
        self.assertGreaterEqual(len(look_ids), 17)

    def test_transition_library_and_ffmpeg_engine_are_connected(self) -> None:
        settings = read(FRONTEND / "lib" / "creativeProjectSettings.ts")
        engine = read(BACKEND / "video_tools_v4.py")
        cut_engine = read(BACKEND / "video_tools_cut_transitions.py")
        entry = read(BACKEND / "entry.py")
        transitions = {
            "none",
            "fade",
            "fadeblack",
            "fadewhite",
            "dissolve",
            "wipeleft",
            "wiperight",
            "slideleft",
            "slideright",
            "smoothleft",
            "smoothright",
            "circleopen",
            "circleclose",
            "pixelize",
        }
        for transition in transitions:
            with self.subTest(transition=transition):
                self.assertIn(f"'{transition}'", settings)
                self.assertIn(f'"{transition}"', engine)
        self.assertIn("xfade=transition=", engine)
        self.assertIn("acrossfade=d=", engine)
        self.assertIn("transitionOut", cut_engine)
        self.assertIn("build_v4_filters_with_cut_transitions", cut_engine)
        self.assertIn("install_cut_transition_engine()", entry)

    def test_v12_queue_delegates_to_proven_render_stack(self) -> None:
        v12 = read(BACKEND / "video_tools_v12.py")
        v11 = read(BACKEND / "video_tools_v11.py")
        v10 = read(BACKEND / "video_tools_v10.py")
        self.assertIn("render_video_v11", v12)
        self.assertIn("render_video_v10", v11)
        self.assertIn("render_with_audio_mixer", v10)

    def test_workspace_navigation_exposes_creator_tools(self) -> None:
        nav = read(FRONTEND / "StudioWorkspaceNav.tsx")
        for label in ("MEDIA", "AUDIO", "TITLES", "TRANSITIONS", "EFFECTS", "SPEED", "MIX", "EXPORT"):
            self.assertIn(label, nav)
        self.assertIn("maghrabi-open-creative-suite", nav)
        self.assertIn("maghrabi-open-audio-mixer", nav)

    def test_real_render_smoke_covers_professional_editing_features(self) -> None:
        workflow = read(ROOT / ".github" / "workflows" / "creator-editor-smoke.yml")
        for token in (
            '"speed": 1.25',
            '"filter": "cinematic"',
            '"filter": "warm"',
            '"textTracks"',
            '"subtitleTracks"',
            '"audioTracks"',
            '"transition": "dissolve"',
            '"audioDuckingEnabled": true',
            '"transformKeyframes"',
            '"rotation":-2.0',
            '"opacity":0.72',
            '"fontPreset":"serif-bold"',
            '"animation":"slide-up"',
            "ffprobe",
            "/api/video/v12/queue",
        ):
            self.assertIn(token, workflow)


if __name__ == "__main__":
    unittest.main()