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
  -d noarchive `
  --name intass_engine `
  --distpath build_engine\dist `
  --workpath build_engine\work `
  --specpath build_engine\spec `
  --collect-all numpy `
  --collect-all transformers `
  --collect-all tokenizers `
  --collect-all safetensors `
  --collect-all huggingface_hub `
  --collect-all sentence_transformers `
  --collect-all langchain `
  --collect-all langchain_core `
  --collect-all langchain_community `
  --collect-all langchain_huggingface `
  --collect-all langchain_text_splitters `
  --collect-all faiss `
  --collect-all faiss_cpu `
  --copy-metadata faiss-cpu `
  --copy-metadata transformers `
  --copy-metadata tokenizers `
  --copy-metadata safetensors `
  --copy-metadata huggingface_hub `
  --copy-metadata sentence-transformers `
  --copy-metadata langchain `
  --copy-metadata langchain-core `
  --copy-metadata langchain-community `
  --copy-metadata langchain-text-splitters `
  --copy-metadata langchain-huggingface `
  --copy-metadata google-genai `
  --collect-all google_genai `
  --copy-metadata google-genai `
  src\engine.py


if ($LASTEXITCODE -ne 0) { Fail "PyInstaller failed (exit $LASTEXITCODE)" }

# --- Stage Vosk binaries into output ---
$EngineOutDir     = Join-Path $ProjectRoot "build_engine\dist\intass_engine"
$TargetVoskDir    = Join-Path $EngineOutDir "_internal\vosk"

Info "Sanity check: transformers models folder exists?"
$TfModels = Join-Path $EngineOutDir "_internal\transformers\models"
if (-not (Test-Path $TfModels)) { Fail "Missing transformers models folder in build: $TfModels" }

Info "Sanity check: faiss binary exists?"
$FaissBin = Get-ChildItem -Path $EngineOutDir -Recurse -Filter "faiss*.pyd" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $FaissBin) { Warn "FAISS .pyd not found in build output (may crash when indexing). Check faiss-cpu collection." }

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
