"""
Whisper transcription with word-level timestamps.
Backend priority: mlx-whisper (Apple Silicon) → whisperx → faster-whisper.
"""
import numpy as np
import structlog
from typing import List, Dict, Any

log = structlog.get_logger(__name__)

SAMPLE_RATE = 16_000

# mlx-whisper uses HuggingFace repos instead of short model names
_MLX_MODEL_MAP = {
    "tiny":      "mlx-community/whisper-tiny-mlx",
    "tiny.en":   "mlx-community/whisper-tiny.en-mlx",
    "base":      "mlx-community/whisper-base-mlx",
    "base.en":   "mlx-community/whisper-base.en-mlx",
    "small":     "mlx-community/whisper-small-mlx",
    "small.en":  "mlx-community/whisper-small.en-mlx",
    "medium":    "mlx-community/whisper-medium-mlx",
    "medium.en": "mlx-community/whisper-medium.en-mlx",
    "large":     "mlx-community/whisper-large-v3-mlx",
    "large-v2":  "mlx-community/whisper-large-v2-mlx",
    "large-v3":  "mlx-community/whisper-large-v3-mlx",
}


def _resolve_device_and_compute(device: str, compute_type: str):
    """Resolve device for CTranslate2 (faster-whisper). MPS is NOT supported by CTranslate2."""
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"

    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"

    return device, compute_type


def _resolve_torch_device() -> str:
    """Resolve best PyTorch device, including MPS for Apple Silicon."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


class Transcriber:
    def __init__(self, model_name: str = "small", device: str = "auto", compute_type: str = "auto"):
        self.device, self.compute_type = _resolve_device_and_compute(device, compute_type)
        self.torch_device = _resolve_torch_device()
        log.info("loading_whisper", model=model_name, device=self.device, torch_device=self.torch_device, compute_type=self.compute_type)

        self._use_mlx = False
        self._use_whisperx = False

        # ── mlx-whisper: preferred on Apple Silicon (no CTranslate2, runs on Metal) ──
        if self.torch_device == "mps":
            try:
                import mlx_whisper
                self._mlx_whisper = mlx_whisper
                self._mlx_repo = _MLX_MODEL_MAP.get(model_name, f"mlx-community/whisper-{model_name}-mlx")
                self._use_mlx = True
                # Pre-load model now so HuggingFace download/verification happens at startup,
                # not on the first transcribe() call mid-session.
                log.info("mlx_whisper_loading", repo=self._mlx_repo)
                mlx_whisper.load_models.load_model(self._mlx_repo)
                log.info("mlx_whisper_loaded", repo=self._mlx_repo)
            except ImportError:
                log.info("mlx_whisper_not_found_falling_back")

        if not self._use_mlx:
            # ── whisperx: CTranslate2 transcription + PyTorch alignment ──
            try:
                import whisperx
                self._model = whisperx.load_model(
                    model_name,
                    self.device,
                    compute_type=self.compute_type,
                    language="en",
                )
                # Alignment model is pure PyTorch — can use MPS
                self._align_model, self._align_metadata = whisperx.load_align_model(
                    language_code="en",
                    device=self.torch_device,
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

        if self._use_mlx:
            return self._transcribe_mlx(audio)
        if self._use_whisperx:
            return self._transcribe_whisperx(audio)
        return self._transcribe_faster(audio)

    def transcribe_with_progress(self, audio: np.ndarray, progress_cb=None) -> List[Dict[str, Any]]:
        """
        Like transcribe() but calls progress_cb(pct) with 0-100 as processing advances.
        mlx-whisper: checkpoints at 0 and 100 (synchronous, no mid-run hooks).
        whisperx: checkpoints at 0, ~60 (after transcribe), 100 (after align).
        faster-whisper: smooth per-segment progress.
        """
        if len(audio) < SAMPLE_RATE * 0.5:
            return []

        def _cb(pct):
            if progress_cb:
                progress_cb(pct)

        if self._use_mlx:
            _cb(0)
            result = self._transcribe_mlx(audio)
            _cb(100)
            return result

        if self._use_whisperx:
            wx = self._whisperx
            _cb(0)
            result = self._model.transcribe(audio, batch_size=16)
            _cb(60)
            if not result.get("segments"):
                _cb(100)
                return []
            aligned = wx.align(
                result["segments"],
                self._align_model,
                self._align_metadata,
                audio,
                self.torch_device,
                return_char_alignments=False,
            )
            _cb(100)
            return aligned.get("segments", [])

        # faster-whisper: iterate the lazy generator for real per-segment progress
        total_s = len(audio) / SAMPLE_RATE
        segments_iter, _ = self._model.transcribe(
            audio, beam_size=5, word_timestamps=True, language="en",
        )
        segments = []
        for seg in segments_iter:
            words = []
            if seg.words:
                for w in seg.words:
                    words.append({"word": w.word, "start": w.start, "end": w.end})
            segments.append({"start": seg.start, "end": seg.end, "text": seg.text.strip(), "words": words})
            if total_s > 0:
                _cb(min(99, seg.end / total_s * 100))
        _cb(100)
        return segments

    def _transcribe_mlx(self, audio: np.ndarray) -> List[Dict[str, Any]]:
        result = self._mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self._mlx_repo,
            word_timestamps=True,
            language="en",
            condition_on_previous_text=False,
        )
        segments = []
        for seg in result.get("segments", []):
            words = [
                {"word": w["word"], "start": w["start"], "end": w["end"]}
                for w in seg.get("words", [])
            ]
            segments.append({
                "start": seg["start"],
                "end": seg["end"],
                "text": seg["text"].strip(),
                "words": words,
            })
        return segments

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
            self.torch_device,
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
