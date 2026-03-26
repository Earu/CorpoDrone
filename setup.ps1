# CorpoDrone setup script for Windows
# Run from the project root: .\setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== CorpoDrone Setup ===" -ForegroundColor Cyan

# Check Rust
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Rust not found. Install from https://rustup.rs" -ForegroundColor Red
    exit 1
}

# Find Python 3.11 or 3.12 via the py launcher
$pyExe = $null
foreach ($ver in @("3.12", "3.11")) {
    try {
        & py "-$ver" --version 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $pyExe = "py -$ver"; break }
    } catch {}
}
if (-not $pyExe) {
    Write-Host "ERROR: Python 3.11 or 3.12 not found." -ForegroundColor Red
    Write-Host "Install from https://python.org and re-run setup." -ForegroundColor Red
    exit 1
}
Write-Host "Using: $pyExe ($(&Invoke-Expression "$pyExe --version"))" -ForegroundColor Gray

# [1/4] Build Rust binaries
Write-Host "`n[1/4] Building Rust binaries..." -ForegroundColor Yellow
cargo build --release
if ($LASTEXITCODE -ne 0) { Write-Host "Rust build failed" -ForegroundColor Red; exit 1 }

# [2/4] Create .venv
Write-Host "`n[2/4] Creating .venv with $pyExe..." -ForegroundColor Yellow
if (Test-Path ".venv") {
    Write-Host ".venv already exists, skipping creation." -ForegroundColor Gray
} else {
    Invoke-Expression "$pyExe -m venv .venv"
    if ($LASTEXITCODE -ne 0) { Write-Host "venv creation failed" -ForegroundColor Red; exit 1 }
}

$pip    = ".\.venv\Scripts\pip.exe"
$python = ".\.venv\Scripts\python.exe"

# [3/4] Install PyTorch (CUDA 12.1) then remaining deps
Write-Host "`n[3/4] Installing Python dependencies..." -ForegroundColor Yellow
Write-Host "  Installing PyTorch (CUDA 12.1)..." -ForegroundColor Gray
& $pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch install failed" -ForegroundColor Red; exit 1 }

Write-Host "  Installing pipeline dependencies..." -ForegroundColor Gray
& $pip install -r python\requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Host "pip install failed" -ForegroundColor Red; exit 1 }

# Reinstall torch CUDA build — requirements.txt may have pulled in the CPU wheel
Write-Host "  Pinning PyTorch CUDA build..." -ForegroundColor Gray
& $pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121 --force-reinstall --no-deps
if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch re-pin failed" -ForegroundColor Red; exit 1 }

# Verify CUDA is visible
$cudaOk = & $python -c "import torch; print(torch.cuda.is_available())" 2>&1
Write-Host "  CUDA available: $cudaOk" -ForegroundColor $(if ($cudaOk -eq "True") { "Green" } else { "Yellow" })

# [4/4] HuggingFace token check
Write-Host "`n[4/4] HuggingFace token check..." -ForegroundColor Yellow
if (-not $env:HUGGINGFACE_TOKEN) {
    Write-Host "WARNING: HUGGINGFACE_TOKEN not set." -ForegroundColor Yellow
    Write-Host "  Speaker diarization requires:" -ForegroundColor Yellow
    Write-Host "  1. Accept model terms at https://hf.co/pyannote/speaker-diarization-3.1" -ForegroundColor Yellow
    Write-Host "  2. Set env var before running:" -ForegroundColor Yellow
    Write-Host "       `$env:HUGGINGFACE_TOKEN = 'hf_...'" -ForegroundColor White
} else {
    Write-Host "  Token found." -ForegroundColor Green
}

Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "To run CorpoDrone:" -ForegroundColor Cyan
Write-Host "  cargo run -p web-server --release" -ForegroundColor White
Write-Host "  Then open: http://localhost:8080" -ForegroundColor White
Write-Host ""
Write-Host "The web-server reads config.toml and auto-starts:" -ForegroundColor Gray
Write-Host "  .venv\Scripts\python.exe python\pipeline.py" -ForegroundColor Gray
