# CorpoDrone

Capture audio from your microphone and speakers simultaneously, transcribe with Whisper, identify who's talking with speaker diarization, and summarize the full session with a local LLM, all displayed in a desktop UI.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)

<img width="1238" height="1069" alt="image" src="https://github.com/user-attachments/assets/0557b96e-1c64-4365-92da-ef4978b4145c" />
<img width="1238" height="1070" alt="image" src="https://github.com/user-attachments/assets/936935db-219e-4bdb-ba82-54f12b07c41d" />

## Features

- **Dual audio capture**: mic input and loopback (speaker output) captured simultaneously
- **Real-time transcription**: sliding window Whisper transcription with word-level timestamps
- **Speaker diarization**: PyAnnote 3.1 assigns speaker labels to each segment
- **Persistent speaker identities**: ECAPA-TDNN embeddings match speakers across sessions; enroll names for future recognition
- **Session summary**: full audio re-transcribed at session end, then summarized by a local Ollama LLM
- **Live UI**: Tauri desktop app with transcript panel, speaker sidebar, and log drawer
- **Apple Silicon acceleration**: uses mlx-whisper on M-series Macs for fast on-device transcription via Metal

## Architecture

<img width="1176" height="415" alt="image" src="https://github.com/user-attachments/assets/6d48aa17-afd3-484c-bc95-100fc8b20c67" />

**IPC**: Tauri spawns `audio-capture` and `pipeline.py` as child processes. Audio flows over a named pipe (Windows) or POSIX FIFO (macOS) as framed binary. Transcript segments and commands flow as JSON lines over a second pipe and stdin/stdout.

## Requirements

- Windows 10/11 or macOS (Apple Silicon recommended)
- [Rust + cargo](https://rustup.rs)
- Python 3.10–3.12
- [Node.js](https://nodejs.org) (for Tauri CLI)
- [Ollama](https://ollama.com) running locally with a model (default: `mistral`)
- A HuggingFace account with access accepted for both:
  - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
  - [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) (used internally by the diarization pipeline)

### macOS additional requirements

- **Screen Recording permission** granted to your terminal app (for loopback capture via ScreenCaptureKit)
- **Microphone permission** granted to your terminal app
- [PowerShell](https://github.com/PowerShell/PowerShell) (`brew install --cask powershell`) to run `setup.ps1`

## Setup

### 1. Clone

```bash
git clone https://github.com/your-username/CorpoDrone
cd CorpoDrone
```

### 2. Configure

Copy the environment template and add your HuggingFace token:

```bash
cp .env.example .env
# Edit .env and set HUGGINGFACE_TOKEN=hf_...
```

Edit `config.toml` to adjust the Whisper model size, speaker limits, Ollama model, etc.

### 3. Python environment

Use the provided setup script (works on both Windows and macOS):

```powershell
./setup.ps1
```

Or manually:

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS:
source .venv/bin/activate

pip install -r pipeline/requirements.txt
```

### 4. Pull Ollama model

```bash
ollama pull mistral
```

### 5. Build and run

```bash
cargo tauri dev
```

For a production build:

```bash
cargo tauri build
```

## Configuration

`config.toml` at the project root controls all runtime behavior:

| Key | Default | Description |
|-----|---------|-------------|
| `python.whisper_model` | `small` | Whisper model size (`tiny` / `base` / `small` / `medium` / `large-v3`) |
| `python.diarize` | `true` | Enable speaker diarization (requires HF token) |
| `python.min_speakers` | `1` | Minimum expected speakers |
| `python.max_speakers` | `8` | Maximum expected speakers |
| `python.window_seconds` | `20.0` | Sliding window length for real-time transcription |
| `python.step_seconds` | `3.0` | How often to process a new window |
| `python.summarize` | `true` | Generate LLM summary at session end |
| `python.ollama_model` | `mistral` | Ollama model for summarization |
| `python.ollama_host` | `http://localhost:11434` | Ollama API endpoint |
| `server.python_exe` | `.venv/Scripts/python.exe` (Win) / `.venv/bin/python` (mac) | Python interpreter path |

## Speaker Database

Speaker embeddings are stored in `speakers_db.json`. When a new speaker is detected whose voice doesn't match any known profile (cosine similarity < 0.58), they get a temporary label. At session end, you can enroll them with a name — that name will be used automatically in future sessions.

To reset the database, delete `speakers_db.json`.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop framework | [Tauri 2](https://tauri.app) (Rust) |
| Audio capture (Windows) | [WASAPI](https://learn.microsoft.com/en-us/windows/win32/coreaudio/wasapi) via `wasapi` crate |
| Audio capture (macOS) | [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) (loopback) + [cpal](https://github.com/RustAudio/cpal) / CoreAudio (mic) |
| Audio resampling | [Rubato](https://github.com/HEnquist/rubato) |
| Transcription (Apple Silicon) | [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) — runs on Metal via MLX |
| Transcription (other) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) + [WhisperX](https://github.com/m-bain/whisperX) |
| Diarization | [PyAnnote 3.1](https://github.com/pyannote/pyannote-audio) |
| Speaker embeddings | [SpeechBrain ECAPA-TDNN](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb) |
| Summarization | [Ollama](https://ollama.com) |
| Structured logging | [structlog](https://www.structlog.org) (Python) + [tracing](https://docs.rs/tracing) (Rust) |
| Frontend | Vanilla JS / CSS |
