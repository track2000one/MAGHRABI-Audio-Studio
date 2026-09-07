from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "backend" / "app" / "video_tools_motion_keyframes.py"


class MotionKeyframeFilterContractTests(unittest.TestCase):
    """Prevent regressions in FFmpeg expression timestamp variables.

    rotate evaluates expressions against lowercase `t`; blend evaluates frame
    timestamp as uppercase `T`. A shared lowercase expression passes static
    validation but fails only during a real render, so keep this distinction
    explicit in the source contract as well as the E2E smoke workflow.
    """

    def test_rotation_and_opacity_use_filter_specific_timestamp_variables(self) -> None:
        source = ENGINE.read_text(encoding="utf-8")
        self.assertIn('_piecewise_expr(points, "rotation", duration, "t")', source)
        self.assertIn('_piecewise_expr(points, "opacity", duration, "T")', source)
        self.assertIn('blend=all_expr=', source)
        self.assertIn('rotate=angle=', source)

    def test_expression_builder_accepts_explicit_time_variable(self) -> None:
        source = ENGINE.read_text(encoding="utf-8")
        self.assertIn('time_var: str = "t"', source)
        self.assertIn('lt({time_var}', source)
        self.assertIn('({time_var}-', source)


if __name__ == "__main__":
    unittest.main()
