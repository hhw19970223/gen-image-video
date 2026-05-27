$ErrorActionPreference = "Continue"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$models = Join-Path $root "vendor/ComfyUI/models"
$log = Join-Path $root "data/wan22-download.log"

New-Item -ItemType Directory -Force -Path `
  (Join-Path $models "diffusion_models"), `
  (Join-Path $models "vae"), `
  (Join-Path $models "text_encoders"), `
  (Split-Path -Parent $log) | Out-Null

$files = @(
  @{
    Url = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
    Out = Join-Path $models "diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
  },
  @{
    Url = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors"
    Out = Join-Path $models "vae/wan2.2_vae.safetensors"
  },
  @{
    Url = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    Out = Join-Path $models "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
  }
)

"[$(Get-Date -Format s)] Wan2.2 5B download started" | Tee-Object -FilePath $log -Append
foreach ($file in $files) {
  "[$(Get-Date -Format s)] downloading $($file.Out)" | Tee-Object -FilePath $log -Append
  & curl.exe -L --fail -C - -o $file.Out $file.Url *>> $log
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed with exit code $LASTEXITCODE for $($file.Url)"
  }
}
"[$(Get-Date -Format s)] Wan2.2 5B download completed" | Tee-Object -FilePath $log -Append
