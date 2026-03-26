"""
Generates a one-shot meeting summary using Ollama (local LLM).
Called explicitly at the end of a recording session — no background thread.
"""
import threading
from typing import List, Dict, Any
import structlog

log = structlog.get_logger(__name__)

SYSTEM_PROMPT = """\
You are a professional meeting secretary. Your job is to produce a thorough, detailed compte-rendu (meeting report) in Markdown from the transcript below.

Cover every topic that was discussed — do not summarize too aggressively. If something was discussed for a while, give it proportional space. Write in full sentences where it adds clarity.

Use this structure (include every section; write "None" if a section truly has no content):

## Overview
Two to four sentences describing the purpose, context, and outcome of the meeting.

## Participants
List the speakers identified in the transcript.

## Topics Discussed
For each major topic, write a sub-heading and a short paragraph or bullet list covering what was said, debated, or concluded on that topic. Be thorough.

## Decisions Made
- Every decision or conclusion reached, with enough context to be understood later.

## Action Items & Next Steps
- Every task, follow-up, or next step mentioned. Include owner and deadline if stated.

## Open Questions
- Unresolved questions or points that were raised but not concluded.

## Notable Quotes
- Direct quotes worth preserving verbatim (use > blockquote syntax).

Be thorough, factual, and complete. Do not invent information not present in the transcript. Do not truncate or abbreviate.\
"""


def _build_transcript_text(segments: List[Dict[str, Any]]) -> str:
    lines = []
    for seg in segments:
        speaker = seg.get("speaker_name") or seg.get("speaker", "Unknown")
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


class Summarizer:
    def __init__(
        self,
        model: str = "mistral",
        host: str = "http://localhost:11434",
    ):
        self.model = model
        self.host = host
        self._segments: List[Dict[str, Any]] = []
        self._transcript_text: str = ""
        self._lock = threading.Lock()

    def update_segments(self, segments: List[Dict[str, Any]]):
        with self._lock:
            self._segments = list(segments)

    def set_transcript_text(self, text: str):
        """Override with a pre-built transcript string (used for post-session re-transcription)."""
        self._transcript_text = text

    def _summarize_now(self, progress_cb=None) -> str:
        """
        Generate the summary. If progress_cb is provided, streams tokens from Ollama
        and calls progress_cb(pct) with 0-100 using an asymptotic estimate based on
        cumulative characters received (approaches 95%, snaps to 100% on completion).
        Falls back to a single blocking call if streaming is unavailable.
        """
        import math

        # Prefer the pre-built full-session transcript over live segments
        if self._transcript_text:
            text = self._transcript_text
        else:
            with self._lock:
                segments = list(self._segments)
            if not segments:
                return ""
            text = _build_transcript_text(segments)

        if len(text.strip()) < 50:
            return ""

        try:
            import ollama
            client = ollama.Client(host=self.host)
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ]

            if progress_cb:
                # Streaming path: report smooth progress as tokens arrive
                EXPECTED_CHARS = 3000  # detailed compte-rendu — used for asymptote
                chunks = []
                char_count = 0
                for chunk in client.chat(model=self.model, messages=messages, stream=True):
                    msg = chunk.message if hasattr(chunk, "message") else chunk["message"]
                    part = msg.content if hasattr(msg, "content") else msg["content"]
                    if part:
                        chunks.append(part)
                        char_count += len(part)
                        pct = min(95, (1 - math.exp(-char_count / EXPECTED_CHARS)) * 100)
                        progress_cb(int(pct))
                progress_cb(100)
                content = "".join(chunks).strip()
            else:
                response = client.chat(model=self.model, messages=messages)
                msg = response.message if hasattr(response, "message") else response["message"]
                content = msg.content if hasattr(msg, "content") else msg["content"]
                content = content.strip()

            # Strip ```markdown ... ``` or ``` ... ``` wrappers some models add
            if content.startswith("```"):
                lines = content.splitlines()
                content = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
            return content.strip()
        except Exception as e:
            log.error("summarize_failed", error=str(e))
            return ""
