param(
  [switch]$Gpu
)

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$ComfyDir = Join-Path $Root 'vendor\ComfyUI'
$Python = Join-Path $ComfyDir '.venv\Scripts\python.exe'
$OutLog = Join-Path $Root 'data\comfyui.out.log'
$ErrLog = Join-Path $Root 'data\comfyui.err.log'

if (-not (Test-Path -LiteralPath (Join-Path $ComfyDir 'main.py'))) {
  throw "ComfyUI not found at $ComfyDir"
}

if (-not (Test-Path -LiteralPath $Python)) {
  throw "ComfyUI python not found at $Python"
}

try {
  Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8188/system_stats' -TimeoutSec 2 | Out-Null
  Write-Output 'ComfyUI is already running at http://127.0.0.1:8188'
  exit 0
} catch {
  # Not running yet.
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data') | Out-Null

$argsList = @('main.py', '--listen', '127.0.0.1', '--port', '8188')
if (-not $Gpu) {
  $argsList += '--cpu'
}

Start-Process `
  -FilePath $Python `
  -ArgumentList $argsList `
  -WorkingDirectory $ComfyDir `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden

Write-Output "ComfyUI starting at http://127.0.0.1:8188"
Write-Output "Logs: $OutLog"
