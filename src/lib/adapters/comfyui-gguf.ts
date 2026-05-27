import fs from 'node:fs';
import path from 'node:path';
import { transcodeVideoToMp4 } from './ffmpeg';
import { logInfo, stepTimer } from '../logger';

export interface GenerateComfyVideoInput {
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
  onProgress?: (progress: GenerateComfyVideoProgress) => void;
}

export interface GenerateComfyVideoProgress {
  value: number;
  max: number;
  elapsedMs: number;
  node?: string;
  promptId?: string;
  step?: number;
  maxSteps?: number;
}

export interface GenerateComfyVideoResult {
  outPath: string;
  durationMs: number;
  backend: 'comfyui-gguf';
}

interface ComfyHistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, Record<string, Array<{ filename: string; subfolder?: string; type?: string }>>>;
}

interface ComfySystemStats {
  system?: { argv?: string[]; pytorch_version?: string };
  devices?: Array<{ name?: string; type?: string }>;
}

const DEFAULT_URL = 'http://127.0.0.1:8188';

export async function generateVideo(input: GenerateComfyVideoInput): Promise<GenerateComfyVideoResult> {
  const startedAt = Date.now();
  const timer = stepTimer('comfyui-gguf', 'generateVideo', {
    outPath: input.outPath,
    width: input.width,
    height: input.height,
    duration: input.duration,
    fps: input.fps,
    frameCount: input.frameCount,
    seed: input.seed,
    hasReferenceImage: Boolean(input.referenceImagePath),
    promptLength: input.prompt.length,
    negativePromptLength: input.negativePrompt.length
  });

  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  const clientId = `frame-ai-video-${Date.now()}`;
  const workflow = buildWanGgufWorkflow(input);
  writeWorkflowDebugFile(input, workflow);
  const url = comfyUrl();
  await assertComfyCanGenerate(url);

  let progressSocket: ComfyProgressSocket | null = null;
  try {
    input.onProgress?.({ value: 1, max: 4, elapsedMs: Date.now() - startedAt, node: 'queue' });
    progressSocket = openComfyProgressSocket(url, clientId, startedAt, input.onProgress);
    await progressSocket.ready;
    const promptId = await queuePrompt(url, workflow, clientId);
    progressSocket.setPromptId(promptId);
    logInfo('comfyui-gguf', 'prompt.queued', { promptId, url });

    input.onProgress?.({ value: 2, max: 4, elapsedMs: Date.now() - startedAt, node: 'generate', promptId });
    const history = await pollHistory(url, promptId, startedAt, progressSocket);
    const output = findVideoOutput(history);
    if (!output) throw new Error(`ComfyUI completed but no video output was found for prompt ${promptId}`);

    input.onProgress?.({ value: 3, max: 4, elapsedMs: Date.now() - startedAt, node: 'download', promptId });
    const rawPath = input.outPath.replace(/\.mp4$/i, '.comfy.webm');
    await downloadComfyFile(url, output, rawPath);
    await transcodeVideoToMp4({ inputPath: rawPath, outPath: input.outPath, fps: input.fps });

    input.onProgress?.({ value: 4, max: 4, elapsedMs: Date.now() - startedAt, node: 'done', promptId });
    const stat = fs.statSync(input.outPath);
    timer.done({ outPath: input.outPath, bytes: stat.size, durationMs: Date.now() - startedAt, promptId });
    return { outPath: input.outPath, durationMs: Date.now() - startedAt, backend: 'comfyui-gguf' };
  } catch (error) {
    timer.fail(error, { outPath: input.outPath });
    throw error;
  } finally {
    progressSocket?.close();
  }
}

export async function checkComfyWanGguf(timeoutMs = 10_000): Promise<{
  configured: boolean;
  ready: boolean;
  backend: 'comfyui-gguf';
  url: string;
  model: string;
  clip: string;
  vae: string;
  error?: string;
}> {
  const timer = stepTimer('comfyui-gguf', 'check', { url: comfyUrl(), timeoutMs });
  const url = comfyUrl();
  const model = modelName();
  const clip = clipName();
  const vae = vaeName();
  try {
    const stats = await fetchJson<ComfySystemStats>(`${url}/system_stats`, timeoutMs);
    const deviceError = comfyDeviceError(stats);
    const objectInfo = await fetchJson<Record<string, { input?: Record<string, unknown> }>>(`${url}/object_info`, timeoutMs);
    const requiredNodes = ['LoaderGGUF', 'ClipLoaderGGUF', 'VaeGGUF', 'EmptyHunyuanLatentVideo', 'KSampler', 'SaveWEBM'];
    const missingNodes = requiredNodes.filter(node => !objectInfo[node]);
    if (missingNodes.length) {
      const health = {
        configured: true,
        ready: false,
        backend: 'comfyui-gguf' as const,
        url,
        model,
        clip,
        vae,
        error: `ComfyUI 缺少节点: ${missingNodes.join(', ')}. 请安装 calcuis/gguf 节点，并使用包含 SaveWEBM 的新版 ComfyUI。`
      };
      timer.done(health);
      return health;
    }

    const missingModels = findMissingModels(objectInfo, { model, clip, vae });
    const health = {
      configured: true,
      ready: missingModels.length === 0 && !deviceError,
      backend: 'comfyui-gguf' as const,
      url,
      model,
      clip,
      vae,
      error: deviceError ?? (missingModels.length ? `ComfyUI 模型列表里找不到: ${missingModels.join(', ')}` : undefined)
    };
    timer.done(health);
    return health;
  } catch (error) {
    const health = {
      configured: Boolean(process.env.COMFYUI_URL),
      ready: false,
      backend: 'comfyui-gguf' as const,
      url,
      model,
      clip,
      vae,
      error: (error as Error).message
    };
    timer.done(health);
    return health;
  }
}

function buildWanGgufWorkflow(input: GenerateComfyVideoInput): Record<string, unknown> {
  const width = input.width;
  const height = input.height;
  const length = readPositiveInt(process.env.WAN_VIDEO_FRAMES, input.frameCount);
  const steps = readPositiveInt(process.env.WAN_STEPS, 4);
  const cfg = readPositiveNumber(process.env.WAN_GUIDANCE_SCALE, 3.5);
  const fps = readPositiveNumber(process.env.COMFYUI_OUTPUT_FPS, length / Math.max(1, input.duration));
  const prefix = `${process.env.COMFYUI_OUTPUT_PREFIX || 'frame-ai-video'}/${path.basename(path.dirname(input.outPath))}`;

  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        model: ['49', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['40', 0],
        seed: input.seed,
        steps,
        cfg,
        sampler_name: process.env.COMFYUI_SAMPLER || 'uni_pc',
        scheduler: process.env.COMFYUI_SCHEDULER || 'simple',
        denoise: 1
      }
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['48', 0], text: input.prompt }
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['48', 0], text: input.negativePrompt || process.env.WAN_NEGATIVE || 'lowres, blurry, watermark, text' }
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['50', 0] }
    },
    '40': {
      class_type: 'EmptyHunyuanLatentVideo',
      inputs: { width, height, length, batch_size: 1 }
    },
    '47': {
      class_type: 'SaveWEBM',
      inputs: {
        images: ['8', 0],
        filename_prefix: prefix,
        codec: process.env.COMFYUI_WEBM_CODEC || 'vp9',
        fps,
        crf: readPositiveInt(process.env.COMFYUI_WEBM_CRF, 32)
      }
    },
    '48': {
      class_type: 'ClipLoaderGGUF',
      inputs: { clip_name: clipName(), type: 'wan' }
    },
    '49': {
      class_type: 'LoaderGGUF',
      inputs: { gguf_name: modelName() }
    },
    '50': {
      class_type: 'VaeGGUF',
      inputs: { vae_name: vaeName() }
    }
  };
}

function writeWorkflowDebugFile(input: GenerateComfyVideoInput, workflow: Record<string, unknown>): void {
  const debugPath = input.outPath.replace(/\.mp4$/i, '.comfy-workflow.json');
  fs.writeFileSync(debugPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    model: modelName(),
    clip: clipName(),
    vae: vaeName(),
    requested: {
      width: input.width,
      height: input.height,
      duration: input.duration,
      fps: input.fps,
      frameCount: input.frameCount,
      seed: input.seed
    },
    workflow,
    positivePrompt: input.prompt,
    negativePrompt: input.negativePrompt
  }, null, 2));
}

async function queuePrompt(url: string, prompt: Record<string, unknown>, clientId: string): Promise<string> {
  const result = await fetchJson<{ prompt_id?: string }>(`${url}/prompt`, readPositiveInt(process.env.COMFYUI_REQUEST_TIMEOUT_MS, 30_000), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId })
  });
  if (!result.prompt_id) throw new Error('ComfyUI /prompt did not return prompt_id');
  return result.prompt_id;
}

async function pollHistory(url: string, promptId: string, startedAt: number, progressSocket?: ComfyProgressSocket | null): Promise<ComfyHistoryEntry> {
  const timeoutMs = readPositiveInt(process.env.COMFYUI_POLL_TIMEOUT_MS, 24 * 60 * 60_000);
  const intervalMs = readPositiveInt(process.env.COMFYUI_POLL_INTERVAL_MS, 2_000);
  const stallTimeoutMs = readPositiveInt(process.env.COMFYUI_STALL_TIMEOUT_MS, 24 * 60 * 60_000);
  while (Date.now() - startedAt < timeoutMs) {
    const history = await fetchJson<Record<string, ComfyHistoryEntry>>(`${url}/history/${encodeURIComponent(promptId)}`, 30_000);
    const entry = history[promptId];
    if (entry?.status?.completed) return entry;
    const status = entry?.status?.status_str;
    if (status === 'error') throw new Error(`ComfyUI prompt failed: ${JSON.stringify(entry.status?.messages ?? [])}`);
    if (progressSocket && Date.now() - progressSocket.lastProgressAt() > stallTimeoutMs) {
      await stopComfyPrompt(url, promptId, `no ComfyUI progress for ${Math.round(stallTimeoutMs / 1000)}s`);
      throw new Error(`ComfyUI stalled: no sampler progress for ${Math.round(stallTimeoutMs / 1000)}s`);
    }
    await sleep(intervalMs);
  }
  await stopComfyPrompt(url, promptId, 'poll timeout');
  throw new Error(`ComfyUI timed out polling /history/${promptId} after ${Math.round(timeoutMs / 1000)}s`);
}

async function stopComfyPrompt(url: string, promptId: string, reason: string): Promise<void> {
  logInfo('comfyui-gguf', 'prompt.stop.start', { promptId, reason });
  await postComfyControl(url, '/interrupt', { prompt_id: promptId }, 10_000);
  await postComfyControl(url, '/queue', { delete: [promptId] }, 10_000);
  await postComfyControl(url, '/history', { delete: [promptId] }, 10_000);
  logInfo('comfyui-gguf', 'prompt.stop.done', { promptId, reason });
}

async function postComfyControl(url: string, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
  try {
    await fetchJson<unknown>(`${url}${path}`, timeoutMs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (error) {
    logInfo('comfyui-gguf', 'prompt.stop.controlFailed', {
      path,
      body,
      error: (error as Error).message
    });
  }
}

interface ComfyProgressSocket {
  ready: Promise<void>;
  setPromptId: (promptId: string) => void;
  lastProgressAt: () => number;
  close: () => void;
}

function openComfyProgressSocket(
  url: string,
  clientId: string,
  startedAt: number,
  onProgress?: (progress: GenerateComfyVideoProgress) => void
): ComfyProgressSocket {
  let promptId: string | undefined;
  let currentNode: string | undefined;
  let lastProgressAt = Date.now();

  if (typeof WebSocket === 'undefined') {
    return {
      ready: Promise.resolve(),
      setPromptId: id => { promptId = id; },
      lastProgressAt: () => lastProgressAt,
      close: () => undefined
    };
  }

  const wsUrl = `${url.replace(/^http/i, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
  const ws = new WebSocket(wsUrl);
  const ready = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 2_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

  ws.addEventListener('message', event => {
    const raw = typeof event.data === 'string' ? event.data : '';
    if (!raw) return;
    try {
      const msg = JSON.parse(raw) as { type?: string; data?: Record<string, unknown> };
      const data = msg.data ?? {};
      const msgPromptId = typeof data.prompt_id === 'string' ? data.prompt_id : undefined;
      if (promptId && msgPromptId && msgPromptId !== promptId) return;

      if (msg.type === 'executing') {
        currentNode = typeof data.node === 'string' ? data.node : currentNode;
        if (msgPromptId === promptId && currentNode) lastProgressAt = Date.now();
      }

      if (msg.type === 'progress') {
        const value = Number(data.value);
        const max = Number(data.max);
        if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
        lastProgressAt = Date.now();
        onProgress?.({
          value: 2,
          max: 4,
          elapsedMs: Date.now() - startedAt,
          node: currentNode ?? 'sampler',
          promptId,
          step: Math.max(0, Math.floor(value)),
          maxSteps: Math.max(1, Math.floor(max))
        });
      }

      if (msg.type === 'execution_error' || msg.type === 'execution_interrupted') {
        lastProgressAt = Date.now();
      }
    } catch {
      // Ignore non-JSON websocket frames.
    }
  });

  return {
    ready,
    setPromptId: id => { promptId = id; },
    lastProgressAt: () => lastProgressAt,
    close: () => {
      try {
        ws.close();
      } catch {
        // ignore close failures
      }
    }
  };
}

async function assertComfyCanGenerate(url: string): Promise<void> {
  const stats = await fetchJson<ComfySystemStats>(`${url}/system_stats`, readPositiveInt(process.env.COMFYUI_REQUEST_TIMEOUT_MS, 30_000));
  const error = comfyDeviceError(stats);
  if (error) throw new Error(error);
}

function comfyDeviceError(stats: ComfySystemStats): string | undefined {
  if (process.env.COMFYUI_ALLOW_CPU === 'true') return undefined;
  const argv = (stats.system?.argv ?? []).join(' ');
  const torch = stats.system?.pytorch_version ?? '';
  const devices = stats.devices ?? [];
  const hasAccelerator = devices.some(device => (device.type ?? '').toLowerCase() !== 'cpu');
  if (/\s--cpu(?:\s|$)/.test(` ${argv} `) || /\+cpu\b/i.test(torch) || !hasAccelerator) {
    return 'ComfyUI 正在 CPU 模式运行，Wan 视频生成会长时间卡在 0/8；请安装 CUDA/PyTorch GPU 版并去掉 --cpu，或设置 COMFYUI_ALLOW_CPU=true 强制允许。';
  }
  return undefined;
}

function findVideoOutput(history: ComfyHistoryEntry): { filename: string; subfolder?: string; type?: string } | null {
  for (const output of Object.values(history.outputs ?? {})) {
    for (const value of Object.values(output)) {
      if (!Array.isArray(value)) continue;
      const found = value.find(item => /\.(webm|mp4)$/i.test(item.filename));
      if (found) return found;
    }
  }
  return null;
}

async function downloadComfyFile(url: string, file: { filename: string; subfolder?: string; type?: string }, outPath: string): Promise<void> {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? '',
    type: file.type ?? 'output'
  });
  const res = await fetch(`${url}/view?${params.toString()}`);
  if (!res.ok) throw new Error(`ComfyUI /view failed ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
}

async function fetchJson<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function findMissingModels(objectInfo: Record<string, unknown>, names: { model: string; clip: string; vae: string }): string[] {
  const text = JSON.stringify(objectInfo);
  return [
    ['model', names.model],
    ['clip', names.clip],
    ['vae', names.vae]
  ].filter(([, name]) => !text.includes(name)).map(([kind, name]) => `${kind}=${name}`);
}

function comfyUrl(): string {
  return (process.env.COMFYUI_URL || DEFAULT_URL).replace(/\/+$/, '');
}

function modelName(): string {
  return process.env.COMFYUI_WAN_MODEL || 'wan2.1_t2v_1.3b-q2_k.gguf';
}

function clipName(): string {
  return process.env.COMFYUI_WAN_CLIP || 'umt5-xxl-encoder-q4_k_m.gguf';
}

function vaeName(): string {
  return process.env.COMFYUI_WAN_VAE || 'pig_wan_vae_fp32-f16.gguf';
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
