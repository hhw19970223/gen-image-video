import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { resolveComfyUrl } from '../comfyui';
import { transcodeVideoToMp4 } from './ffmpeg';

export interface GenerateVideoInput {
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
  onProgress?: (progress: GenerateVideoProgress) => void;
}

export interface GenerateVideoProgress {
  value: number;
  max: number;
  elapsedMs: number;
  node?: string;
  promptId?: string;
}

export interface GenerateVideoResult {
  outPath: string;
  durationMs: number;
  backend: 'comfyui-video';
}

interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
  format?: string;
}

export async function generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
  const t0 = Date.now();
  const url = resolveComfyUrl();
  await comfyGenerateVideo(url, input);
  return { outPath: input.outPath, durationMs: Date.now() - t0, backend: 'comfyui-video' };
}

async function comfyGenerateVideo(baseUrl: string, input: GenerateVideoInput): Promise<void> {
  const workflow = await loadVideoWorkflow(input);
  const clientId = `video_${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = Date.now();
  const progressSocket = await connectProgressSocket(baseUrl, clientId, input.onProgress, startedAt);

  try {
    const promptResp = await fetch(`${baseUrl.replace(/\/$/, '')}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId })
    });
    if (!promptResp.ok) {
      throw new Error(`comfyui /prompt ${promptResp.status}: ${await promptResp.text()}`);
    }
    const { prompt_id: promptId } = (await promptResp.json()) as { prompt_id: string };
    if (!promptId) throw new Error('comfyui no prompt_id');

    const historyTimeoutMs = readPositiveInt(process.env.COMFYUI_VIDEO_HISTORY_TIMEOUT_MS, readPositiveInt(process.env.COMFYUI_HISTORY_TIMEOUT_MS, 30 * 60_000));
    const deadline = Date.now() + historyTimeoutMs;
    let outputs: Record<string, Record<string, unknown>> | null = null;
    while (Date.now() < deadline) {
      const histResp = await fetch(`${baseUrl.replace(/\/$/, '')}/history/${promptId}`);
      if (histResp.ok) {
        const hist = (await histResp.json()) as Record<string, { outputs?: Record<string, Record<string, unknown>> }>;
        const entry = hist[promptId];
        if (entry?.outputs) {
          outputs = entry.outputs;
          break;
        }
      }
      await sleep(1000);
    }
    if (!outputs) {
      throw new Error(`comfyui video timed out polling /history after ${Math.round(historyTimeoutMs / 1000)}s`);
    }

    const videoFile = findFirstOutputFile(outputs, ['videos', 'gifs', 'animated']);
    if (!videoFile) {
      throw new Error('comfyui video workflow finished but did not return a video output; please add a SaveVideo / VHS VideoCombine node to COMFYUI_VIDEO_WORKFLOW');
    }

    const ext = outputExt(videoFile);
    const rawPath = ext === '.mp4' ? input.outPath : input.outPath.replace(/\.mp4$/i, ext);
    await downloadComfyFile(baseUrl, videoFile, rawPath);
    if (path.resolve(rawPath) !== path.resolve(input.outPath)) {
      await transcodeVideoToMp4({ inputPath: rawPath, outPath: input.outPath });
    }
  } finally {
    progressSocket.close();
  }
}

async function loadVideoWorkflow(input: GenerateVideoInput): Promise<unknown> {
  const wfPath = process.env.COMFYUI_VIDEO_WORKFLOW?.trim() || process.env.COMFYUI_WORKFLOW?.trim();
  if (!wfPath) {
    throw new Error('视频模型模式需要配置 COMFYUI_VIDEO_WORKFLOW, 指向 Wan2.2/LTX/AnimateDiff 的 ComfyUI API workflow JSON');
  }
  const abs = path.resolve(wfPath);
  if (!fs.existsSync(abs)) throw new Error(`COMFYUI_VIDEO_WORKFLOW not found: ${abs}`);
  const tpl = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(tpl);
  return injectVideoWorkflowParams(toApiWorkflow(parsed), input);
}

function toApiWorkflow(wf: unknown): unknown {
  if (!wf || typeof wf !== 'object') return wf;
  const raw = wf as {
    nodes?: Array<{
      id: number;
      type: string;
      inputs?: Array<{ name: string; link: number | null }>;
      widgets_values?: unknown[];
      _meta?: { title?: string };
      title?: string;
      properties?: Record<string, unknown>;
    }>;
    links?: Array<[number, number, number, number, number, string]>;
  };
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.links)) return wf;

  const linkMap = new Map<number, [string, number]>();
  for (const link of raw.links) {
    linkMap.set(link[0], [String(link[1]), link[2]]);
  }

  const api: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }> = {};
  for (const node of raw.nodes) {
    if (!node?.id || !node.type || node.type === 'Note') continue;
    const inputs: Record<string, unknown> = {};
    for (const input of node.inputs ?? []) {
      if (typeof input.link === 'number' && linkMap.has(input.link)) {
        inputs[input.name] = linkMap.get(input.link)!;
      }
    }
    Object.assign(inputs, widgetInputsForNode(node.type, node.widgets_values ?? []));
    const title =
      node.title ||
      (typeof node.properties?.['Node name for S&R'] === 'string'
        ? node.properties['Node name for S&R']
        : undefined);
    api[String(node.id)] = {
      class_type: node.type,
      inputs,
      _meta: title ? { title } : undefined
    };
  }
  return api;
}

function widgetInputsForNode(type: string, widgets: unknown[]): Record<string, unknown> {
  switch (type) {
    case 'CLIPTextEncode':
      return { text: String(widgets[0] ?? '') };
    case 'KSampler':
      return {
        seed: numberWidget(widgets[0], 0),
        steps: numberWidget(widgets[2], readPositiveInt(process.env.COMFYUI_VIDEO_STEPS, 30)),
        cfg: numberWidget(widgets[3], readPositiveInt(process.env.COMFYUI_VIDEO_CFG, 5)),
        sampler_name: String(widgets[4] ?? 'uni_pc'),
        scheduler: String(widgets[5] ?? 'simple'),
        denoise: numberWidget(widgets[6], 1)
      };
    case 'VAELoader':
      return { vae_name: String(widgets[0] ?? process.env.COMFYUI_VIDEO_VAE ?? 'wan2.2_vae.safetensors') };
    case 'CLIPLoader':
      return {
        clip_name: String(widgets[0] ?? process.env.COMFYUI_VIDEO_TEXT_ENCODER ?? 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
        type: String(widgets[1] ?? 'wan'),
        device: String(widgets[2] ?? 'default')
      };
    case 'UNETLoader':
      return {
        unet_name: String(widgets[0] ?? process.env.COMFYUI_VIDEO_MODEL ?? 'wan2.2_ti2v_5B_fp16.safetensors'),
        weight_dtype: String(widgets[1] ?? 'default')
      };
    case 'ModelSamplingSD3':
      return { shift: numberWidget(widgets[0], 8) };
    case 'Wan22ImageToVideoLatent':
      return {
        width: numberWidget(widgets[0], 1280),
        height: numberWidget(widgets[1], 704),
        length: numberWidget(widgets[2], 41),
        batch_size: numberWidget(widgets[3], 1)
      };
    case 'SaveWEBM':
      return {
        filename_prefix: String(widgets[0] ?? 'video'),
        codec: String(widgets[1] ?? 'vp9'),
        fps: numberWidget(widgets[2], 24),
        crf: numberWidget(widgets[3], 18)
      };
    case 'SaveAnimatedWEBP':
      return {
        filename_prefix: String(widgets[0] ?? 'video'),
        fps: numberWidget(widgets[1], 24),
        lossless: Boolean(widgets[2] ?? false),
        quality: numberWidget(widgets[3], 80),
        method: String(widgets[4] ?? 'default')
      };
    default:
      return {};
  }
}

function numberWidget(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function injectVideoWorkflowParams(wf: unknown, input: GenerateVideoInput): unknown {
  if (!wf || typeof wf !== 'object') return wf;
  const obj = wf as Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
  const videoModel = process.env.COMFYUI_VIDEO_MODEL?.trim() || 'wan2.2_ti2v_5B_fp16.safetensors';
  const videoVae = process.env.COMFYUI_VIDEO_VAE?.trim();
  const textEncoder = process.env.COMFYUI_VIDEO_TEXT_ENCODER?.trim();
  const imageNamePromise = input.referenceImagePath && fs.existsSync(input.referenceImagePath)
    ? prepareInputImage(input.referenceImagePath, input.width, input.height)
    : null;

  for (const node of Object.values(obj)) {
    if (!node?.inputs) continue;
    const ct = node.class_type ?? '';
    const title = (node._meta?.title || '').toLowerCase();
    const inputs = node.inputs;

    if ('seed' in inputs) inputs.seed = input.seed;
    if ('noise_seed' in inputs) inputs.noise_seed = input.seed;
    if (ct === 'KSampler' || ct === 'KSamplerAdvanced') {
      if ('steps' in inputs) inputs.steps = readPositiveInt(process.env.COMFYUI_VIDEO_STEPS, Number(inputs.steps) || 30);
      if ('cfg' in inputs) inputs.cfg = readPositiveNumber(process.env.COMFYUI_VIDEO_CFG, Number(inputs.cfg) || 5);
    }
    if ('width' in inputs) inputs.width = input.width;
    if ('height' in inputs) inputs.height = input.height;
    if ('fps' in inputs) inputs.fps = input.fps;
    if ('frame_rate' in inputs) inputs.frame_rate = input.fps;
    if ('length' in inputs) inputs.length = input.frameCount;
    if ('frame_count' in inputs) inputs.frame_count = input.frameCount;
    if ('num_frames' in inputs) inputs.num_frames = input.frameCount;
    if ('video_frames' in inputs) inputs.video_frames = input.frameCount;
    if ('filename_prefix' in inputs) inputs.filename_prefix = 'video';

    if (ct === 'CLIPTextEncode' || title.includes('prompt') || title.includes('positive') || title.includes('negative')) {
      if ('text' in inputs) inputs.text = title.includes('negative') ? input.negativePrompt : input.prompt;
      if ('prompt' in inputs) inputs.prompt = title.includes('negative') ? input.negativePrompt : input.prompt;
    }
    if (title.includes('positive') && 'positive' in inputs) inputs.positive = input.prompt;
    if (title.includes('negative') && 'negative' in inputs) inputs.negative = input.negativePrompt;

    if (/unet|diffusion|model/i.test(ct)) {
      if ('unet_name' in inputs) inputs.unet_name = videoModel;
      if ('model_name' in inputs) inputs.model_name = videoModel;
      if ('ckpt_name' in inputs && /wan|ltx|video/i.test(title + ct)) inputs.ckpt_name = videoModel;
    }
    if (videoVae && /vae/i.test(ct)) {
      if ('vae_name' in inputs) inputs.vae_name = videoVae;
    }
    if (textEncoder && /clip|text/i.test(ct)) {
      if ('clip_name' in inputs) inputs.clip_name = textEncoder;
      if ('text_encoder_name' in inputs) inputs.text_encoder_name = textEncoder;
    }
  }

  if (imageNamePromise) {
    return imageNamePromise.then(imageName => {
      for (const node of Object.values(obj)) {
        if (!node?.inputs) continue;
        const ct = node.class_type ?? '';
        const title = (node._meta?.title || '').toLowerCase();
        if (ct === 'LoadImage' || title.includes('reference') || title.includes('start image') || title.includes('image input')) {
          if ('image' in node.inputs) node.inputs.image = imageName;
        }
      }
      return obj;
    });
  }

  return obj;
}

function findFirstOutputFile(outputs: Record<string, Record<string, unknown>>, keys: string[]): ComfyOutputFile | null {
  for (const output of Object.values(outputs)) {
    for (const key of keys) {
      const value = output[key];
      if (Array.isArray(value) && value.length > 0) {
        const file = value[0] as Partial<ComfyOutputFile>;
        if (file.filename) {
          return {
            filename: String(file.filename),
            subfolder: String(file.subfolder ?? ''),
            type: String(file.type ?? 'output'),
            format: file.format === undefined ? undefined : String(file.format)
          };
        }
      }
    }
  }
  return null;
}

async function downloadComfyFile(baseUrl: string, file: ComfyOutputFile, outPath: string): Promise<void> {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type
  });
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/view?${params}`);
  if (!resp.ok) throw new Error(`comfyui /view ${resp.status}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(await resp.arrayBuffer()));
}

function outputExt(file: ComfyOutputFile): string {
  const fromName = path.extname(file.filename).toLowerCase();
  if (fromName) return fromName;
  const format = (file.format ?? '').toLowerCase();
  if (format.includes('webm')) return '.webm';
  if (format.includes('gif')) return '.gif';
  return '.mp4';
}

async function prepareInputImage(srcPath: string, width: number, height: number): Promise<string> {
  const comfyDir = process.env.COMFYUI_DIR?.trim()
    ? path.resolve(process.env.COMFYUI_DIR.trim())
    : path.join(process.cwd(), 'vendor', 'ComfyUI');
  const inputDir = path.join(comfyDir, 'input', 'video_refs');
  fs.mkdirSync(inputDir, { recursive: true });
  const name = `${path.basename(srcPath, path.extname(srcPath))}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  await sharp(srcPath)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(path.join(inputDir, name));
  return `video_refs/${name}`;
}

async function connectProgressSocket(
  baseUrl: string,
  clientId: string,
  onProgress: GenerateVideoInput['onProgress'],
  startedAt: number
): Promise<{ close: () => void }> {
  if (!onProgress || typeof WebSocket === 'undefined') return { close: () => undefined };

  const wsUrl = `${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws?clientId=${encodeURIComponent(clientId)}`;
  return new Promise(resolve => {
    let ws: WebSocket | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        close: () => {
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
        }
      });
    };
    const timer = setTimeout(finish, 1000);

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = finish;
      ws.onerror = finish;
      ws.onmessage = event => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            data?: { value?: unknown; max?: unknown; node?: unknown; prompt_id?: unknown };
          };
          if (msg.type !== 'progress') return;
          const value = Number(msg.data?.value);
          const max = Number(msg.data?.max);
          if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
          onProgress({
            value,
            max,
            elapsedMs: Date.now() - startedAt,
            node: typeof msg.data?.node === 'string' ? msg.data.node : undefined,
            promptId: typeof msg.data?.prompt_id === 'string' ? msg.data.prompt_id : undefined
          });
        } catch {
          /* ignore malformed websocket events */
        }
      };
    } catch {
      finish();
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
