from __future__ import annotations

from pkgutil import extend_path

# Keep the real Demucs package in site-packages available while overriding
# only its CLI entry module inside the production container.
__path__ = extend_path(__path__, __name__)
__version__ = "4.0.1"
