from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend" / "app"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class TransitionBrowserContractTests(unittest.TestCase):
    def test_browser_is_mounted_and_workspace_nav_opens_it(self) -> None:
        app = read(FRONTEND / "StudioProApp.tsx")
        nav = read(FRONTEND / "StudioWorkspaceNav.tsx")
        browser = read(FRONTEND / "StudioTransitionBrowserPro.tsx")

        self.assertIn("StudioTransitionBrowserPro", app)
        self.assertIn("maghrabi-open-transition-browser", nav)
        for token in (
            "TRANSITION BROWSER PRO",
            "FAVORITES",
            "Animated Preview",
            "DIRECTION",
            "DURATION",
            "EASING",
            "APPLY TO CUT",
            "APPLY TO ALL CUTS",
            "resolveDirectionalTransition",
            "transitionOut",
            "rightFileIndex",
            "rightSourceStart",
        ):
            self.assertIn(token, browser)

    def test_transition_library_has_professional_categories_and_depth(self) -> None:
        library = read(FRONTEND / "lib" / "transitionLibrary.ts")
        for category in ("Basic", "Film", "Camera", "Motion", "Light", "Glitch", "3D"):
            self.assertIn(f"'{category}'", library)
        for transition in (
            "dissolve",
            "fadeblack",
            "zoomin",
            "wipeup",
            "smoothdown",
            "pixelize",
            "hlslice",
            "coverleft",
            "revealright",
            "squeezeh",
            "circleopen",
        ):
            self.assertIn(f"type: '{transition}'", library)
        self.assertGreaterEqual(library.count("type: '"), 40)
        self.assertIn("TRANSITION_EASINGS", library)
        self.assertIn("directionalFamilies", library)

    def test_backend_expansion_is_installed_before_cut_engine(self) -> None:
        engine = read(BACKEND / "video_tools_transition_library.py")
        entry = read(BACKEND / "entry.py")
        for transition in (
            '"coverleft"',
            '"revealright"',
            '"zoomin"',
            '"hlslice"',
            '"fadegrays"',
            '"smoothup"',
        ):
            self.assertIn(transition, engine)
        self.assertIn("video_tools_v4.TRANSITIONS.update", engine)
        self.assertIn("_SMOOTH_DIRECTIONAL", engine)
        self.assertIn("install_transition_library()", entry)
        self.assertLess(entry.index("install_transition_library()"), entry.index("install_cut_transition_engine()"))

    def test_transition_e2e_smoke_uses_new_per_cut_xfade(self) -> None:
        workflow = read(ROOT / ".github" / "workflows" / "transition-browser-smoke.yml")
        for token in (
            '"transitionOut"',
            '"type":"coverleft"',
            '"easing":"smooth"',
            '"direction":"left"',
            '"rightFileIndex":1',
            '"transition":"none"',
            "/api/video/v12/queue",
            "ffprobe",
        ):
            self.assertIn(token, workflow)


if __name__ == "__main__":
    unittest.main()
