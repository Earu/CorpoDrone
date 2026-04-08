"""
Generates meeting summaries using Ollama (local LLM).

Short transcripts (<= ~2000 tokens) are summarised in a single LLM call.
Longer transcripts are processed with a **map-reduce** strategy so that
each LLM call stays well within the model's effective context window:

  Map:    split transcript into chunks → extract structured notes per chunk
  Reduce: merge all chunk notes into the final 7-section Markdown report

This prevents small models (e.g. Mistral 7B) from "forgetting" their
instructions when the input grows beyond a few thousand tokens.
"""
import math
import threading
from typing import List, Dict, Any, Optional, Callable
import structlog

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

# One-shot prompt (used when the transcript fits comfortably in context)
SYSTEM_PROMPT = """\
You are a professional meeting secretary. The user message contains the full transcript only.
Output a detailed meeting report in Markdown.

STRICT RULES — do not break any of these:
1. Output ONLY the report. No preamble, no "Here is the report", no commentary.
2. Use EXACTLY the seven section headings below, in this order, with no extras.
3. Every section must be present. Write "None." if a section has no content.
4. Do NOT invent, infer, or hallucinate anything not explicitly stated in the transcript.
5. Do NOT collapse or over-summarize. If a topic was discussed at length, give it proportional space.

Your report MUST be in this exact format:
## Overview
## Participants
## Topics Discussed
## Decisions Made
## Action Items & Next Steps
## Open Questions
## Notable Quotes
"""

# Map prompt — used to extract structured notes from each transcript chunk.
# Kept deliberately simple so small models don't veer off.
MAP_SYSTEM_PROMPT = """\
You are a professional meeting note-taker. The user message contains ONE CHUNK of a meeting transcript.
Extract structured notes from this chunk ONLY.

STRICT RULES:
1. Output ONLY the notes below. No preamble, no commentary.
2. Use EXACTLY these headings. Write "None." if a heading has no content in this chunk.
3. Do NOT invent or infer anything not explicitly stated.
4. Be detailed — preserve specific names, numbers, dates, and commitments.

## Participants Mentioned
## Topics Discussed
## Decisions Made
## Action Items
## Open Questions
## Notable Quotes
"""

# Reduce prompt — merges per-chunk notes into the final report.
REDUCE_SYSTEM_PROMPT = """\
You are a professional meeting secretary. The user message contains structured notes extracted from consecutive chunks of the same meeting.
Merge them into ONE coherent meeting report in Markdown.

STRICT RULES — do not break any of these:
1. Output ONLY the report. No preamble, no "Here is the report", no commentary.
2. Use EXACTLY the seven section headings below, in this order, with no extras.
3. Every section must be present. Write "None." if a section has no content.
4. Do NOT invent, infer, or hallucinate anything not in the notes.
5. De-duplicate participants and merge overlapping topics.
6. Preserve ALL action items, decisions, and open questions — do not drop any.
7. If a topic spans multiple chunks, combine the details into one coherent entry.

Your report MUST be in this exact format:
## Overview
## Participants
## Topics Discussed
## Decisions Made
## Action Items & Next Steps
## Open Questions
## Notable Quotes
"""

USER_TRANSCRIPT_PREFIX = (
    "Verbatim meeting transcript. Ground every claim in this text only; "
    "if something is not stated, write \"None.\" for that part.\n\n"
)

MAP_USER_PREFIX = "Meeting transcript chunk ({chunk_label}). Extract notes from this chunk only.\n\n"

REDUCE_USER_PREFIX = (
    "Below are structured notes extracted from {n_chunks} consecutive chunks of the same meeting. "
    "Merge them into a single report.\n\n"
)

OLLAMA_CHAT_OPTIONS = {"temperature": 0.2, "top_p": 0.9}

# Transcripts shorter than this (in estimated tokens) use the fast one-shot
# path. Beyond this the map-reduce strategy kicks in.  ~2000 tokens leaves
# plenty of room for the system prompt + generation in an 8K context.
ONE_SHOT_TOKEN_LIMIT = 2000

# Target size for each map chunk.  Smaller chunks = more faithful extraction
# but more LLM calls.  1200 tokens is conservative for 8K-context models.
MAP_CHUNK_TARGET_TOKENS = 1200


def _estimate_tokens(text: str) -> int:
    """Rough token count: ~4 characters per token for English text."""
    return len(text) // 4


def _build_transcript_text(segments: List[Dict[str, Any]]) -> str:
    lines = []
    for seg in segments:
        speaker = seg.get("speaker_name") or seg.get("speaker", "Unknown")
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


def _split_transcript_into_chunks(text: str, target_tokens: int) -> List[str]:
    """Split transcript at speaker-turn boundaries into chunks of ~target_tokens.

    Splitting at line boundaries (each line is one speaker turn) avoids
    cutting mid-sentence. Chunks may slightly exceed target_tokens when a
    single turn is very long — that's preferable to mid-turn splits.
    """
    lines = text.split("\n")
    chunks: List[str] = []
    current_lines: List[str] = []
    current_tokens = 0

    for line in lines:
        line_tokens = _estimate_tokens(line)
        if current_tokens + line_tokens > target_tokens and current_lines:
            chunks.append("\n".join(current_lines))
            current_lines = []
            current_tokens = 0
        current_lines.append(line)
        current_tokens += line_tokens

    if current_lines:
        chunks.append("\n".join(current_lines))

    return chunks


def _strip_markdown_fences(content: str) -> str:
    """Remove ```markdown ... ``` or ``` ... ``` wrappers some models add."""
    if content.startswith("```"):
        lines = content.splitlines()
        content = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return content.strip()


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

    # ------------------------------------------------------------------
    # Ollama helpers
    # ------------------------------------------------------------------

    def _chat(
        self,
        messages: List[Dict[str, str]],
        progress_cb: Optional[Callable[[int], None]] = None,
        expected_chars: int = 3000,
    ) -> str:
        """Single Ollama chat call with optional streaming progress."""
        import ollama
        client = ollama.Client(host=self.host)

        if progress_cb:
            chunks: List[str] = []
            char_count = 0
            for chunk in client.chat(
                model=self.model,
                messages=messages,
                stream=True,
                options=OLLAMA_CHAT_OPTIONS,
            ):
                msg = chunk.message if hasattr(chunk, "message") else chunk["message"]
                part = msg.content if hasattr(msg, "content") else msg["content"]
                if part:
                    chunks.append(part)
                    char_count += len(part)
                    pct = min(95, (1 - math.exp(-char_count / expected_chars)) * 100)
                    progress_cb(int(pct))
            progress_cb(100)
            content = "".join(chunks).strip()
        else:
            response = client.chat(
                model=self.model,
                messages=messages,
                options=OLLAMA_CHAT_OPTIONS,
            )
            msg = response.message if hasattr(response, "message") else response["message"]
            content = msg.content if hasattr(msg, "content") else msg["content"]
            content = content.strip()

        return _strip_markdown_fences(content)

    # ------------------------------------------------------------------
    # One-shot (short transcripts)
    # ------------------------------------------------------------------

    def _summarize_one_shot(self, text: str, progress_cb: Optional[Callable[[int], None]] = None) -> str:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_TRANSCRIPT_PREFIX + text},
        ]
        return self._chat(messages, progress_cb)

    # ------------------------------------------------------------------
    # Map-reduce (long transcripts)
    # ------------------------------------------------------------------

    def _map_chunk(self, chunk_text: str, chunk_label: str) -> str:
        """Extract structured notes from a single transcript chunk."""
        messages = [
            {"role": "system", "content": MAP_SYSTEM_PROMPT},
            {"role": "user", "content": MAP_USER_PREFIX.format(chunk_label=chunk_label) + chunk_text},
        ]
        return self._chat(messages, expected_chars=1500)

    def _reduce(self, chunk_notes: List[str], progress_cb: Optional[Callable[[int], None]] = None) -> str:
        """Merge per-chunk notes into the final report."""
        combined = "\n\n---\n\n".join(
            f"### Chunk {i+1}\n{notes}" for i, notes in enumerate(chunk_notes)
        )
        messages = [
            {"role": "system", "content": REDUCE_SYSTEM_PROMPT},
            {"role": "user", "content": REDUCE_USER_PREFIX.format(n_chunks=len(chunk_notes)) + combined},
        ]
        return self._chat(messages, progress_cb, expected_chars=3000)

    def _summarize_map_reduce(self, text: str, progress_cb: Optional[Callable[[int], None]] = None) -> str:
        chunks = _split_transcript_into_chunks(text, MAP_CHUNK_TARGET_TOKENS)
        n = len(chunks)
        log.info("map_reduce_start", n_chunks=n, est_tokens=_estimate_tokens(text))

        # Map phase gets 70% of progress, reduce phase gets 30%
        chunk_notes: List[str] = []
        for i, chunk_text in enumerate(chunks):
            label = f"{i+1}/{n}"
            log.info("map_chunk", chunk=label, est_tokens=_estimate_tokens(chunk_text))
            notes = self._map_chunk(chunk_text, label)
            chunk_notes.append(notes)
            if progress_cb:
                progress_cb(int(70 * (i + 1) / n))

        log.info("reduce_start", total_notes_tokens=_estimate_tokens("\n".join(chunk_notes)))

        def reduce_progress(pct):
            if progress_cb:
                progress_cb(70 + int(pct * 0.30))

        result = self._reduce(chunk_notes, reduce_progress)
        return result

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def _summarize_now(self, progress_cb=None) -> str:
        """
        Generate the summary. Automatically picks one-shot or map-reduce
        based on transcript length.

        If progress_cb is provided, calls progress_cb(pct) with 0-100.
        """
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
            est_tokens = _estimate_tokens(text)
            if est_tokens <= ONE_SHOT_TOKEN_LIMIT:
                log.info("summarize_one_shot", est_tokens=est_tokens)
                return self._summarize_one_shot(text, progress_cb)
            else:
                log.info("summarize_map_reduce", est_tokens=est_tokens)
                return self._summarize_map_reduce(text, progress_cb)
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
