"""
Summarizes the conversation transcript using Ollama (local LLM).
Runs in a background thread, producing summaries every N seconds.
"""
import threading
import time
import queue
from typing import List, Dict, Any, Callable
import structlog

log = structlog.get_logger(__name__)

SYSTEM_PROMPT = (
    "You are a meeting assistant. Summarize the following conversation transcript "
    "concisely. Identify key topics, decisions made, and action items if any. "
    "Be brief and factual. Do not invent information."
)


def _build_transcript_text(segments: List[Dict[str, Any]]) -> str:
    lines = []
    for seg in segments:
        speaker = seg.get("speaker_name") or seg.get("speaker", "Unknown")
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


class Summarizer(threading.Thread):
    def __init__(
        self,
        model: str = "mistral",
        host: str = "http://localhost:11434",
        interval_seconds: int = 60,
        on_summary: Callable[[str], None] = None,
    ):
        super().__init__(daemon=True, name="summarizer")
        self.model = model
        self.host = host
        self.interval_seconds = interval_seconds
        self.on_summary = on_summary
        self._stop_event = threading.Event()
        self._segments: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def stop(self):
        self._stop_event.set()

    def update_segments(self, segments: List[Dict[str, Any]]):
        with self._lock:
            self._segments = list(segments)

    def _summarize_now(self) -> str:
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
            return response["message"]["content"].strip()
        except Exception as e:
            log.error("summarize_failed", error=str(e))
            return ""

    def run(self):
        log.info("summarizer_started", model=self.model, interval=self.interval_seconds)
        while not self._stop_event.wait(timeout=self.interval_seconds):
            summary = self._summarize_now()
            if summary and self.on_summary:
                self.on_summary(summary)
