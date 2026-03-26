"""
Generates a one-shot meeting summary using Ollama (local LLM).
Called explicitly at the end of a recording session — no background thread.
"""
import threading
from typing import List, Dict, Any
import structlog

log = structlog.get_logger(__name__)

SYSTEM_PROMPT = """\
You are a meeting assistant. Analyze the conversation transcript below and produce a structured summary in Markdown.

Use this exact structure (omit sections that don't apply):

## Overview
One or two sentences describing what the meeting was about.

## Key Topics
- Bullet list of the main subjects discussed.

## Decisions Made
- Bullet list of any decisions or conclusions reached.

## Action Items
- Bullet list of tasks or next steps, with owner if mentioned.

## Notable Quotes
- Any direct quotes worth highlighting (use > blockquote syntax).

Be concise and factual. Do not invent information not present in the transcript.\
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

    def _summarize_now(self) -> str:
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
            response = client.chat(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": text},
                ],
            )
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
