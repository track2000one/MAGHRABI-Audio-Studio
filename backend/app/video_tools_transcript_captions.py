from __future__ import annotations

import json

from . import video_tools_v10
from .transcript_core import inject_transcript_subtitles

_INSTALLED = False
_ORIGINAL_MIXER = video_tools_v10.render_with_audio_mixer


async def _captioned_mixer(render_fn, **kwargs):
    manifest = kwargs.get("manifest")
    if isinstance(manifest, str):
        try:
            project = json.loads(manifest)
            if isinstance(project, dict):
                kwargs["manifest"] = json.dumps(inject_transcript_subtitles(project), ensure_ascii=False)
        except Exception:
            pass
    return await _ORIGINAL_MIXER(render_fn, **kwargs)


def install_transcript_caption_engine() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    video_tools_v10.render_with_audio_mixer = _captioned_mixer
    _INSTALLED = True
