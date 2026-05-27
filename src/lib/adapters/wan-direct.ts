import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GenerateWanVideoInput {
  prompt: string;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  duration: number;
  fps: number;
  frameCount: number;
  outPath: string;
  referenceImagePath?: string;
  onProgress?: (progress: GenerateWanVideoProgress) => void;
}

export interface GenerateWanVideoProgress {
  value: number;
  max: number;
  elapsedMs: number;
  node?: string;
  promptId?: string;
}

export interface GenerateWanVideoResult {
  outPath: string;
  durationMs: number;
  backend: 'wan-direct';
}

export async function generateVideo(input: GenerateWanVideoInput): Promise<GenerateWanVideoResult> {
  const t0 = Date.now();
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });

  const python = resolveExecutable(process.env.WAN_PYTHON?.trim() || process.env.PYTHON_BIN?.trim() || 'python');
  const script = path.resolve(process.env.WAN_SCRIPT?.trim() || 'scripts/wan22-direct.py');
  if (!fs.existsSync(script)) {
    throw new Error(`Wan direct script not found: ${script}`);
  }

  const payloadPath = input.outPath.replace(/\.mp4$/i, '.wan-input.json');
  const width = readPositiveInt(process.env.WAN_WIDTH, input.width);
  const height = readPositiveInt(process.env.WAN_HEIGHT, input.height);
  const frameCount = readPositiveInt(process.env.WAN_VIDEO_FRAMES, input.frameCount);
  fs.writeFileSync(payloadPath, JSON.stringify({
    prompt: input.prompt,
    negative_prompt: input.negativePrompt,
    seed: input.seed,
    width,
    height,
    duration: input.duration,
    fps: input.fps,
    frame_count: frameCount,
    output: input.outPath,
    reference_image: input.referenceImagePath ?? null,
    model_id: process.env.WAN_MODEL_ID || 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
    device: process.env.WAN_DEVICE || 'cuda',
    gguf_path: process.env.WAN_GGUF_PATH || null,
    use_vace: /^(1|true|yes)$/i.test(process.env.WAN_USE_VACE ?? ''),
    steps: readPositiveInt(process.env.WAN_STEPS, 4),
    guidance_scale: readPositiveNumber(process.env.WAN_GUIDANCE_SCALE, 3.5),
    threads: readPositiveInt(process.env.WAN_CPU_THREADS, 6)
  }, null, 2));

  await runWanProcess({
    python,
    script,
    payloadPath,
    startedAt: t0,
    onProgress: input.onProgress
  });
  if (!fs.existsSync(input.outPath)) {
    throw new Error(`Wan worker completed but did not create video: ${input.outPath}`);
  }
  return { outPath: input.outPath, durationMs: Date.now() - t0, backend: 'wan-direct' };
}

function resolveExecutable(value: string): string {
  return value.includes('/') || value.includes('\\') ? path.resolve(value) : value;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runWanProcess(input: {
  python: string;
  script: string;
  payloadPath: string;
  startedAt: number;
  onProgress?: GenerateWanVideoInput['onProgress'];
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.python, [input.script, input.payloadPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { progress?: number; total?: number; stage?: string };
          if (typeof ev.progress === 'number' && typeof ev.total === 'number') {
            input.onProgress?.({
              value: ev.progress,
              max: ev.total,
              elapsedMs: Date.now() - input.startedAt,
              node: ev.stage
            });
          }
        } catch {
          // Worker may print normal logs; keep them out of user-facing errors.
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`Wan direct worker exited ${code}: ${err.slice(-2000)}`));
    });
  });
}
