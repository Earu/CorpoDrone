"""Configuration for the CorpoDrone Python pipeline."""
from dataclasses import dataclass, field
import os
import sys


def _load_dotenv(path: str) -> None:
    """Minimal .env loader — sets env vars that aren't already set."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib


@dataclass
class Config:
    # Named pipe paths
    audio_pipe: str = r"\\.\pipe\corpodrone-audio"
    transcript_pipe: str = r"\\.\pipe\corpodrone-transcript"
    control_pipe: str = r"\\.\pipe\corpodrone-control"

    # Whisper
    whisper_model: str = "small"          # tiny/base/small/medium/large-v3
    whisper_device: str = "auto"          # auto/cuda/cpu
    whisper_compute_type: str = "auto"    # auto/float16/int8

    # Diarization
    hf_token: str = ""                    # HuggingFace token for pyannote
    diarize: bool = True
    min_speakers: int = 1
    max_speakers: int = 8

    # Sliding window for real-time processing
    window_seconds: float = 5.0           # transcription window size
    step_seconds: float = 1.0            # how often to process a new window

    # Summarization (generated once at end of session)
    summarize: bool = True
    summarize_model: str = "medium"   # Whisper model for final re-transcription (better quality)
    ollama_model: str = "mistral"
    ollama_host: str = "http://localhost:11434"

    # Speaker persistence
    speakers_file: str = "speakers.json"

    @classmethod
    def load(cls, path: str = "config.toml") -> "Config":
        cfg = cls()

        # Load .env from project root (next to config.toml) before reading env vars
        env_path = os.path.join(os.path.dirname(path), ".env")
        _load_dotenv(env_path)

        # Override from env vars
        cfg.hf_token = os.environ.get("HUGGINGFACE_TOKEN", cfg.hf_token)

        # Override from TOML if it exists
        if os.path.exists(path):
            with open(path, "rb") as f:
                data = tomllib.load(f)
            for k, v in data.get("python", {}).items():
                if hasattr(cfg, k):
                    setattr(cfg, k, v)
        return cfg
