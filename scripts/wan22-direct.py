import json
import os
import sys
from pathlib import Path


def emit(progress, total, stage):
    print(json.dumps({"progress": progress, "total": total, "stage": stage}), flush=True)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python scripts/wan22-direct.py payload.json")

    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    output = Path(payload["output"])
    output.parent.mkdir(parents=True, exist_ok=True)

    emit(1, 3, "load")
    try:
        import torch
        from diffusers import WanPipeline, WanVACEPipeline
        from diffusers.utils import export_to_video
    except Exception as exc:
        raise SystemExit(
            "Wan direct backend needs Python packages: torch, diffusers, transformers, accelerate, imageio-ffmpeg. "
            f"Original import error: {exc}"
        )

    device = payload.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
    model_id = payload.get("model_id") or "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
    dtype = torch.float16 if device == "cuda" else torch.float32

    gguf_path = payload.get("gguf_path") or os.environ.get("WAN_GGUF_PATH")
    is_vace = str(payload.get("use_vace") or os.environ.get("WAN_USE_VACE") or "").lower() in ("1", "true", "yes")
    if gguf_path:
        try:
            from diffusers import GGUFQuantizationConfig, WanTransformer3DModel, WanVACETransformer3DModel
        except Exception as exc:
            raise SystemExit(
                "Wan GGUF backend needs a recent diffusers version with GGUFQuantizationConfig "
                f"and WanTransformer3DModel. Original import error: {exc}"
            )
        gguf_path = str(Path(gguf_path).expanduser().resolve())
        if not Path(gguf_path).exists():
            raise SystemExit(f"WAN_GGUF_PATH not found: {gguf_path}")
        transformer_cls = WanVACETransformer3DModel if is_vace else WanTransformer3DModel
        pipeline_cls = WanVACEPipeline if is_vace else WanPipeline
        transformer = transformer_cls.from_single_file(
            gguf_path,
            quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
            torch_dtype=dtype,
        )
        pipe = pipeline_cls.from_pretrained(
            model_id,
            transformer=transformer,
            torch_dtype=dtype,
        )
    else:
        pipeline_cls = WanVACEPipeline if is_vace else WanPipeline
        pipe = pipeline_cls.from_pretrained(model_id, torch_dtype=dtype)

    pipe = pipe.to(device)
    if hasattr(pipe, "enable_model_cpu_offload") and device == "cuda":
        pipe.enable_model_cpu_offload()
    if device == "cpu":
        torch.set_num_threads(int(payload.get("threads") or os.environ.get("WAN_CPU_THREADS") or 6))

    emit(2, 3, "generate")
    generator = torch.Generator(device=device).manual_seed(int(payload.get("seed") or 0))
    result = pipe(
        prompt=payload["prompt"],
        negative_prompt=payload.get("negative_prompt") or None,
        width=int(payload["width"]),
        height=int(payload["height"]),
        num_frames=int(payload["frame_count"]),
        num_inference_steps=int(payload.get("steps") or os.environ.get("WAN_STEPS") or 4),
        guidance_scale=float(payload.get("guidance_scale") or os.environ.get("WAN_GUIDANCE_SCALE") or 3.5),
        generator=generator,
    )

    emit(3, 3, "export")
    export_to_video(result.frames[0], str(output), fps=int(payload.get("fps") or 24))


if __name__ == "__main__":
    main()
