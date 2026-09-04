from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.security_hardening_v38 import CSP, SECURITY_HEADERS, is_sensitive_path


class SecurityHardeningV38Tests(unittest.TestCase):
    def test_sensitive_paths_are_no_store_candidates(self) -> None:
        self.assertTrue(is_sensitive_path("/api/auth/status"))
        self.assertTrue(is_sensitive_path("/api/video/v34/admin/overview"))
        self.assertTrue(is_sensitive_path("/api/video/v34/release/ready"))
        self.assertTrue(is_sensitive_path("/api/video/v40/overview"))
        self.assertFalse(is_sensitive_path("/assets/index.js"))

    def test_csp_blocks_embedding_and_objects(self) -> None:
        self.assertIn("frame-ancestors 'none'", CSP)
        self.assertIn("object-src 'none'", CSP)
        self.assertEqual(SECURITY_HEADERS["X-Content-Type-Options"], "nosniff")
        self.assertEqual(SECURITY_HEADERS["X-Frame-Options"], "DENY")


if __name__ == "__main__":
    unittest.main()
