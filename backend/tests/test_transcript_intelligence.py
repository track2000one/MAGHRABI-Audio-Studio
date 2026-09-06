from __future__ import annotations

import unittest

from app.transcript_tools import _normalize_result
from app.video_tools_transcript_captions import inject_transcript_subtitles


class TranscriptIntelligenceTests(unittest.TestCase):
    def test_word_timestamps_receive_diarized_speakers(self) -> None:
        primary = {
            "text": "hello there general kenobi",
            "duration": 2.0,
            "language": "en",
            "words": [
                {"word": "hello", "start": 0.0, "end": 0.4},
                {"word": "there", "start": 0.4, "end": 0.9},
                {"word": "general", "start": 1.0, "end": 1.5},
                {"word": "kenobi", "start": 1.5, "end": 2.0},
            ],
        }
        diarized = {
            "text": primary["text"],
            "duration": 2.0,
            "segments": [
                {"id": "s1", "start": 0.0, "end": 0.95, "text": "hello there", "speaker": "A"},
                {"id": "s2", "start": 0.95, "end": 2.0, "text": "general kenobi", "speaker": "B"},
            ],
        }
        result = _normalize_result(primary, diarized)
        self.assertEqual([word["speaker"] for word in result["words"]], ["A", "A", "B", "B"])
        self.assertEqual(result["segments"][0]["speaker"], "A")
        self.assertEqual(result["segments"][1]["speaker"], "B")

    def test_render_caption_injection_deduplicates_split_tracks(self) -> None:
        document = {
            "id": "transcript-1",
            "captionsEnabled": True,
            "captionSpeakerLabels": True,
            "captionMaxWords": 4,
            "captionMaxDuration": 3.2,
            "captionBreakGap": 0.65,
            "captionSize": 40,
            "captionColor": "#ffffff",
            "captionPosition": "bottom",
            "captionBoxOpacity": 0.5,
            "words": [
                {"id": "w1", "text": "Hello", "timelineStart": 0.2, "timelineEnd": 0.5, "speaker": "A"},
                {"id": "w2", "text": "world.", "timelineStart": 0.5, "timelineEnd": 0.9, "speaker": "A"},
                {"id": "w3", "text": "Second", "timelineStart": 1.1, "timelineEnd": 1.4, "speaker": "B"},
                {"id": "w4", "text": "speaker", "timelineStart": 1.4, "timelineEnd": 1.8, "speaker": "B"},
            ],
        }
        project = {
            "subtitleTracks": [],
            "audioTracks": [
                {"fileIndex": 0, "sourceStart": 0, "sourceEnd": 1, "startAt": 0, "dialogueTranscript": document},
                {"fileIndex": 0, "sourceStart": 1, "sourceEnd": 2, "startAt": 1, "dialogueTranscript": document},
            ],
        }
        result = inject_transcript_subtitles(project)
        captions = result["subtitleTracks"]
        self.assertEqual(len(captions), 2)
        self.assertEqual(captions[0]["text"], "A: Hello world.")
        self.assertEqual(captions[1]["text"], "B: Second speaker")
        self.assertEqual(captions[0]["size"], 40)
        self.assertEqual(captions[0]["source"], "dialogue-transcript")

    def test_deleted_words_are_not_rendered(self) -> None:
        project = {
            "audioTracks": [{
                "dialogueTranscript": {
                    "id": "tr-delete",
                    "captionsEnabled": True,
                    "words": [
                        {"text": "keep", "timelineStart": 0.0, "timelineEnd": 0.4},
                        {"text": "remove", "timelineStart": 0.4, "timelineEnd": 0.8, "deleted": True},
                    ],
                }
            }]
        }
        result = inject_transcript_subtitles(project)
        self.assertEqual(len(result["subtitleTracks"]), 1)
        self.assertEqual(result["subtitleTracks"][0]["text"], "keep")


if __name__ == "__main__":
    unittest.main()
