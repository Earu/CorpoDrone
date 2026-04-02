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


def _default_pipe(name: str) -> str:
    if sys.platform == "win32":
        return rf"\\.\pipe\corpodrone-{name}"
    return f"/tmp/corpodrone-{name}"


@dataclass
class Config:
    # Named pipe / FIFO paths (platform-specific defaults)
    audio_pipe: str = _default_pipe("audio")
    transcript_pipe: str = _default_pipe("transcript")
    control_pipe: str = _default_pipe("control")

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

    # Pre-transcription speech gate (RMS + Silero VAD) — same on all ASR backends
    speech_gate_enabled: bool = True
    speech_gate_rms_db_floor: float = -50.0
    speech_gate_min_speech_fraction: float = 0.12
    speech_gate_silero_threshold: float = 0.5

    # Summarization (generated once at end of session)
    summarize: bool = True
    ollama_model: str = "mistral"
    ollama_host: str = "http://localhost:11434"

    # Speaker persistence
    speakers_file: str = "speakers.json"

    # Speaker identity database (cross-session recognition + enrollment)
    speaker_db_file: str = "speakers_db.json"
    speaker_identify_threshold: float = 0.58  # cosine similarity threshold for a match
    speaker_enroll: bool = True               # show enrollment modal after sessions

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
