"""
CorpoDrone Python pipeline — persistent service entry point.

Flow:
  Tauri spawns this process once at app startup (models loaded once).
  For each recording session:
    AudioReceiver (named pipe) → chunk queue
    → AudioStream accumulates samples and tracks committed position
    → every step_seconds: transcribe + diarize the current window
    → only emit segments that are "confirmed" (end before last step_seconds of window)
      and haven't been emitted before → eliminates duplicates from sliding windows
    → SpeakerTracker maps labels → stable IDs
    → TranscriptWriter sends to Rust
    → after audio-capture exits (sentinel), do post-processing
    → wait for {"cmd": "set_mode", "mode": "..."} on stdin from Tauri
    → re-transcribe / summarize → send final_summary
    → reset per-session state → wait for next session
"""
import json
import os
import sys
import queue
import threading
import uuid
from typing import List, Dict, Any, Optional

import numpy as np
import structlog
import torch

# PyTorch 2.6 changed torch.load to default weights_only=True, which breaks
# pyannote/whisperx checkpoints containing non-tensor globals (e.g. omegaconf types).
# lightning_fabric explicitly passes weights_only=None, which PyTorch 2.6 treats as True.
# Intercept None → False to restore pre-2.6 behaviour for these trusted local files.
_torch_load_orig = torch.load
def _torch_load_compat(*args, **kwargs):
    if kwargs.get("weights_only") is None:
        kwargs["weights_only"] = False
    return _torch_load_orig(*args, **kwargs)
torch.load = _torch_load_compat

from config import Config
from audio_receiver import AudioReceiver, AudioChunk, SOURCE_MIC, SOURCE_LOOPBACK
from transcriber import Transcriber
from diarizer import Diarizer
from speaker_tracker import SpeakerTracker
from summarizer import Summarizer
from transcript_writer import TranscriptWriter
from embedding_extractor import EmbeddingExtractor
from speaker_database import SpeakerDatabase

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


class SessionRecorder:
    """Accumulates all raw audio chunks for end-of-session high-quality re-transcription."""

    def __init__(self):
        self._chunks: List[AudioChunk] = []
        self._lock = threading.Lock()

    def add(self, chunk: AudioChunk):
        with self._lock:
            self._chunks.append(chunk)

    def get_audio(self, source_tag: int):
        """Returns (audio_array, base_timestamp_us) for the given source, or (None, 0)."""
        with self._lock:
            chunks = [c for c in self._chunks if c.source == source_tag]
        if not chunks:
            return None, 0
        return np.concatenate([c.samples for c in chunks]), chunks[0].timestamp_us


class CommandReader(threading.Thread):
    """Reads JSON-line commands from stdin and puts them on a queue."""

    def __init__(self, cmd_queue: queue.Queue):
        super().__init__(daemon=True, name="cmd-reader")
        self._q = cmd_queue

    def run(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self._q.put(json.loads(line))
            except json.JSONDecodeError:
                log.warning("cmd_reader_invalid_json", line=line[:120])


class Pipeline:
    def __init__(self, cfg: Config):
        self.cfg = cfg

        log.info("init_pipeline")
        self.writer = TranscriptWriter(cfg.transcript_pipe)

        # Heavy models — loaded once, reused across sessions
        self.transcriber = Transcriber(cfg.whisper_model, cfg.whisper_device, cfg.whisper_compute_type)
        self.diarizer = Diarizer(cfg.hf_token, cfg.min_speakers, cfg.max_speakers) if cfg.diarize else None
        self._speaker_db = SpeakerDatabase(cfg.speaker_db_file, cfg.speaker_identify_threshold)
        self._embedder = EmbeddingExtractor(cfg.whisper_device) if cfg.speaker_enroll else None
        self.summarizer = Summarizer(model=cfg.ollama_model, host=cfg.ollama_host) if cfg.summarize else None

        # Stdin command channel (Tauri writes JSON-line commands)
        self._cmd_queue: queue.Queue = queue.Queue()
        CommandReader(self._cmd_queue).start()

        # Per-session constants (never change)
        self._MAX_CLIPS = 4
        self._CLIP_TARGET_S = 3.0
        self._segments_lock = threading.Lock()

        # Initialise per-session state and start the first AudioReceiver
        self._session_id = 0
        self._init_session_state()

        # Signal the frontend that all models are loaded and we're ready to record.
        self.writer.send({"type": "status", "state": "ready"})

    # ------------------------------------------------------------------
    # Per-session state management
    # ------------------------------------------------------------------

    def _init_session_state(self):
        """
        Create/reset all mutable per-session state.
        Called once at startup (from __init__) and after each session completes.
        """
        self._session_id += 1
        session = self._session_id  # capture for closure / background threads

        self.receiver = AudioReceiver(self.cfg.audio_pipe)
        self.receiver.start()

        self.mic_stream = AudioStream(self.cfg.window_seconds, self.cfg.step_seconds)
        self.loop_stream = AudioStream(self.cfg.window_seconds, self.cfg.step_seconds)
        self.session_recorder = SessionRecorder()

        self.tracker = SpeakerTracker(self.cfg.speakers_file, encoder=self._embedder)
        self.tracker.set_name("spk_mic", "You")
        self.tracker.set_name("spk_loopback", "Remote")

        with self._segments_lock:
            self._segments: List[Dict[str, Any]] = []
        self._clip_accum: Dict[str, np.ndarray] = {}
        self._clip_store: Dict[str, List[np.ndarray]] = {}
        self._identified_in_session: set = set()

        log.info("session_state_initialised", session_id=session)

    # ------------------------------------------------------------------
    # Stream processing (called every step during recording)
    # ------------------------------------------------------------------

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
                seg_s = int(seg["start"] * SAMPLE_RATE)
                seg_e = int(seg["end"] * SAMPLE_RATE)
                seg_audio = audio[seg_s:seg_e] if seg_e <= len(audio) else None
                stable_id = self.tracker.resolve(f"loop_{pyannote_label}", seg_audio)
                if self.tracker.get_name(stable_id) == stable_id:
                    remote_n = sum(1 for s in self.tracker._speakers
                                   if s.startswith("spk_") and s not in ("spk_mic", "spk_loopback"))
                    self.tracker.set_name(stable_id, f"Remote {remote_n + 1}")

                # Accumulate audio clips for this loopback speaker for enrollment
                if seg_audio is not None and len(seg_audio) > 0:
                    self._accumulate_clip(stable_id, seg_audio)
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

    def _accumulate_clip(self, stable_id: str, audio: np.ndarray):
        """Append audio to the per-speaker accumulator; finalize into a clip when ≥3s."""
        if len(self._clip_store.get(stable_id, [])) >= self._MAX_CLIPS:
            return
        acc = self._clip_accum.get(stable_id, np.array([], dtype=np.float32))
        acc = np.concatenate([acc, audio])
        target = int(self._CLIP_TARGET_S * SAMPLE_RATE)
        if len(acc) >= target:
            clip = acc[:target]
            is_first_clip = stable_id not in self._clip_store
            self._clip_store.setdefault(stable_id, []).append(clip)
            self._clip_accum[stable_id] = acc[target:]
            # First clip ready: try live DB identification in background
            if is_first_clip and stable_id not in self._identified_in_session:
                self._identified_in_session.add(stable_id)
                captured_session = self._session_id
                threading.Thread(
                    target=self._identify_speaker_live,
                    args=(stable_id, clip, captured_session),
                    daemon=True,
                ).start()
        else:
            self._clip_accum[stable_id] = acc

    def _find_stable_id_by_name(self, name: str) -> Optional[str]:
        """Return the stable_id already assigned to this name, or None."""
        for sid, info in self.tracker._speakers.items():
            if info.get("name") == name:
                return sid
        return None

    def _apply_identification(self, stable_id: str, person_name: str):
        """
        Assign person_name to stable_id. If another stable_id already has this name,
        merge stable_id into that one and emit speaker_merge; otherwise emit speaker_update.
        """
        existing_id = self._find_stable_id_by_name(person_name)
        if existing_id and existing_id != stable_id:
            self.tracker.merge_into(stable_id, existing_id)
            self._clip_store.setdefault(existing_id, []).extend(self._clip_store.pop(stable_id, []))
            self._clip_accum.pop(stable_id, None)
            self._identified_in_session.discard(stable_id)
            self.writer.send({"type": "speaker_merge", "from_id": stable_id, "into_id": existing_id, "name": person_name})
        else:
            self.tracker.set_name(stable_id, person_name)
            self.writer.send({"type": "speaker_update", "speaker_id": stable_id, "name": person_name})

    def _identify_speaker_live(self, stable_id: str, audio: np.ndarray, session_id: int):
        """Background: try to identify a loopback speaker against DB once the first 3s clip is ready."""
        if not self._embedder or not self._embedder.available:
            return
        embedding = self._embedder.extract(audio)
        if embedding is None:
            return
        # Guard: discard result if the session has already been reset
        if self._session_id != session_id:
            return
        person_id, person_name, score = self._speaker_db.identify(embedding)
        if person_id:
            log.info("live_speaker_identified", stable_id=stable_id, name=person_name, score=round(score, 3))
            self._apply_identification(stable_id, person_name)
        else:
            log.info("live_speaker_not_matched", stable_id=stable_id, best_score=round(score, 3))

    # ------------------------------------------------------------------
    # Post-session helpers
    # ------------------------------------------------------------------

    def _collect_enrollment_data(self) -> List[Dict[str, Any]]:
        """
        For each loopback diarized speaker:
          - Try to identify against the DB using their collected clips
          - If identified: send speaker_update so the UI shows the known name retroactively
          - If unknown: include in enrollment payload (clips + computed embedding)
        Returns list of {session_id, name, clips: [base64wav], embedding: [float]} for unknowns.
        """
        import io, wave, base64

        def to_base64_wav(samples: np.ndarray) -> str:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)
                w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
            return base64.b64encode(buf.getvalue()).decode()

        unknowns = []

        for stable_id, clips in list(self._clip_store.items()):
            if not clips:
                continue

            # Skip if this stable_id was already merged into another during live identification
            if stable_id not in self.tracker._speakers:
                continue

            # Concatenate all clips for a better embedding estimate
            combined = np.concatenate(clips)
            embedding = self._embedder.extract(combined) if self._embedder and self._embedder.available else None

            if embedding is not None:
                person_id, person_name, score = self._speaker_db.identify(embedding)
                if person_id:
                    log.info("speaker_identified", stable_id=stable_id, name=person_name, score=round(score, 3))
                    self._apply_identification(stable_id, person_name)
                    continue  # known — no enrollment needed
                log.info("speaker_not_identified", stable_id=stable_id, best_score=round(score, 3),
                         threshold=self._speaker_db._threshold)

            # Unknown speaker — prepare per-clip enrollment payload
            current_name = self.tracker.get_name(stable_id)
            clip_payloads = []
            for clip in clips[:self._MAX_CLIPS]:
                clip_emb = self._embedder.extract(clip) if self._embedder and self._embedder.available else None
                clip_payloads.append({
                    "audio": to_base64_wav(clip),
                    "embedding": clip_emb.tolist() if clip_emb is not None else [],
                })
            unknowns.append({
                "session_id": stable_id,
                "name": current_name,
                "clips": clip_payloads,
            })

        return unknowns

    def _wait_for_mode(self) -> str:
        """
        Block until Tauri sends {"cmd": "set_mode", "mode": "..."} on stdin.
        No timeout — the user can take as long as they need.
        """
        while True:
            try:
                cmd = self._cmd_queue.get(timeout=0.5)
                if cmd.get("cmd") == "set_mode":
                    mode = cmd.get("mode", "retranscribe")
                    log.info("pipeline_mode_received", mode=mode)
                    return mode if mode in ("retranscribe", "live") else "retranscribe"
            except queue.Empty:
                continue

    def _identify_loopback_speakers(self, audio: np.ndarray, segments: list) -> dict:
        """
        Given (optionally diarized) loopback segments, extract per-speaker embeddings
        and identify against the DB.  Returns {pyannote_label -> display_name}.

        Slices each speaker's audio into 5-second chunks, extracts one embedding per
        chunk, then averages them into a centroid.  Feeding the full concatenated audio
        to ECAPA directly gives a poor embedding because the model was trained on short
        utterances; the centroid approach is both more accurate and avoids OOM on long
        sessions.
        """
        from collections import defaultdict
        CLIP_SAMPLES = 5 * SAMPLE_RATE   # 5-second chunks
        MAX_CLIPS = 10                   # cap at 50 s per speaker

        spk_audio: dict = defaultdict(list)
        for seg in segments:
            label = seg.get("speaker", "SPEAKER_00")
            s = int(seg["start"] * SAMPLE_RATE)
            e = int(seg["end"] * SAMPLE_RATE)
            if e > s and e <= len(audio):
                spk_audio[label].append(audio[s:e])

        spk_map = {}
        remote_counter = 0
        for label, chunks in spk_audio.items():
            if not chunks:
                continue
            if self._embedder and self._embedder.available:
                combined = np.concatenate(chunks)
                normed_embs = []
                for i in range(0, len(combined), CLIP_SAMPLES):
                    clip = combined[i:i + CLIP_SAMPLES]
                    emb = self._embedder.extract(clip)
                    if emb is not None:
                        n = np.linalg.norm(emb)
                        if n > 1e-9:
                            normed_embs.append(emb / n)
                    if len(normed_embs) >= MAX_CLIPS:
                        break

                if normed_embs:
                    centroid = np.mean(normed_embs, axis=0)
                    c_norm = np.linalg.norm(centroid)
                    if c_norm > 1e-9:
                        centroid /= c_norm
                        person_id, person_name, score = self._speaker_db.identify(centroid)
                        if person_id:
                            spk_map[label] = person_name
                            log.info("retranscribe_speaker_identified",
                                     label=label, name=person_name,
                                     score=round(score, 3), n_clips=len(normed_embs))
                            continue

            remote_counter += 1
            spk_map[label] = "Remote" if remote_counter == 1 else f"Remote {remote_counter}"
        return spk_map

    def _build_final_transcript_with_progress(self):
        """
        Re-transcribes the full session audio (mic + loopback separately) using the
        same transcriber already loaded for live transcription (no extra model load).
        Emits progress events during processing.
        Returns (transcript_text, segments) where segments = [{speaker, text, start_us}].
        Falls back to the live-segment transcript on any failure.
        """
        log.info("final_transcription_starting", model=self.cfg.whisper_model)

        # Reload speaker DB to pick up any embeddings enrolled during the modal
        self._speaker_db._load()

        self.writer.send({"type": "progress", "stage": "retranscribe", "pct": 0, "label": "Starting re-transcription…"})

        sources = [(SOURCE_MIC, "You"), (SOURCE_LOOPBACK, "Remote")]
        result_segs = []

        for i, (source_tag, speaker_label) in enumerate(sources):
            # Each source occupies half of the 0-100 retranscribe range
            range_start = i * 50
            range_end = range_start + 50

            self.writer.send({"type": "progress", "stage": "retranscribe",
                              "pct": range_start, "label": f"Transcribing {speaker_label}…"})
            audio, base_us = self.session_recorder.get_audio(source_tag)
            if audio is None or len(audio) < SAMPLE_RATE:
                self.writer.send({"type": "progress", "stage": "retranscribe",
                                  "pct": range_end, "label": f"{speaker_label} — no audio"})
                continue
            log.info("transcribing_source", source=speaker_label,
                     seconds=round(len(audio) / SAMPLE_RATE))

            def make_cb(rs, re, lbl):
                def cb(seg_pct):
                    overall = rs + (re - rs) * seg_pct / 100
                    self.writer.send({"type": "progress", "stage": "retranscribe",
                                      "pct": int(overall), "label": f"Transcribing {lbl}…"})
                return cb

            try:
                segs = self.transcriber.transcribe_with_progress(audio, make_cb(range_start, range_end, speaker_label))

                if source_tag == SOURCE_LOOPBACK:
                    if self.diarizer and self.diarizer.available:
                        turns = self.diarizer.diarize(audio)
                        segs = self.diarizer.assign_speakers(segs, turns)
                    spk_map = self._identify_loopback_speakers(audio, segs)

                for seg in segs:
                    text = seg.get("text", "").strip()
                    if text:
                        abs_us = base_us + int(seg["start"] * 1_000_000)
                        if source_tag == SOURCE_MIC:
                            name = speaker_label
                        else:
                            label = seg.get("speaker", "SPEAKER_00")
                            name = spk_map.get(label, "Remote")
                        result_segs.append((abs_us, name, text))
            except Exception as e:
                log.error("final_transcription_failed", source=speaker_label, error=str(e))
                self.writer.send({"type": "progress", "stage": "retranscribe",
                                  "pct": range_end, "label": f"{speaker_label} — failed"})

        self.writer.send({"type": "progress", "stage": "retranscribe", "pct": 95, "label": "Sorting segments…"})

        if not result_segs:
            return self._fallback_transcript(), []

        result_segs.sort(key=lambda x: x[0])
        transcript_text = "\n".join(f"{spk}: {text}" for _, spk, text in result_segs)
        transcript_segs = [{"speaker": spk, "text": text, "start_us": us} for us, spk, text in result_segs]

        self.writer.send({"type": "progress", "stage": "retranscribe", "pct": 100, "label": "Re-transcription complete"})
        return transcript_text, transcript_segs

    def _fallback_transcript(self) -> str:
        with self._segments_lock:
            segs = list(self._segments)
        lines = []
        for seg in segs:
            spk = seg.get("speaker_name", "Unknown")
            text = seg.get("text", "").strip()
            if text:
                lines.append(f"{spk}: {text}")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Session loop
    # ------------------------------------------------------------------

    def _run_session(self):
        """
        Process one recording session: consume audio until sentinel, then do
        post-processing (enrollment → mode selection → transcription → summary).
        Returns normally on clean session end; raises KeyboardInterrupt to stop.
        """
        log.info("session_starting", session_id=self._session_id)
        ended_normally = False

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
                    ended_normally = True
                    break

                if chunk.source == SOURCE_MIC:
                    if not os.path.exists(".mic_muted"):
                        self.mic_stream.add(chunk)
                        self.session_recorder.add(chunk)
                else:
                    self.loop_stream.add(chunk)
                    self.session_recorder.add(chunk)

                self._process_stream(self.mic_stream, SOURCE_MIC)
                self._process_stream(self.loop_stream, SOURCE_LOOPBACK)

        except KeyboardInterrupt:
            log.info("session_interrupted")
            raise

        if not ended_normally:
            return

        # --- Post-processing ---
        if self._clip_store and self.cfg.speaker_enroll:
            enrollment_speakers = self._collect_enrollment_data()
            if enrollment_speakers:
                self.writer.send({"type": "enrollment_data", "speakers": enrollment_speakers})

        self.writer.send({"type": "status", "state": "session_ended"})

        mode = self._wait_for_mode()
        transcript_segs = []
        if mode == "retranscribe":
            transcript_text, transcript_segs = self._build_final_transcript_with_progress()
        else:
            log.info("using_live_transcript")
            transcript_text = self._fallback_transcript()

        if self.summarizer:
            log.info("generating_final_summary")
            self.writer.send({"type": "progress", "stage": "summarize", "pct": 0, "label": "Generating debrief…"})
            self.summarizer.set_transcript_text(transcript_text)

            def summarize_progress_cb(pct):
                self.writer.send({"type": "progress", "stage": "summarize",
                                  "pct": pct, "label": "Generating debrief…"})

            final = self.summarizer._summarize_now(progress_cb=summarize_progress_cb)
            self.writer.send({"type": "final_summary", "text": final or "", "transcript": transcript_segs})
        else:
            self.writer.send({"type": "final_summary", "text": "", "transcript": transcript_segs})

        log.info("session_complete", session_id=self._session_id)

    def run(self):
        """
        Outer loop: run sessions back-to-back until the process is killed or
        interrupted. Models stay loaded in memory across sessions.
        """
        try:
            while True:
                self._run_session()
                # Reset per-session state and start a fresh AudioReceiver for the next session
                self._init_session_state()
        except KeyboardInterrupt:
            log.info("pipeline_interrupted")
        finally:
            self.writer.send({"type": "status", "state": "stopped"})
            self.writer.close()
            log.info("pipeline_stopped")


def _suppress_library_warnings():
    """Silence known-harmless warnings from third-party ML libraries."""
    import warnings
    import logging

    # torch.load weights_only FutureWarning (speechbrain, lightning_fabric)
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*weights_only.*")
    # torch.cuda.amp.custom_fwd deprecated (speechbrain)
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*custom_fwd.*")
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*custom_bwd.*")
    # speechbrain SYMLINK on Windows
    warnings.filterwarnings("ignore", category=UserWarning, message=".*SYMLINK.*")
    warnings.filterwarnings("ignore", category=UserWarning, message=".*symlink.*")
    # pyannote version mismatch ("Model was trained with pyannote.audio 0.0.1...")
    warnings.filterwarnings("ignore", category=UserWarning, message=".*pyannote.audio 0.*")
    warnings.filterwarnings("ignore", category=UserWarning, message=".*torch 1\\..*")
    # pyannote task-dependent loss function
    warnings.filterwarnings("ignore", category=UserWarning, message=".*task-dependent loss.*")
    # hf_xet missing (performance suggestion, not an error)
    warnings.filterwarnings("ignore", message=".*hf_xet.*")

    # Quiet pytorch_lightning upgrade/version chatter (INFO and WARNING go to stderr)
    for name in ("pytorch_lightning", "lightning_fabric", "lightning"):
        logging.getLogger(name).setLevel(logging.ERROR)

    # Quiet whisperx's internal VAD pipeline log spam
    logging.getLogger("whisperx").setLevel(logging.ERROR)
    logging.getLogger("whisperx.vads").setLevel(logging.ERROR)
    logging.getLogger("whisperx.vads.pyannote").setLevel(logging.ERROR)


def main():
    import logging
    _suppress_library_warnings()
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(),
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="%H:%M:%S", utc=False),
            structlog.processors.JSONRenderer(),
        ],
    )

    config_path = os.path.join(os.path.dirname(__file__), "..", "config.toml")
    cfg = Config.load(config_path)
    log.info("config_loaded", whisper=cfg.whisper_model, diarize=cfg.diarize)

    pipeline = Pipeline(cfg)
    pipeline.run()


if __name__ == "__main__":
    main()
