# CorpoDrone first-time setup
# Run once after extracting the zip: .\setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== CorpoDrone Setup ===" -ForegroundColor Cyan

# ── Find Python 3.11 or 3.12 ────────────────────────────────────────────────
$pyExe = $null
foreach ($ver in @("3.12", "3.11")) {
    try {
        & py "-$ver" --version 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $pyExe = "py -$ver"; break }
    } catch {}
}
if (-not $pyExe) {
    Write-Host "ERROR: Python 3.11 or 3.12 not found." -ForegroundColor Red
    Write-Host "  Download from https://python.org (check 'Add to PATH' during install)" -ForegroundColor Red
    exit 1
}
Write-Host "Python: $(&Invoke-Expression "$pyExe --version")" -ForegroundColor Gray

# ── [1/3] Create .venv ───────────────────────────────────────────────────────
Write-Host "`n[1/3] Creating Python virtual environment..." -ForegroundColor Yellow
if (Test-Path ".venv") {
    Write-Host "  .venv already exists, skipping." -ForegroundColor Gray
} else {
    Invoke-Expression "$pyExe -m venv .venv"
    if ($LASTEXITCODE -ne 0) { Write-Host "venv creation failed" -ForegroundColor Red; exit 1 }
}

$pip    = ".\.venv\Scripts\pip.exe"
$python = ".\.venv\Scripts\python.exe"

# ── [2/3] Install dependencies ───────────────────────────────────────────────
Write-Host "`n[2/3] Installing dependencies (this may take a while)..." -ForegroundColor Yellow

Write-Host "  Installing PyTorch with CUDA 12.1 support..." -ForegroundColor Gray
& $pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch install failed" -ForegroundColor Red; exit 1 }

Write-Host "  Installing pipeline dependencies..." -ForegroundColor Gray
& $pip install -r pipeline\requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Host "Dependency install failed" -ForegroundColor Red; exit 1 }

# Re-pin the CUDA torch build in case requirements.txt pulled in the CPU wheel
& $pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121 --force-reinstall --no-deps
if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch re-pin failed" -ForegroundColor Red; exit 1 }

$cudaOk = & $python -c "import torch; print(torch.cuda.is_available())" 2>&1
Write-Host "  CUDA available: $cudaOk" -ForegroundColor $(if ($cudaOk -eq "True") { "Green" } else { "Yellow" })

# ── [3/3] HuggingFace token ──────────────────────────────────────────────────
Write-Host "`n[3/3] HuggingFace token (required for speaker diarization)..." -ForegroundColor Yellow

$envFile = ".\.env"
$tokenSet = $false

# Check .env file first
if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($envContent -match "HUGGINGFACE_TOKEN\s*=\s*hf_\w+") {
        Write-Host "  Token found in .env" -ForegroundColor Green
        $tokenSet = $true
    }
}

# Check environment variable
if (-not $tokenSet -and $env:HUGGINGFACE_TOKEN -match "^hf_") {
    Write-Host "  Token found in environment variable." -ForegroundColor Green
    $tokenSet = $true
}

if (-not $tokenSet) {
    Write-Host "  No token found. Speaker diarization requires a HuggingFace token." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Steps:" -ForegroundColor White
    Write-Host "    1. Create a free account at https://huggingface.co" -ForegroundColor White
    Write-Host "    2. Accept terms at https://hf.co/pyannote/speaker-diarization-3.1" -ForegroundColor White
    Write-Host "    3. Generate a token at https://hf.co/settings/tokens" -ForegroundColor White
    Write-Host ""
    $token = Read-Host "  Paste your token here (or press Enter to skip)"
    if ($token -match "^hf_") {
        Set-Content $envFile "HUGGINGFACE_TOKEN=$token"
        Write-Host "  Saved to .env" -ForegroundColor Green
    } else {
        Write-Host "  Skipped. You can add it later to .env:" -ForegroundColor Yellow
        Write-Host "    HUGGINGFACE_TOKEN=hf_..." -ForegroundColor Gray
    }
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Launch CorpoDrone:" -ForegroundColor Cyan
Write-Host "  Double-click corpo-drone.exe" -ForegroundColor White
Write-Host "  (or: .\corpo-drone.exe)" -ForegroundColor Gray
Write-Host ""
Write-Host "On first run, PyAnnote models will be downloaded automatically (~1 GB)." -ForegroundColor Gray
