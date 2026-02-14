<#
  build-engine.ps1
  Builds the Python engine via PyInstaller and stages Vosk binaries into the output folder.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\build-engine.ps1

  Notes:
    - Requires python on PATH
    - Requires PyInstaller installed in the python environment
    - Expects:
        models\model-en-us
        resources\
        src\engine.py
#>

$ErrorActionPreference = "Stop"

function Info($msg){ Write-Host "[build-engine] $msg" -ForegroundColor Cyan }
function Warn($msg){ Write-Host "[build-engine] $msg" -ForegroundColor Yellow }
function Fail($msg){ Write-Host "[build-engine] ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- Clean build folders ---
Info "Cleaning build folders..."
Remove-Item -Recurse -Force build_engine\dist -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force build_engine\work -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force build_engine\spec -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue

# --- Resolve paths ---
$ProjectRoot = (Resolve-Path .).Path
$ModelDir    = Join-Path $ProjectRoot "models\model-en-us"

Info "ProjectRoot: $ProjectRoot"
Info "ModelDir   : $ModelDir"

# --- Find vosk package directory from current python ---
Info "Locating Vosk package directory..."
$VoskPkgDir = python -c "import vosk, os; print(os.path.dirname(vosk.__file__))" 2>$null
if (-not $VoskPkgDir) { Fail "Could not locate vosk package directory. Is vosk installed in this python environment?" }
Info "VoskPkgDir : $VoskPkgDir"

# --- Sanity checks ---
if (-not (Test-Path $ModelDir)) { Fail "Missing model dir: $ModelDir" }
if (-not (Test-Path $VoskPkgDir)) { Fail "Missing vosk pkg dir: $VoskPkgDir" }

# --- Build with PyInstaller ---
Info "Running PyInstaller..."
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name intass_engine `
  --distpath build_engine\dist `
  --workpath build_engine\work `
  --specpath build_engine\spec `
  --collect-all numpy `
  --hidden-import numpy._core._exceptions `
  --hidden-import numpy.core._multiarray_umath `
  --hidden-import numpy.linalg._umath_linalg `
  src\engine.py

# --- Stage Vosk binaries into output ---
$EngineOutDir     = Join-Path $ProjectRoot "build_engine\dist\intass_engine"
$TargetVoskDir    = Join-Path $EngineOutDir "_internal\vosk"

Info "Staging Vosk binaries..."
New-Item -ItemType Directory -Force -Path $TargetVoskDir | Out-Null

# Copy top-level .dll / .pyd
Copy-Item -Force -ErrorAction SilentlyContinue (Join-Path $VoskPkgDir "*.dll") $TargetVoskDir
Copy-Item -Force -ErrorAction SilentlyContinue (Join-Path $VoskPkgDir "*.pyd") $TargetVoskDir

# Copy nested .dll (if any)
Get-ChildItem $VoskPkgDir -Recurse -Filter *.dll -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item -Force $_.FullName $TargetVoskDir
}

Info "Vosk folder contents (first 10):"
Get-ChildItem $TargetVoskDir | Select-Object -First 10 | Format-Table -AutoSize

Info "DONE. Engine output: $EngineOutDir"
