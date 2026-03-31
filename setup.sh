#!/usr/bin/env bash
# CorpoDrone first-time setup (Unix / Git Bash on Windows)
# Run once from the repository root: ./setup.sh
# Strict equivalent of setup.ps1

set -euo pipefail

cyan() { printf '\033[0;36m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
red() { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
gray() { printf '\033[0;90m%s\033[0m\n' "$*"; }
white() { printf '\033[1;37m%s\033[0m\n' "$*"; }

case "$(uname -s 2>/dev/null)" in
  Linux*)   CORPO_OS=linux ;;
  Darwin*)  CORPO_OS=macos ;;
  MINGW*|MSYS*|CYGWIN*) CORPO_OS=windows ;;
  *)        CORPO_OS=linux ;;
esac

cyan "=== CorpoDrone Setup ==="

# ── Find Python 3.11 or 3.12 ────────────────────────────────────────────────
PY_CMD=()
find_python() {
  local ver minor
  for ver in 3.12 3.11; do
    minor="${ver#*.}"
    if command -v py >/dev/null 2>&1 && py -"$ver" --version >/dev/null 2>&1; then
      PY_CMD=(py -"$ver")
      return 0
    fi
    if command -v "python$ver" >/dev/null 2>&1 && "python$ver" --version >/dev/null 2>&1; then
      PY_CMD=("python$ver")
      return 0
    fi
    if command -v "python3.$minor" >/dev/null 2>&1 && "python3.$minor" --version >/dev/null 2>&1; then
      PY_CMD=("python3.$minor")
      return 0
    fi
  done
  return 1
}

if ! find_python; then
  red "ERROR: Python 3.11 or 3.12 not found."
  red "  Download from https://python.org (check 'Add to PATH' during install)"
  exit 1
fi
gray "Python: $("${PY_CMD[@]}" --version)"

# ── [1/3] Create .venv ───────────────────────────────────────────────────────
yellow ""
yellow "[1/3] Creating Python virtual environment..."
if [[ -d .venv ]]; then
  gray "  .venv already exists, skipping."
else
  "${PY_CMD[@]}" -m venv .venv
fi

if [[ "$CORPO_OS" == windows ]]; then
  pip="./.venv/Scripts/pip.exe"
  python="./.venv/Scripts/python.exe"
else
  pip="./.venv/bin/pip"
  python="./.venv/bin/python"
fi

# torchaudio>=2.9 removed torchaudio.AudioMetaData; pyannote.audio (via whisperx) still needs it.
TORCH_PIN=('torch>=2.5.0,<2.9.0' 'torchaudio>=2.5.0,<2.9.0')

# ── [2/3] Install dependencies ───────────────────────────────────────────────
yellow ""
yellow "[2/3] Installing dependencies (this may take a while)..."

if [[ "$CORPO_OS" == windows ]]; then
  gray "  Installing PyTorch with CUDA 12.1 support..."
  "$pip" install "${TORCH_PIN[@]}" --index-url https://download.pytorch.org/whl/cu121
elif [[ "$CORPO_OS" == linux ]]; then
  gray "  Installing PyTorch (CPU wheels from PyPI)..."
  "$pip" install "${TORCH_PIN[@]}"
else
  gray "  Installing PyTorch (CPU/MPS for macOS)..."
  "$pip" install "${TORCH_PIN[@]}"
  gray "  Installing mlx-whisper (Apple Silicon transcription)..."
  "$pip" install mlx-whisper
fi

gray "  Installing pipeline dependencies..."
"$pip" install -r pipeline/requirements.txt

# Re-pin torch in case pipeline deps pulled a newer (incompatible) build
if [[ "$CORPO_OS" == windows ]]; then
  "$pip" install "${TORCH_PIN[@]}" --index-url https://download.pytorch.org/whl/cu121 --force-reinstall --no-deps
else
  "$pip" install "${TORCH_PIN[@]}" --force-reinstall --no-deps
fi

cuda_ok="$("$python" -c 'import torch; print(torch.cuda.is_available())' 2>&1 || true)"
if [[ "$cuda_ok" == "True" ]]; then
  green "  CUDA available: $cuda_ok"
else
  yellow "  CUDA available: $cuda_ok"
fi

# ── [3/3] HuggingFace token ──────────────────────────────────────────────────
yellow ""
yellow "[3/3] HuggingFace token (required for speaker diarization)..."

env_file="./.env"
token_set=false

if [[ -f "$env_file" ]] && grep -qE 'HUGGINGFACE_TOKEN[[:space:]]*=[[:space:]]*hf_[[:alnum:]_]+' "$env_file"; then
  green "  Token found in .env"
  token_set=true
fi

if [[ "$token_set" == false ]] && [[ "${HUGGINGFACE_TOKEN:-}" =~ ^hf_ ]]; then
  green "  Token found in environment variable."
  token_set=true
fi

if [[ "$token_set" == false ]]; then
  yellow "  No token found. Speaker diarization requires a HuggingFace token."
  echo ""
  white "  Steps:"
  white "    1. Create a free account at https://huggingface.co"
  white "    2. Accept terms at https://hf.co/pyannote/speaker-diarization-3.1"
  white "    3. Generate a token at https://hf.co/settings/tokens"
  echo ""
  printf '  Paste your token here (or press Enter to skip): '
  read -r token || true
  if [[ "$token" =~ ^hf_ ]]; then
    printf 'HUGGINGFACE_TOKEN=%s\n' "$token" > "$env_file"
    green "  Saved to .env"
  else
    yellow "  Skipped. You can add it later to .env:"
    gray "    HUGGINGFACE_TOKEN=hf_..."
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
green ""
green "=== Setup complete ==="
echo ""
cyan "Launch CorpoDrone:"
if [[ "$CORPO_OS" == windows ]]; then
  white "  Double-click corpo-drone.exe"
  gray "  (or: .\\\\corpo-drone.exe)"
else
  white "  From repo root: cargo tauri dev  (or run the packaged binary if you built a release)"
fi
echo ""
gray "On first run, PyAnnote models will be downloaded automatically (~1 GB)."
