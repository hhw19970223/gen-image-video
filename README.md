# Frame AI Video

Frame is a local AI short-video workflow:

1. Codex expands the user prompt into a video plan and per-second still descriptions.
2. The backend calls a direct Wan Python worker.
3. FFmpeg extracts preview keyframes and cover images from the generated video.

The runtime uses the Python worker directly instead of a visual workflow server.

## Run

```bash
npm install
npm run init-db
npm run dev
```

Open `http://localhost:3000`.

## Direct Wan Backend

Configure `.env.local`:

```env
WAN_PYTHON=python
WAN_SCRIPT=./scripts/wan22-direct.py
WAN_MODEL_ID=Wan-AI/Wan2.1-T2V-1.3B-Diffusers
WAN_DEVICE=cuda
WAN_VIDEO_FRAMES=81
```

The Python environment must provide:

```bash
pip install torch diffusers transformers accelerate imageio-ffmpeg
```

Use a CUDA-enabled PyTorch build for practical generation speed.

## Notes

- Existing task planning and preview pages are preserved.
- Keyframe images are extracted from the generated video, not generated one-by-one.
- `WAN_MODEL_ID` can be changed to another Diffusers-compatible Wan model when the local hardware can support it.
