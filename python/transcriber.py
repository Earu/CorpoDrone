"""
WhisperX-based transcription with word-level timestamps.
Falls back to faster-whisper if WhisperX is unavailable.
"""
import numpy as np
import structlog
from typing import List, Dict, Any

log = structlog.get_logger(__name__)

SAMPLE_RATE = 16_000


def _resolve_device_and_compute(device: str, compute_type: str):
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"

    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"

    return device, compute_type


class Transcriber:
    def __init__(self, model_name: str = "small", device: str = "auto", compute_type: str = "auto"):
        self.device, self.compute_type = _resolve_device_and_compute(device, compute_type)
        log.info("loading_whisper", model=model_name, device=self.device, compute_type=self.compute_type)

        self._use_whisperx = False
        try:
            import whisperx
            self._model = whisperx.load_model(
                model_name,
                self.device,
                compute_type=self.compute_type,
                language="en",
            )
            # Load alignment model
            self._align_model, self._align_metadata = whisperx.load_align_model(
                language_code="en",
                device=self.device,
            )
            self._whisperx = whisperx
            self._use_whisperx = True
            log.info("whisperx_loaded")
        except ImportError:
            log.warning("whisperx_not_found_falling_back_to_faster_whisper")
            from faster_whisper import WhisperModel
            self._model = WhisperModel(model_name, device=self.device, compute_type=self.compute_type)

    def transcribe(self, audio: np.ndarray) -> List[Dict[str, Any]]:
        """
        Transcribe audio array (float32, 16kHz mono).
        Returns list of segments: [{start, end, text, words: [{word, start, end}]}]
        """
        if len(audio) < SAMPLE_RATE * 0.5:
            return []

        if self._use_whisperx:
            return self._transcribe_whisperx(audio)
        return self._transcribe_faster(audio)

    def _transcribe_whisperx(self, audio: np.ndarray) -> List[Dict[str, Any]]:
        wx = self._whisperx
        result = self._model.transcribe(audio, batch_size=16)
        if not result.get("segments"):
            return []
        aligned = wx.align(
            result["segments"],
            self._align_model,
            self._align_metadata,
            audio,
            self.device,
            return_char_alignments=False,
        )
        return aligned.get("segments", [])

    def _transcribe_faster(self, audio: np.ndarray) -> List[Dict[str, Any]]:
        segments_iter, _ = self._model.transcribe(
            audio,
            beam_size=5,
            word_timestamps=True,
            language="en",
        )
        segments = []
        for seg in segments_iter:
            words = []
            if seg.words:
                for w in seg.words:
                    words.append({"word": w.word, "start": w.start, "end": w.end})
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
                "words": words,
            })
        return segments
