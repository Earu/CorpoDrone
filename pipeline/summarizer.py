"""
Generates a one-shot meeting summary using Ollama (local LLM).
Called explicitly at the end of a recording session — no background thread.
"""
import threading
from typing import List, Dict, Any
import structlog

log = structlog.get_logger(__name__)

SYSTEM_PROMPT = """\
You are a professional meeting secretary. Output a detailed meeting report in Markdown.

STRICT RULES — do not break any of these:
1. Output ONLY the report. No preamble, no "Here is the report", no commentary.
2. Use EXACTLY the seven section headings below, in this order, with no extras.
3. Every section must be present. Write "None." if a section has no content.
4. Do NOT invent, infer, or hallucinate anything not explicitly stated in the transcript.
5. Do NOT collapse or over-summarize. If a topic was discussed at length, give it proportional space.\
"""

# Prefilled start forces the model to continue in the correct structure
# rather than deciding its own format.
ASSISTANT_PREFILL = """\
## Overview

"""

USER_SUFFIX = """

---
Write the full report now. Start directly with the ## Overview section content (it is already written above). Then continue with the remaining six sections in order:

## Participants
## Topics Discussed
## Decisions Made
## Action Items & Next Steps
## Open Questions
## Notable Quotes"""


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
        model: str = "llama3.1:8b",
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
                {"role": "user", "content": text + USER_SUFFIX},
                {"role": "assistant", "content": ASSISTANT_PREFILL},
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

            # Prepend the prefilled header that the model continued from
            content = ASSISTANT_PREFILL + content

            # Strip ```markdown ... ``` or ``` ... ``` wrappers some models add
            if content.startswith("```"):
                lines = content.splitlines()
                content = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
            return content.strip()
        except Exception as e:
            log.error("summarize_failed", error=str(e))
            return ""

    def release(self):
        """Ask Ollama to evict the model from VRAM immediately (keep_alive=0)."""
        try:
            import ollama
            ollama.Client(host=self.host).generate(model=self.model, prompt="", keep_alive=0)
            log.info("ollama_model_released", model=self.model)
        except Exception as e:
            log.warning("ollama_release_failed", error=str(e))
