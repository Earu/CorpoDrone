"""
PyAnnote speaker diarization wrapper.
"""
import numpy as np
import structlog
import torch
from typing import List, Dict, Any, Tuple, Optional

log = structlog.get_logger(__name__)

SAMPLE_RATE = 16_000


class Diarizer:
    def __init__(self, hf_token: str, min_speakers: int = 1, max_speakers: int = 8):
        if not hf_token:
            log.warning(
                "no_hf_token",
                msg="Set HUGGINGFACE_TOKEN env var and accept model terms at "
                    "hf.co/pyannote/speaker-diarization-3.1",
            )
        self.min_speakers = min_speakers
        self.max_speakers = max_speakers
        self._pipeline = None

        try:
            from pyannote.audio import Pipeline
            log.info("loading_pyannote_diarization")
            self._pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=hf_token or True,
            )
            if torch.cuda.is_available():
                device = "cuda"
            elif torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"
            self._pipeline.to(torch.device(device))
            log.info("pyannote_loaded", device=device)
        except Exception as e:
            log.error("pyannote_load_failed", error=str(e))
            log.warning("diarization_disabled")

    @property
    def available(self) -> bool:
        return self._pipeline is not None

    def diarize(self, audio: np.ndarray) -> List[Dict[str, Any]]:
        """
        Run diarization on audio (float32, 16kHz mono).
        Returns list of {start, end, speaker} dicts.
        """
        if self._pipeline is None or len(audio) < SAMPLE_RATE * 1.0:
            return []

        waveform = torch.from_numpy(audio).unsqueeze(0)  # (1, samples)
        try:
            diarization = self._pipeline(
                {"waveform": waveform, "sample_rate": SAMPLE_RATE},
                min_speakers=self.min_speakers,
                max_speakers=self.max_speakers,
            )
        except Exception as e:
            log.error("diarization_error", error=str(e))
            return []

        turns = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            turns.append({
                "start": turn.start,
                "end": turn.end,
                "speaker": speaker,
            })
        return turns

    def assign_speakers(
        self,
        segments: List[Dict[str, Any]],
        turns: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Map transcription segments to speaker labels from diarization turns.
        Uses overlap-based assignment.
        """
        result = []
        for seg in segments:
            seg_start = seg["start"]
            seg_end = seg["end"]
            best_speaker = "SPEAKER_00"
            best_overlap = 0.0

            for turn in turns:
                overlap = min(seg_end, turn["end"]) - max(seg_start, turn["start"])
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_speaker = turn["speaker"]

            result.append({**seg, "speaker": best_speaker})
        return result
