"""
CorpoDrone Python pipeline — main entry point.

Flow:
  AudioReceiver (named pipe) → chunk queue
  → AudioStream accumulates samples and tracks committed position
  → every step_seconds: transcribe + diarize the current window
  → only emit segments that are "confirmed" (end before last step_seconds of window)
    and haven't been emitted before → eliminates duplicates from sliding windows
  → SpeakerTracker maps labels → stable IDs
  → TranscriptWriter sends to Rust web-server
  → Summarizer runs every N seconds in background
"""
import os
import sys
import time
import queue
import threading
import uuid
from typing import List, Dict, Any, Optional

import numpy as np
import structlog

from config import Config
from audio_receiver import AudioReceiver, AudioChunk, SOURCE_MIC, SOURCE_LOOPBACK
from transcriber import Transcriber
from diarizer import Diarizer
from speaker_tracker import SpeakerTracker
from summarizer import Summarizer
from transcript_writer import TranscriptWriter

log = structlog.get_logger(__name__)

SAMPLE_RATE = 16_000


class AudioStream:
    """
    Accumulates audio from one source and provides deduplicated segment emission.

    The sliding window means every segment near the window end will be re-transcribed
    on the next step. We solve this by only emitting segments that end before
    (total_samples - step_samples) — the "safe zone". Committed position tracks
    the furthest sample already emitted so we never double-emit.
    """

    def __init__(self, window_s: float, step_s: float):
        self.window_samples = int(window_s * SAMPLE_RATE)
        self.step_samples = int(step_s * SAMPLE_RATE)
        self._buf = np.array([], dtype=np.float32)
        self._total = 0       # total samples ever received
        self._trimmed = 0     # samples trimmed off front of _buf (for indexing)
        self._committed = 0   # absolute sample index: committed/emitted up to here
        self._start_us = 0
        self._next_process_at = 0  # total at which we should next process

    def add(self, chunk: AudioChunk):
        if not self._start_us:
            self._start_us = chunk.timestamp_us
        self._buf = np.concatenate([self._buf, chunk.samples])
        self._total += len(chunk.samples)

    def ready(self) -> bool:
        return self._total >= self._next_process_at + self.step_samples

    def get_window(self):
        """Returns (audio_array, window_start_abs) — window_start_abs is absolute sample index."""
        n = min(len(self._buf), self.window_samples)
        audio = self._buf[-n:] if n > 0 else np.array([], dtype=np.float32)
        win_start_abs = self._total - n
        return audio, win_start_abs

    def emit(self, segments: list, win_start_abs: int) -> list:
        """
        Filter segments to only confirmed, non-duplicate ones.
        Updates committed position and trims internal buffer.
        Returns list of segments with 'start_us'/'end_us' filled in.
        """
        # Everything ending before safe_end is confirmed — won't change next step
        safe_end_abs = self._total - self.step_samples
        out = []
        new_committed = self._committed

        for seg in segments:
            s_abs = win_start_abs + int(seg["start"] * SAMPLE_RATE)
            e_abs = win_start_abs + int(seg["end"] * SAMPLE_RATE)

            if s_abs < self._committed:
                continue  # already emitted
            if e_abs > safe_end_abs:
                continue  # too close to window edge — wait for confirmation

            start_us = self._start_us + int(s_abs * 1_000_000 / SAMPLE_RATE)
            end_us   = self._start_us + int(e_abs * 1_000_000 / SAMPLE_RATE)
            out.append({**seg, "start_us": start_us, "end_us": end_us})
            new_committed = max(new_committed, e_abs)

        self._committed = new_committed
        self._next_process_at = self._total

        # Trim buffer: keep 2 windows worth, but never past committed position
        keep_from = max(0, len(self._buf) - self.window_samples * 2)
        committed_buf_idx = self._committed - self._trimmed
        keep_from = min(keep_from, committed_buf_idx)
        if keep_from > 0:
            self._buf = self._buf[keep_from:]
            self._trimmed += keep_from

        return out

    @property
    def has_audio(self) -> bool:
        return self._total >= SAMPLE_RATE // 2  # at least 0.5s


class Pipeline:
    def __init__(self, cfg: Config):
        self.cfg = cfg

        log.info("init_pipeline")
        self.writer = TranscriptWriter(cfg.transcript_pipe)
        self.writer.send({"type": "status", "state": "ready"})

        self.transcriber = Transcriber(cfg.whisper_model, cfg.whisper_device, cfg.whisper_compute_type)
        self.diarizer = Diarizer(cfg.hf_token, cfg.min_speakers, cfg.max_speakers) if cfg.diarize else None
        self.tracker = SpeakerTracker(cfg.speakers_file)

        # Mic always = "You", loopback always = "Remote" (source-based identity).
        # If pyannote is available, it's used to split MULTIPLE remote speakers on loopback,
        # but mic vs loopback distinction is always source-driven.
        self.tracker.set_name("spk_mic", "You")
        self.tracker.set_name("spk_loopback", "Remote")

        self._segments: List[Dict[str, Any]] = []
        self._segments_lock = threading.Lock()

        if cfg.summarize:
            self.summarizer = Summarizer(
                model=cfg.ollama_model,
                host=cfg.ollama_host,
            )
            # Do NOT start the background thread — summary is generated once on stop only.
        else:
            self.summarizer = None

        self.receiver = AudioReceiver(cfg.audio_pipe)
        self.receiver.start()

        self.mic_stream = AudioStream(cfg.window_seconds, cfg.step_seconds)
        self.loop_stream = AudioStream(cfg.window_seconds, cfg.step_seconds)

    def _process_stream(self, stream: AudioStream, source_tag: int):
        if not stream.has_audio or not stream.ready():
            return

        audio, win_start_abs = stream.get_window()
        if len(audio) < SAMPLE_RATE // 2:
            return

        segments = self.transcriber.transcribe(audio)
        if not segments:
            stream.emit([], win_start_abs)  # still advance committed position
            return

        # Diarization
        if self.diarizer and self.diarizer.available:
            turns = self.diarizer.diarize(audio)
            segments = self.diarizer.assign_speakers(segments, turns)

        confirmed = stream.emit(segments, win_start_abs)
        source_name = "mic" if source_tag == SOURCE_MIC else "loopback"

        for seg in confirmed:
            text = seg.get("text", "").strip()
            if not text:
                continue

            # Speaker assignment:
            # Mic = always "You". Loopback = "Remote" or diarized remote speakers.
            if source_tag == SOURCE_MIC:
                stable_id = "spk_mic"
            elif self.diarizer and self.diarizer.available:
                pyannote_label = seg.get("speaker", "SPEAKER_00")
                # Prefix with "loop_" so loopback labels never collide with mic labels
                seg_s = int(seg["start"] * SAMPLE_RATE)
                seg_e = int(seg["end"] * SAMPLE_RATE)
                seg_audio = audio[seg_s:seg_e] if seg_e <= len(audio) else None
                stable_id = self.tracker.resolve(f"loop_{pyannote_label}", seg_audio)
                if self.tracker.get_name(stable_id) == stable_id:
                    remote_n = sum(1 for s in self.tracker._speakers
                                   if s.startswith("spk_") and s not in ("spk_mic", "spk_loopback"))
                    self.tracker.set_name(stable_id, f"Remote {remote_n + 1}")
            else:
                stable_id = "spk_loopback"

            speaker_name = self.tracker.get_name(stable_id)

            msg = {
                "type": "segment",
                "id": str(uuid.uuid4()),
                "speaker_id": stable_id,
                "speaker_name": speaker_name,
                "source": source_name,
                "start_us": seg["start_us"],
                "end_us": seg["end_us"],
                "text": text,
            }

            self.writer.send(msg)
            with self._segments_lock:
                self._segments.append(msg)

    def run(self):
        log.info("pipeline_running")

        try:
            while True:
                try:
                    chunk = self.receiver.queue.get(timeout=0.1)
                except queue.Empty:
                    # No data yet — still process buffered audio
                    self._process_stream(self.mic_stream, SOURCE_MIC)
                    self._process_stream(self.loop_stream, SOURCE_LOOPBACK)
                    continue

                if chunk is None:
                    # Sentinel — audio-capture stopped (clean or killed)
                    log.info("end_of_stream")
                    break

                if chunk.source == SOURCE_MIC:
                    self.mic_stream.add(chunk)
                else:
                    self.loop_stream.add(chunk)

                self._process_stream(self.mic_stream, SOURCE_MIC)
                self._process_stream(self.loop_stream, SOURCE_LOOPBACK)

        except KeyboardInterrupt:
            log.info("pipeline_interrupted")
        finally:
            if self.summarizer:
                log.info("generating_final_summary")
                with self._segments_lock:
                    segments_snapshot = list(self._segments)
                self.summarizer.update_segments(segments_snapshot)
                final = self.summarizer._summarize_now()
                self.writer.send({"type": "final_summary", "text": final or ""})
            self.writer.send({"type": "status", "state": "stopped"})
            self.writer.close()
            log.info("pipeline_stopped")


def main():
    import logging
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(),
    )

    config_path = os.path.join(os.path.dirname(__file__), "..", "config.toml")
    cfg = Config.load(config_path)
    log.info("config_loaded", whisper=cfg.whisper_model, diarize=cfg.diarize)

    pipeline = Pipeline(cfg)
    pipeline.run()


if __name__ == "__main__":
    main()
