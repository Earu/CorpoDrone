"""
Shared pre-transcription gate: cheap RMS floor + Silero VAD speech fraction.

Runs the same path for MLX, WhisperX, and faster-whisper so platform parity holds.
"""
from __future__ import annotations

import numpy as np
import structlog

log = structlog.get_logger(__name__)

SAMPLE_RATE = 16_000
# Silero expects enough samples for at least one window
_MIN_SAMPLES = 512


class SpeechGate:
    def __init__(
        self,
        enabled: bool = True,
        rms_db_floor: float = -50.0,
        min_speech_fraction: float = 0.12,
        silero_threshold: float = 0.5,
    ):
        self.enabled = enabled
        self.rms_db_floor = rms_db_floor
        self.min_speech_fraction = min_speech_fraction
        self.silero_threshold = silero_threshold
        self._model = None
        self._get_speech_timestamps = None
        self._silero_unavailable = False
        self._logged_silero_fallback = False

    def should_transcribe(self, audio: np.ndarray) -> bool:
        """Return False to skip Whisper (silence / non-speech). Fail-open if VAD unavailable."""
        if not self.enabled:
            return True
        n = len(audio)
        if n < _MIN_SAMPLES:
            return True

        rms = float(np.sqrt(np.mean(np.square(audio.astype(np.float64)))))
        if rms < 1e-10:
            return False
        db = 20.0 * np.log10(rms)
        if db < self.rms_db_floor:
            return False

        if self._silero_unavailable:
            return self._rms_only_fallback()

        if not self._ensure_silero():
            return self._rms_only_fallback()

        import torch

        wav = torch.from_numpy(audio).float()
        if wav.dim() == 1:
            wav = wav.unsqueeze(0)
        try:
            ts = self._get_speech_timestamps(
                wav,
                self._model,
                sampling_rate=SAMPLE_RATE,
                threshold=self.silero_threshold,
            )
        except Exception as e:
            log.warning("silero_vad_inference_failed", error=str(e))
            return True

        if not ts:
            return False

        speech_samples = sum(int(t["end"]) - int(t["start"]) for t in ts)
        frac = speech_samples / float(n)
        return frac >= self.min_speech_fraction

    def _rms_only_fallback(self) -> bool:
        if not self._logged_silero_fallback:
            log.info("speech_gate_rms_only_silero_unavailable")
            self._logged_silero_fallback = True
        return True

    def _ensure_silero(self) -> bool:
        if self._model is not None:
            return True
        if self._silero_unavailable:
            return False
        try:
            import torch

            try:
                model, utils = torch.hub.load(
                    "snakers4/silero-vad",
                    "silero_vad",
                    force_reload=False,
                    trust_repo=True,
                )
            except TypeError:
                model, utils = torch.hub.load(
                    "snakers4/silero-vad",
                    "silero_vad",
                    force_reload=False,
                )
            get_speech_timestamps = utils[0]
            self._model = model
            self._get_speech_timestamps = get_speech_timestamps
            self._model.eval()
            log.info("silero_vad_loaded")
            return True
        except Exception as e:
            log.warning("silero_vad_load_failed", error=str(e))
            self._silero_unavailable = True
            return False
