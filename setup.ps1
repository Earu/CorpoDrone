# CorpoDrone first-time setup
# Run once after extracting the zip: .\setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# OS flags via .NET (do not use $IsLinux / $IsWindows — missing or wrong under Windows PowerShell 5.1)
$OSPlatform = [System.Runtime.InteropServices.OSPlatform]
$Ri = [System.Runtime.InteropServices.RuntimeInformation]
if ($Ri::IsOSPlatform($OSPlatform::Windows)) {
    $CorpoOS = "windows"
} elseif ($Ri::IsOSPlatform($OSPlatform::Linux)) {
    $CorpoOS = "linux"
} elseif ($Ri::IsOSPlatform($OSPlatform::OSX)) {
    $CorpoOS = "macos"
} else {
    $CorpoOS = "linux" # other Unix: CPU torch, no mlx-whisper
}

Write-Host "=== CorpoDrone Setup ===" -ForegroundColor Cyan

# ── Find Python 3.11 or 3.12 ────────────────────────────────────────────────
$pyExe = $null
foreach ($ver in @("3.12", "3.11")) {
    # Try Windows Python Launcher first, then direct python3.X (macOS/Linux)
    foreach ($candidate in @("py -$ver", "python$ver", "python3.$($ver.Split('.')[1])")) {
        try {
            $parts = $candidate -split ' '
            $cmd = $parts[0]
            $extraArgs = if ($parts.Length -gt 1) { $parts[1..($parts.Length-1)] } else { @() }
            & $cmd ($extraArgs + @("--version")) 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $pyExe = $candidate; break }
        } catch {}
    }
    if ($pyExe) { break }
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

if ($CorpoOS -eq "windows") {
    $pip    = ".\.venv\Scripts\pip.exe"
    $python = ".\.venv\Scripts\python.exe"
} else {
    $pip    = "./.venv/bin/pip"
    $python = "./.venv/bin/python"
}

# ── [2/3] Install dependencies ───────────────────────────────────────────────
Write-Host "`n[2/3] Installing dependencies (this may take a while)..." -ForegroundColor Yellow

if ($CorpoOS -eq "windows") {
    Write-Host "  Installing PyTorch with CUDA 12.1 support..." -ForegroundColor Gray
    & $pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
    if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch install failed" -ForegroundColor Red; exit 1 }
} elseif ($CorpoOS -eq "linux") {
    Write-Host "  Installing PyTorch (CPU wheels from PyPI)..." -ForegroundColor Gray
    & $pip install torch torchaudio
    if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch install failed" -ForegroundColor Red; exit 1 }
} else {
    # macOS
    Write-Host "  Installing PyTorch (CPU/MPS for macOS)..." -ForegroundColor Gray
    & $pip install torch torchaudio
    if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch install failed" -ForegroundColor Red; exit 1 }
    Write-Host "  Installing mlx-whisper (Apple Silicon transcription)..." -ForegroundColor Gray
    & $pip install mlx-whisper
    if ($LASTEXITCODE -ne 0) { Write-Host "mlx-whisper install failed" -ForegroundColor Red; exit 1 }
}

Write-Host "  Installing pipeline dependencies..." -ForegroundColor Gray
$reqFile = if ($CorpoOS -eq "windows") { "pipeline\requirements.txt" } else { "pipeline/requirements.txt" }
& $pip install -r $reqFile
if ($LASTEXITCODE -ne 0) { Write-Host "Dependency install failed" -ForegroundColor Red; exit 1 }

# Re-pin the correct torch build in case requirements.txt overrode it
if ($CorpoOS -eq "windows") {
    & $pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121 --force-reinstall --no-deps
    if ($LASTEXITCODE -ne 0) { Write-Host "PyTorch re-pin failed" -ForegroundColor Red; exit 1 }
}

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
if ($CorpoOS -eq "windows") {
    Write-Host "  Double-click corpo-drone.exe" -ForegroundColor White
    Write-Host "  (or: .\corpo-drone.exe)" -ForegroundColor Gray
} else {
    Write-Host "  From repo root: cargo tauri dev  (or run the packaged binary if you built a release)" -ForegroundColor White
}
Write-Host ""
Write-Host "On first run, PyAnnote models will be downloaded automatically (~1 GB)." -ForegroundColor Gray
