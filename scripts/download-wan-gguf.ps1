param(
  [string]$OutDir = "models/wan-gguf",
  [string]$ComfyUIDir = ""
)

$ErrorActionPreference = "Stop"

$files = @(
  @{
    Name = "wan2.1_t2v_1.3b-q2_k.gguf"
    Url = "https://huggingface.co/calcuis/wan-1.3b-gguf/resolve/main/wan2.1_t2v_1.3b-q2_k.gguf"
    ComfySubdir = "models/diffusion_models"
  },
  @{
    Name = "umt5-xxl-encoder-q4_k_m.gguf"
    Url = "https://huggingface.co/calcuis/wan-1.3b-gguf/resolve/main/umt5-xxl-encoder-q4_k_m.gguf"
    ComfySubdir = "models/text_encoders"
  },
  @{
    Name = "pig_wan_vae_fp32-f16.gguf"
    Url = "https://huggingface.co/calcuis/wan-1.3b-gguf/resolve/main/pig_wan_vae_fp32-f16.gguf"
    ComfySubdir = "models/vae"
  }
)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($file in $files) {
  $target = Join-Path $OutDir $file.Name
  if (Test-Path $target) {
    Write-Host "[resume/check] $target"
  } else {
    Write-Host "[download] $($file.Name)"
  }
  & curl.exe -L --fail --retry 5 --retry-delay 5 --continue-at - --output $target $file.Url
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed for $($file.Name) with exit code $LASTEXITCODE"
  }

  if ($ComfyUIDir) {
    $dstDir = Join-Path $ComfyUIDir $file.ComfySubdir
    $dst = Join-Path $dstDir $file.Name
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    if (!(Test-Path $dst)) {
      Write-Host "[copy] $dst"
      Copy-Item -LiteralPath $target -Destination $dst
    }
  }
}

Write-Host "[done] Wan GGUF files are ready."
