# CorpoDrone

Capture audio from your microphone and speakers simultaneously, transcribe with Whisper, identify who's talking with speaker diarization, and summarize the full session with a local LLM, all displayed in a desktop UI.

>### Legal Notice
>CorpoDrone captures and processes audio on your machine. **You alone** are responsible for how you use it: local laws, consent, notice, workplace rules, and data-protection requirements are on you. The authors and contributors **disclaim liability** for any use or misuse. This is **not legal advice**; if in doubt, don’t run it or ask a lawyer.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
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
- **Linux**: mic via [cpal](https://github.com/RustAudio/cpal) (ALSA; PipeWire’s ALSA layer works). Loopback records the **default output monitor** over PulseAudio’s API (`libpulse-simple`), which PipeWire normally exposes via **pipewire-pulse** compatibility

## Architecture

<img width="1176" height="415" alt="image" src="https://github.com/user-attachments/assets/6d48aa17-afd3-484c-bc95-100fc8b20c67" />

**IPC**: Tauri spawns `audio-capture` and `pipeline.py` as child processes. Audio flows over a named pipe (Windows) or POSIX FIFO (macOS / Linux) as framed binary. Transcript segments and commands flow as JSON lines over a second pipe and stdin/stdout.

**Loopback source selection (UI)**: On **macOS**, starting a recording opens an app picker so you can include per-app ScreenCaptureKit streams (e.g. Discord) alongside the display mix. On **Windows** and **Linux**, loopback is the **full desktop mix** only; there is no picker.

## Requirements

- **Windows** 10/11, **macOS** (Apple Silicon recommended), or **64-bit Linux** (glibc; typical desktop with PulseAudio or PipeWire+pulse compat)
- [Rust + cargo](https://rustup.rs)
- **Python 3.11 or 3.12** (3.13 is not supported by parts of the WhisperX / pyannote stack yet)
- [Node.js](https://nodejs.org) (for Tauri CLI)
- [Ollama](https://ollama.com) running locally with a model matching your `config.toml` (e.g. `ollama pull mistral`)
- A HuggingFace account with access accepted for both:
  - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
  - [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) (used internally by the diarization pipeline)

### macOS additional requirements

- **Screen Recording permission** granted to your terminal app (for loopback capture via ScreenCaptureKit)
- **Microphone permission** granted to your terminal app
- **`./setup.sh`** in Bash, or [PowerShell](https://github.com/PowerShell/PowerShell) (`brew install --cask powershell`) for `pwsh ./setup.ps1`

### Linux additional requirements

The Tauri UI depends on the usual **WebKitGTK + GTK 3** stack ([Tauri Linux prerequisites](https://tauri.app/start/prerequisites/)). Full desktop installations typically include those libraries; **minimal or server images** and **containers** often do not, which surfaces as missing shared libraries when building or running prebuilt binaries.

#### Building from source

Debian/Ubuntu-style packages:

- `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `libssl-dev`, `pkg-config`, `build-essential`

**`audio-capture`**:

- **`libasound2-dev`** (ALSA) — mic capture via cpal  
- **`libpulse-dev`** — loopback via `libpulse-simple` (PipeWire works when the PulseAudio compatibility layer and `pactl` are available)

**Python pipeline**: system **libsndfile** (e.g. `libsndfile1`) for `soundfile`, and **ffmpeg** on `PATH` where the Whisper stack requires it.

#### Runtime libraries (prebuilt binaries)

Install **WebKitGTK** for the Tauri webview (GTK/Cairo/GLib and related libs are pulled in as dependencies). **PulseAudio** and **ALSA** client libraries are listed explicitly for **audio-capture**.

- **Debian / Ubuntu**: `sudo apt install libwebkit2gtk-4.1-0 libpulse0 libasound2`
- **Fedora**: `sudo dnf install webkitgtk4.1 pulseaudio-libs alsa-lib`
- **Arch Linux**: `sudo pacman -S webkitgtk-4.1 libpulse alsa-lib`

Package names vary by release; adjust as needed.

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

### 3. Python environment (required)

Install the Python stack with **`setup.ps1`** or **`setup.sh`**. Both create `.venv`, install **PyTorch** / **torchaudio** (CUDA on Windows, CPU on Linux, CPU/MPS on macOS), **mlx-whisper** on macOS, then `pipeline/requirements.txt`, and can prompt for your HuggingFace token.

From the repo root:

**macOS / Linux** (Bash — includes Git Bash on Windows):

```bash
./setup.sh
```

**Windows**, or any OS with [PowerShell 7+](https://github.com/PowerShell/PowerShell) (`pwsh`):

```powershell
pwsh ./setup.ps1
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
| `python.speech_gate_enabled` | `true` | Skip Whisper on silent windows (RMS + Silero VAD; reduces silence hallucinations). **Settings** exposes presets (“Standard”, “Stricter”, “Softer”) and optional expert fields |
| `python.speech_gate_rms_db_floor` | `-50.0` | Fast path: below this RMS (dBFS) → no transcription |
| `python.speech_gate_min_speech_fraction` | `0.12` | Silero: minimum fraction of the window labeled speech |
| `python.speech_gate_silero_threshold` | `0.5` | Silero speech probability threshold (higher = stricter) |
| `python.summarize` | `true` | Generate LLM summary at session end |
| `python.ollama_model` | `mistral` | Ollama model for summarization |
| `python.ollama_host` | `http://localhost:11434` | Ollama API endpoint |
| `server.python_exe` | `.venv/Scripts/python.exe` (Win) / `.venv/bin/python` (Unix) | Python interpreter path |

## Speaker Database

Speaker embeddings are stored in `speakers_db.json`. When a new speaker is detected whose voice doesn't match any known profile (cosine similarity < 0.58), they get a temporary label. At session end, you can enroll them with a name — that name will be used automatically in future sessions.

To reset the database, delete `speakers_db.json`.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop framework | [Tauri 2](https://tauri.app) (Rust) |
| Audio capture (Windows) | [WASAPI](https://learn.microsoft.com/en-us/windows/win32/coreaudio/wasapi) via `wasapi` crate |
| Audio capture (macOS) | [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) (loopback) + [cpal](https://github.com/RustAudio/cpal) / CoreAudio (mic) |
| Audio capture (Linux) | [cpal](https://github.com/RustAudio/cpal) / ALSA (mic) + PulseAudio **simple API** / `libpulse-simple` (default **sink monitor** loopback; PipeWire via pulse compat) |
| Audio resampling | [Rubato](https://github.com/HEnquist/rubato) |
| Transcription (Apple Silicon) | [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) — runs on Metal via MLX |
| Transcription (other) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) + [WhisperX](https://github.com/m-bain/whisperX) |
| Live speech gate | RMS prefilter + [Silero VAD](https://github.com/snakers4/silero-vad) via `torch.hub` (before Whisper on all platforms) |
| Diarization | [PyAnnote 3.1](https://github.com/pyannote/pyannote-audio) |
| Speaker embeddings | [SpeechBrain ECAPA-TDNN](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb) |
| Summarization | [Ollama](https://ollama.com) |
| Structured logging | [structlog](https://www.structlog.org) (Python) + [tracing](https://docs.rs/tracing) (Rust) |
| Frontend | Vanilla JS / CSS |
