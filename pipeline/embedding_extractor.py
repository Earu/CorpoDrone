"""
Speaker embedding extraction using speechbrain's ECAPA-TDNN model.
Public model — no HuggingFace token required.
Falls back gracefully (returns None) if unavailable.
"""
import numpy as np
import structlog
from typing import Optional

log = structlog.get_logger(__name__)

SAMPLE_RATE = 16_000
MIN_DURATION_S = 1.5  # minimum clip length for a meaningful embedding


class EmbeddingExtractor:
    def __init__(self, device: str = "auto"):
        self._model = None

        try:
            import torch

            dev = device
            if dev == "auto":
                dev = "cuda" if torch.cuda.is_available() else "cpu"

            # Try new speechbrain import path (>=1.0), fall back to legacy (<1.0)
            try:
                from speechbrain.inference.speaker import EncoderClassifier
            except ImportError:
                from speechbrain.pretrained import EncoderClassifier

            log.info("loading_speaker_embedding_model", backend="ecapa-tdnn")
            self._model = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                run_opts={"device": dev},
                savedir=".speechbrain_models",
            )
            self._device = dev
            log.info("speaker_embedding_model_loaded", device=dev)
        except Exception as e:
            log.error("embedding_model_load_failed", error=str(e))
            log.warning("speaker_identification_disabled")

    @property
    def available(self) -> bool:
        return self._model is not None

    def extract(self, audio: np.ndarray) -> Optional[np.ndarray]:
        """
        Extract a speaker embedding from audio (float32, 16kHz mono).
        Returns a 1-D float32 ndarray, or None on failure.
        """
        if not self.available:
            return None
        if len(audio) < int(MIN_DURATION_S * SAMPLE_RATE):
            return None
        try:
            import torch
            waveform = torch.tensor(audio, dtype=torch.float32).unsqueeze(0)  # (1, samples)
            with torch.no_grad():
                embedding = self._model.encode_batch(waveform)
            return embedding.squeeze().cpu().numpy().astype(np.float32)
        except Exception as e:
            log.error("embedding_extraction_failed", error=str(e))
            return None
