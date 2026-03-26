"""
Maintains stable speaker identities across sliding windows.

PyAnnote resets speaker labels (SPEAKER_00, SPEAKER_01, ...) per inference call.
This module maps ephemeral pyannote labels → stable IDs (spk_0, spk_1, ...)
using speaker embeddings and cosine similarity.
Persists user-assigned names to speakers.json.
"""
import json
import os
from typing import Dict, List, Optional
import numpy as np
import structlog

log = structlog.get_logger(__name__)

SIMILARITY_THRESHOLD = 0.75


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom < 1e-9:
        return 0.0
    return float(np.dot(a, b) / denom)


class SpeakerTracker:
    def __init__(self, speakers_file: str = "speakers.json"):
        self.speakers_file = speakers_file
        # stable_id -> {"name": str, "embedding": np.ndarray | None}
        self._speakers: Dict[str, dict] = {}
        self._next_id = 0
        self._load()
        self._encoder = None
        self._init_encoder()

    def _init_encoder(self):
        try:
            from resemblyzer import VoiceEncoder
            self._encoder = VoiceEncoder()
            log.info("resemblyzer_loaded")
        except ImportError:
            log.warning("resemblyzer_not_found_speaker_tracking_by_label_only")

    def _load(self):
        if os.path.exists(self.speakers_file):
            try:
                with open(self.speakers_file) as f:
                    data = json.load(f)
                for entry in data:
                    sid = entry["id"]
                    self._speakers[sid] = {
                        "name": entry.get("name", sid),
                        "embedding": None,
                    }
                    idx = int(sid.replace("spk_", ""))
                    self._next_id = max(self._next_id, idx + 1)
                log.info("speakers_loaded", count=len(self._speakers))
            except Exception as e:
                log.warning("speakers_load_failed", error=str(e))

    def _save(self):
        try:
            data = [
                {"id": sid, "name": info["name"]}
                for sid, info in self._speakers.items()
            ]
            with open(self.speakers_file, "w") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            log.warning("speakers_save_failed", error=str(e))

    def _get_embedding(self, audio: np.ndarray, label: str) -> Optional[np.ndarray]:
        if self._encoder is None:
            return None
        try:
            from resemblyzer import preprocess_wav
            wav = preprocess_wav(audio, source_sr=16_000)
            return self._encoder.embed_utterance(wav)
        except Exception as e:
            log.debug("embed_failed", label=label, error=str(e))
            return None

    def _allocate_stable_id(self, embedding: Optional[np.ndarray]) -> str:
        """Find best matching stable speaker, or create a new one."""
        if embedding is not None:
            best_id = None
            best_sim = SIMILARITY_THRESHOLD
            for sid, info in self._speakers.items():
                emb = info.get("embedding")
                if emb is not None:
                    sim = cosine_sim(embedding, emb)
                    if sim > best_sim:
                        best_sim = sim
                        best_id = sid
            if best_id:
                # Update embedding with running average
                old = self._speakers[best_id]["embedding"]
                self._speakers[best_id]["embedding"] = (old + embedding) / 2.0
                return best_id

        # New speaker
        sid = f"spk_{self._next_id}"
        self._next_id += 1
        self._speakers[sid] = {
            "name": sid,
            "embedding": embedding,
        }
        self._save()
        log.info("new_speaker", id=sid)
        return sid

    # session-level mapping: pyannote_label -> stable_id
    _session_map: Dict[str, str] = {}

    def resolve(
        self,
        pyannote_label: str,
        audio_segment: Optional[np.ndarray] = None,
    ) -> str:
        """
        Map a pyannote ephemeral label to a stable speaker ID.
        Call once per segment. audio_segment is used for embedding if provided.
        """
        if pyannote_label in self._session_map:
            return self._session_map[pyannote_label]

        embedding = None
        if audio_segment is not None and len(audio_segment) > 3200:
            embedding = self._get_embedding(audio_segment, pyannote_label)

        stable_id = self._allocate_stable_id(embedding)
        self._session_map[pyannote_label] = stable_id
        return stable_id

    def get_name(self, speaker_id: str) -> str:
        return self._speakers.get(speaker_id, {}).get("name", speaker_id)

    def set_name(self, speaker_id: str, name: str):
        if speaker_id not in self._speakers:
            self._speakers[speaker_id] = {"name": name, "embedding": None}
        else:
            self._speakers[speaker_id]["name"] = name
        self._save()
        log.info("speaker_renamed", id=speaker_id, name=name)

    def reset_session(self):
        """Call at start of each recording session to clear label mapping."""
        self._session_map.clear()
