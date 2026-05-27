# Frame AI Video

Frame is a local AI short-video workflow:

1. Codex expands the user prompt into a video-level director plan.
2. The backend sends the final prompt to a ComfyUI GGUF Wan workflow.
3. FFmpeg transcodes the ComfyUI WebM output to MP4 and extracts a cover image.

The project no longer uses the Diffusers `WanPipeline` worker. Wan generation is now routed through ComfyUI with fully quantized GGUF components.

## Requirements

- Node.js 20+
- FFmpeg, or the bundled `ffmpeg-static` package
- Codex CLI, optional but recommended
- ComfyUI under `vendor/ComfyUI`, running on `http://127.0.0.1:8188`
- ComfyUI custom nodes:
  - `calcuis/gguf`
  - `ComfyUI-VideoHelperSuite` is optional for extra video utilities; the default workflow uses ComfyUI's built-in `SaveWEBM` node.
- Wan GGUF model files placed in ComfyUI model folders.

## Install ComfyUI

This app expects ComfyUI to live inside this repository at:

```text
vendor/ComfyUI
```

Keep ComfyUI in this folder so the app, model files, startup scripts, and logs stay under one deployable project directory.

## Local Assets and Git

The repository intentionally does not commit runtime-heavy or machine-specific assets:

```text
.env.local
vendor/
models/
data/
```

Set these up on each machine during deployment:

- Copy `.env.example` to `.env.local` and edit local paths, CPU/GPU mode, Codex settings, and timeouts.
- Install or move ComfyUI into `vendor/ComfyUI`.
- Download Wan GGUF model files into `models/` as a local cache, then copy them into `vendor/ComfyUI/models/...`.
- Keep generated videos, SQLite data, cache files, and logs under `data/`.

Do not push GGUF model files to GitHub. They are multi-GB binaries and should be downloaded during deployment or stored in a model artifact store.

### Option A: Windows Portable

For Windows, the portable package is the simplest setup:

1. Download the ComfyUI Windows portable package from the official ComfyUI release/download page.
2. Extract it to `vendor\ComfyUI`.
3. Start it through this project's npm scripts.
4. Open `http://127.0.0.1:8188` and confirm the ComfyUI page loads.

### Option B: Manual Git Install

Manual install is useful when you want full control over Python, CUDA, or custom nodes:

```powershell
git clone https://github.com/Comfy-Org/ComfyUI.git vendor\ComfyUI
cd vendor\ComfyUI
python -m venv .venv
.\.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Start from the app root with GPU:

```powershell
npm run comfyui:gpu
```

Start from the app root with CPU:

```powershell
npm run comfyui:cpu
```

CPU mode is supported only when this app has `COMFYUI_ALLOW_CPU=true`.

## Install ComfyUI GGUF Node

The current workflow requires GGUF loader nodes. The health check expects these ComfyUI node classes:

```text
LoaderGGUF
ClipLoaderGGUF
VaeGGUF
EmptyHunyuanLatentVideo
KSampler
SaveWEBM
```

Install the `calcuis/gguf` custom node into ComfyUI:

```powershell
cd vendor\ComfyUI\custom_nodes
git clone https://github.com/calcuis/gguf.git
```

Then restart ComfyUI. After restart, run this app's health check:

```text
GET http://localhost:3000/api/health
```

If the response says ComfyUI is missing `LoaderGGUF`, `ClipLoaderGGUF`, or `VaeGGUF`, the GGUF node is not installed correctly or ComfyUI was not restarted.

## Checkpoints and GGUF Models

In ComfyUI, "checkpoint" usually means a Stable Diffusion or SDXL `.safetensors` / `.ckpt` model placed in:

```text
vendor/ComfyUI/models/checkpoints
```

This project does not currently use a normal SD/SDXL checkpoint. It uses a Wan video GGUF workflow instead:

```text
vendor/ComfyUI/models/diffusion_models/wan2.1_t2v_1.3b-q2_k.gguf
vendor/ComfyUI/models/text_encoders/umt5-xxl-encoder-q4_k_m.gguf
vendor/ComfyUI/models/vae/pig_wan_vae_fp32-f16.gguf
```

So there is no `COMFYUI_CHECKPOINT` setting in `.env.local`. The equivalent model settings for this project are:

```env
COMFYUI_WAN_MODEL=wan2.1_t2v_1.3b-q2_k.gguf
COMFYUI_WAN_CLIP=umt5-xxl-encoder-q4_k_m.gguf
COMFYUI_WAN_VAE=pig_wan_vae_fp32-f16.gguf
```

If you later add a Stable Diffusion image workflow, put the SD/SDXL checkpoint in `vendor/ComfyUI/models/checkpoints` and add a separate ComfyUI workflow/adapter for that pipeline.

## Install App

```bash
npm install
copy .env.example .env.local
npm run init-db
npm run dev
```

Open `http://localhost:3000`.

## Wan GGUF Model Files

The default lightweight Wan setup uses these files from `calcuis/wan-1.3b-gguf`:

```text
wan2.1_t2v_1.3b-q2_k.gguf
umt5-xxl-encoder-q4_k_m.gguf
pig_wan_vae_fp32-f16.gguf
```

Download them into this project:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\download-wan-gguf.ps1
```

This stores a local copy under `models/wan-gguf`. The `models/` folder is ignored by Git.

Then copy them into ComfyUI:

```text
vendor/ComfyUI/models/diffusion_models/wan2.1_t2v_1.3b-q2_k.gguf
vendor/ComfyUI/models/text_encoders/umt5-xxl-encoder-q4_k_m.gguf
vendor/ComfyUI/models/vae/pig_wan_vae_fp32-f16.gguf
```

Or let the helper script copy them:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\download-wan-gguf.ps1 -ComfyUIDir .\vendor\ComfyUI
```

After copying, the deployment-critical model files should exist at:

```text
vendor/ComfyUI/models/diffusion_models/wan2.1_t2v_1.3b-q2_k.gguf
vendor/ComfyUI/models/text_encoders/umt5-xxl-encoder-q4_k_m.gguf
vendor/ComfyUI/models/vae/pig_wan_vae_fp32-f16.gguf
```

## Configuration

`.env.local` controls the ComfyUI workflow:

```env
DATA_DIR=./data

COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_WAN_MODEL=wan2.1_t2v_1.3b-q2_k.gguf
COMFYUI_WAN_CLIP=umt5-xxl-encoder-q4_k_m.gguf
COMFYUI_WAN_VAE=pig_wan_vae_fp32-f16.gguf
COMFYUI_OUTPUT_PREFIX=frame-ai-video
COMFYUI_OUTPUT_FPS=
COMFYUI_POLL_TIMEOUT_MS=86400000
COMFYUI_POLL_INTERVAL_MS=2000
COMFYUI_REQUEST_TIMEOUT_MS=30000
COMFYUI_STALL_TIMEOUT_MS=600000
COMFYUI_ALLOW_CPU=true
COMFYUI_SAMPLER=uni_pc
COMFYUI_SCHEDULER=simple
COMFYUI_WEBM_CODEC=vp9
COMFYUI_WEBM_CRF=32

WAN_VIDEO_FRAMES=121
WAN_WIDTH=
WAN_HEIGHT=
WAN_STEPS=8
WAN_GUIDANCE_SCALE=5.5
WAN_NEGATIVE=lowres, blurry, watermark, text, deformed, bad anatomy, bad motion, flicker

CODEX_BIN=codex
CODEX_MODEL=
CODEX_PLAN_TIMEOUT_MS=300000
CODEX_TRANSLATE_TIMEOUT_MS=300000
CODEX_CHAT_TIMEOUT_MS=300000
CODEX_THREAD_ID=

FFMPEG_BIN=
FFMPEG_MOTION_INTENSITY=1.35

NEXT_PUBLIC_APP_NAME=Frame
```

`WAN_WIDTH` and `WAN_HEIGHT` are intentionally blank by default; the ComfyUI workflow uses the task size selected in the UI. `COMFYUI_OUTPUT_FPS` is also blank by default so the output duration is derived from `WAN_VIDEO_FRAMES / task duration`. `COMFYUI_POLL_TIMEOUT_MS` is the whole job wait limit. `COMFYUI_STALL_TIMEOUT_MS` is the no-sampler-progress limit.

For better quality, replace `COMFYUI_WAN_MODEL` with a larger GGUF such as `wan2.1_t2v_1.3b-q3_k_m.gguf` or `wan2.1_t2v_1.3b-q4_0.gguf`, then place that file in `vendor/ComfyUI/models/diffusion_models`.

Deployment notes for important variables:

- `COMFYUI_ALLOW_CPU=true` allows CPU-only ComfyUI. This is useful for local smoke tests, but Wan video generation can still take a very long time.
- `COMFYUI_POLL_TIMEOUT_MS` is the whole ComfyUI job wait limit. `COMFYUI_STALL_TIMEOUT_MS` is the no-sampler-progress limit.
- `CODEX_THREAD_ID` lets the app bind to a stable Codex conversation for the built-in Codex chat page. Leave it blank to let the app create and store task-level session ids.
- `DATA_DIR` contains SQLite data, uploads, generated videos, cache files, and logs. Back it up before redeploying or moving machines.
- `FFMPEG_BIN` can be left blank when `ffmpeg-static` works. Set it to an absolute FFmpeg executable path if deployment cannot find FFmpeg.

## Start ComfyUI

Start ComfyUI from the app root before creating tasks.

CPU mode:

```powershell
npm run comfyui:cpu
```

GPU mode:

```powershell
npm run comfyui:gpu
```

The helper script uses `vendor\ComfyUI\.venv\Scripts\python.exe` and logs to:

```text
data/comfyui.out.log
data/comfyui.err.log
```

If you use CPU mode, keep this in `.env.local` before starting the Next.js service:

```env
COMFYUI_ALLOW_CPU=true
```

The app checks ComfyUI through:

```text
GET /api/health
```

The health check verifies that:

- ComfyUI is reachable
- `LoaderGGUF`, `ClipLoaderGGUF`, `VaeGGUF`, `EmptyHunyuanLatentVideo`, `KSampler`, and `SaveWEBM` nodes exist
- the configured model, clip, and VAE filenames appear in ComfyUI's node model lists

## Workflow Notes

- The app builds the ComfyUI API prompt internally.
- ComfyUI saves a WebM file; the app downloads it and transcodes it to MP4.
- Reference images are still accepted by the UI and Codex planner, but the default lightweight T2V GGUF workflow is text-to-video. Image-conditioned Wan/VACE can be added later with a separate ComfyUI workflow.
- Codex planning and Codex chat use the configured `CODEX_BIN`; if Codex is unavailable, planning falls back to deterministic local text.
- The legacy Diffusers `WanPipeline` and direct Python Wan worker are no longer part of the runtime.
- Generated files live under `data/storage/<taskId>`.
- Cache files live under `data/cache`.
- Application logs live in `data/app.log`.

## Deployment

The deployed runtime has two long-running services:

1. ComfyUI performs Wan GGUF inference.
2. Next.js orchestrates planning, task state, ComfyUI calls, FFmpeg conversion, previews, and the Codex chat UI.

### 1. Prepare the App

```bash
npm install
copy .env.example .env.local
npm run init-db
```

Edit `.env.local` before starting the service. At minimum confirm:

- `COMFYUI_URL` points to the ComfyUI server.
- `COMFYUI_WAN_MODEL`, `COMFYUI_WAN_CLIP`, and `COMFYUI_WAN_VAE` match the filenames inside ComfyUI.
- `COMFYUI_ALLOW_CPU=true` only if ComfyUI is intentionally running in CPU mode.
- `CODEX_BIN=codex` if Codex planning and the Codex chat page should call the real Codex CLI.
- `DATA_DIR` points to a persistent directory.

`.env.local`, `models/`, `vendor/`, and `data/` are local deployment assets and are ignored by Git. Recreate or restore them on every deployment target before starting the services.

### 2. Prepare ComfyUI

Install the GGUF custom node in `vendor/ComfyUI`, then place the model files here:

```text
vendor/ComfyUI/models/diffusion_models/wan2.1_t2v_1.3b-q2_k.gguf
vendor/ComfyUI/models/text_encoders/umt5-xxl-encoder-q4_k_m.gguf
vendor/ComfyUI/models/vae/pig_wan_vae_fp32-f16.gguf
```

Start ComfyUI:

```powershell
npm run comfyui:gpu
```

CPU-only fallback:

```powershell
npm run comfyui:cpu
```

When using CPU-only fallback, keep `COMFYUI_ALLOW_CPU=true`. Expect Wan generation to be slow.

### 3. Start Next.js

For development:

```bash
npm run dev
```

For production:

```bash
npm run build
npm run start
```

Open `http://localhost:3000`.

### 4. Verify Deployment

Check the health endpoint after both services are running:

```text
GET http://localhost:3000/api/health
```

Expected state:

- `wan.configured=true`
- `wan.ready=true`
- `wan.backend="comfyui-gguf"`
- `ffmpeg.ok=true`
- `codex.configured=true` when `CODEX_BIN` is set

If `.env.local` changes, restart the Next.js service. Running tasks keep the environment that was loaded when that task started, so retry failed tasks after restarting.

Keep ComfyUI running in another terminal or as a background service. The Next.js service only orchestrates tasks; ComfyUI performs Wan inference.
