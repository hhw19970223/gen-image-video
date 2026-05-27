// 图像生成适配器 — 仅使用 ComfyUI 生成真实关键帧

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { resolveComfyUrl } from '../comfyui';

export interface GenerateImageInput {
  prompt: string;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  outPath: string;
  initImagePath?: string;
  onProgress?: (progress: GenerateImageProgress) => void;
}

export interface GenerateImageProgress {
  value: number;
  max: number;
  elapsedMs: number;
  node?: string;
  promptId?: string;
}

export interface GenerateImageResult {
  outPath: string;
  durationMs: number;
  backend: 'comfyui';
}

export async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
  const t0 = Date.now();
  const url = resolveComfyUrl();
  await comfyGenerate(url, {
    ...input,
    prompt: promptForComfy(input.prompt),
    negativePrompt: negativePromptForComfy(input.negativePrompt, input.prompt)
  });
  return { outPath: input.outPath, durationMs: Date.now() - t0, backend: 'comfyui' };
}

function promptForComfy(prompt: string): string {
  const bridge = englishVisualBridge(prompt);
  const hint = englishVisualHint(prompt);
  return [bridge, hint, prompt].filter(Boolean).join(', ');
}

function negativePromptForComfy(prompt: string, sourcePrompt: string): string {
  const hasAnimalSubject = hasAnimal(sourcePrompt);
  const cleanedPrompt = hasAnimalSubject
    ? prompt
      .replace(/\bpeople or animals appearing\b/gi, 'unrelated extra people')
      .replace(/\banimals appearing\b/gi, 'unrelated extra animals')
      .replace(/\bduplicate subjects\b/gi, 'duplicate subjects except the requested animal pair')
    : prompt;
  const negatives = [
    cleanedPrompt,
    'text, calligraphy, Chinese characters, signature, stamp, seal, poster typography, unrelated plants, unrelated landscape'
  ];
  if (!/人|男人|女人|女孩|男孩|模特|肖像|人物/.test(sourcePrompt)) {
    negatives.push('human, person, woman, man, girl, boy, portrait, selfie, face close-up, fashion model');
  }
  if (hasAnimalSubject) {
    negatives.push('extra people, human portrait, unrelated woman, unrelated man, studio portrait');
  }
  return negatives.filter(Boolean).join(', ');
}

function englishVisualBridge(text: string): string {
  const parts: string[] = [];
  const hasCat = /猫|\bcat\b|\bcats\b|\btabby\b|\bfeline\b/i.test(text);
  const hasMouse = /鼠|老鼠|田鼠|\bmouse\b|\bmice\b|\brat\b|\brodent\b/i.test(text);

  if (hasCat && hasMouse) {
    parts.push(
      'photorealistic ginger tabby house cat with a white chest and a small copper tag collar',
      'small gray brown mouse with a pink tail',
      'exactly one cat and exactly one mouse, two different animal species',
      'cat and mouse in the same frame',
      'the mouse must be visibly smaller than the cat, do not turn the mouse into a second cat',
      'playful non-violent fight between cat and mouse',
      'indoor living room on a narrow wooden floor',
      'warm window light from the upper right',
      'animal action photography, no humans, no portrait'
    );
  } else {
    if (hasCat) parts.push('photorealistic cat, animal photography, no humans');
    if (hasMouse) parts.push('photorealistic small mouse, animal photography, no humans');
  }

  if (/打架|搏斗|争斗|冲突|战斗/.test(text)) {
    parts.push('dynamic action scene, playful fighting pose, visible interaction between subjects');
  }
  if (/前爪|爪/.test(text)) parts.push('visible paws, clear animal limbs');
  if (/木地板|地板|客厅|室内/.test(text)) parts.push('indoor wooden floor background');
  if (/窗|窗光|右上/.test(text)) parts.push('soft warm window light');
  if (/特写|近景|zoom_in|拉近/.test(text)) parts.push('close-up framing, shallow depth of field');
  if (/写实|真实|现实/.test(text)) parts.push('realistic photography, natural fur detail');

  return dedupe(parts).join(', ');
}

function englishVisualHint(text: string): string {
  const parts: string[] = [];
  const add = (condition: boolean, value: string) => {
    if (condition) parts.push(value);
  };

  add(/[狗犬]/.test(text), 'dogs');
  add(/猴|猿/.test(text), 'monkeys');
  add(/猫|\bcat\b|\bcats\b|\btabby\b|\bfeline\b/i.test(text), 'cat');
  add(/鼠|老鼠|田鼠|\bmouse\b|\bmice\b|\brat\b|\brodent\b/i.test(text), 'small mouse');
  add(/人|男人|女人|女孩|男孩/.test(text), 'people');
  add(/瓶|香水|罐|盒|包装|商品|产品|手机|耳机|鞋|衣服|夹克|饮料/.test(text), 'product hero shot');
  add(/群殴|打架|搏斗|争斗|冲突|战斗/.test(text), 'non-graphic chaotic group fight, dynamic action scene');
  add(/森林|丛林|树|草地|野外/.test(text), 'outdoor natural environment');
  add(/电影|大片|戏剧/.test(text), 'cinematic photography');
  add(/写实|真实|现实/.test(text), 'realistic photography');
  add(/卡通|动画/.test(text), 'stylized animation');

  if (parts.length === 0) return '';
  return dedupe([
    ...parts,
    'clear main subjects',
    'full bodies visible',
    'no text',
    'no calligraphy',
    'no decorative poster'
  ]).join(', ');
}

function hasAnimal(text: string): boolean {
  return /猫|鼠|老鼠|田鼠|狗|犬|猴|猿|\bcat\b|\bcats\b|\btabby\b|\bfeline\b|\bmouse\b|\bmice\b|\brat\b|\brodent\b|\bdog\b|\bdogs\b|\bmonkey\b|\bmonkeys\b/i.test(text);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

// ===== ComfyUI =====

async function comfyGenerate(baseUrl: string, input: GenerateImageInput): Promise<void> {
  const workflow = await loadWorkflow(baseUrl, input);
  const clientId = `frame_${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = Date.now();
  const progressSocket = await connectProgressSocket(baseUrl, clientId, input.onProgress, startedAt);

  try {
    // 1. POST /prompt
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

    // 2. 轮询 /history/{promptId}
    const historyTimeoutMs = readPositiveInt(process.env.COMFYUI_HISTORY_TIMEOUT_MS, 30 * 60_000);
    const deadline = Date.now() + historyTimeoutMs;
    let outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> | null = null;
    while (Date.now() < deadline) {
      const histResp = await fetch(`${baseUrl.replace(/\/$/, '')}/history/${promptId}`);
      if (histResp.ok) {
        const hist = (await histResp.json()) as Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }>;
        const entry = hist[promptId];
        if (entry && entry.outputs) {
          outputs = entry.outputs;
          break;
        }
      }
      await sleep(800);
    }
    if (!outputs) {
      throw new Error(`comfyui timed out polling /history after ${Math.round(historyTimeoutMs / 1000)}s`);
    }

    // 3. 取第一个 image 输出
    const firstImg = Object.values(outputs)
      .flatMap(o => o.images ?? [])
      .find(Boolean);
    if (!firstImg) throw new Error('comfyui no image output');

    const params = new URLSearchParams({
      filename: firstImg.filename,
      subfolder: firstImg.subfolder,
      type: firstImg.type
    });
    const imgResp = await fetch(`${baseUrl.replace(/\/$/, '')}/view?${params}`);
    if (!imgResp.ok) throw new Error(`comfyui /view ${imgResp.status}`);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
    fs.writeFileSync(input.outPath, buf);
  } finally {
    progressSocket.close();
  }
}

async function connectProgressSocket(
  baseUrl: string,
  clientId: string,
  onProgress: GenerateImageInput['onProgress'],
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

async function loadWorkflow(baseUrl: string, input: GenerateImageInput): Promise<unknown> {
  const wfPath = process.env.COMFYUI_WORKFLOW?.trim();
  if (wfPath && fs.existsSync(wfPath)) {
    const tpl = fs.readFileSync(wfPath, 'utf8');
    return injectWorkflowParams(JSON.parse(tpl), input);
  }
  throw new Error('图片生成模式已移除,请使用 ComfyUI 视频模型工作流');
}

function injectWorkflowParams(wf: unknown, input: GenerateImageInput): unknown {
  // 遍历节点,替换 KSampler.seed / CLIPTextEncode / EmptyLatentImage / SaveImage
  if (!wf || typeof wf !== 'object') return wf;
  const obj = wf as Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
  for (const node of Object.values(obj)) {
    if (!node?.inputs) continue;
    const ct = node.class_type;
    if (ct === 'KSampler' || ct === 'KSamplerAdvanced') {
      node.inputs.seed = input.seed;
    }
    if (ct === 'CLIPTextEncode') {
      const title = (node._meta?.title || '').toLowerCase();
      if (title.includes('negative')) {
        node.inputs.text = input.negativePrompt;
      } else {
        node.inputs.text = input.prompt;
      }
    }
    if (ct === 'EmptyLatentImage') {
      node.inputs.width = input.width;
      node.inputs.height = input.height;
    }
  }
  return obj;
}

async function defaultWorkflow(input: GenerateImageInput, ckpt: string): Promise<Record<string, unknown>> {
  // 极简 SDXL 工作流,要求 ComfyUI 安装了 sd_xl_base_1.0 或类似 ckpt
  if (input.initImagePath) {
    const imageName = await prepareInputImage(input.initImagePath, input.width, input.height);
    return {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
      '10': { class_type: 'LoadImage', inputs: { image: imageName } },
      '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: input.prompt, clip: ['4', 1] },
        _meta: { title: 'positive' }
      },
      '7': {
        class_type: 'CLIPTextEncode',
        inputs: { text: input.negativePrompt, clip: ['4', 1] },
        _meta: { title: 'negative' }
      },
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: input.seed,
          steps: readPositiveInt(process.env.COMFYUI_STEPS, 12),
          cfg: readPositiveNumber(process.env.COMFYUI_CFG, 7),
          sampler_name: process.env.COMFYUI_SAMPLER || 'euler',
          scheduler: 'normal',
          denoise: readDenoise(process.env.COMFYUI_IMG2IMG_DENOISE, 0.58),
          model: ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['11', 0]
        }
      },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'frame', images: ['8', 0] } }
    };
  }

  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: input.width, height: input.height, batch_size: 1 } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: input.prompt, clip: ['4', 1] },
      _meta: { title: 'positive' }
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: input.negativePrompt, clip: ['4', 1] },
      _meta: { title: 'negative' }
    },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: input.seed,
        steps: readPositiveInt(process.env.COMFYUI_STEPS, 12),
        cfg: readPositiveNumber(process.env.COMFYUI_CFG, 7),
        sampler_name: process.env.COMFYUI_SAMPLER || 'euler',
        scheduler: 'normal',
        denoise: 1.0,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0]
      }
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'frame', images: ['8', 0] } }
  };
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

function readDenoise(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0.05, Math.min(1, parsed));
}

async function prepareInputImage(srcPath: string, width: number, height: number): Promise<string> {
  if (!fs.existsSync(srcPath)) throw new Error(`init image not found: ${srcPath}`);
  const comfyDir = process.env.COMFYUI_DIR?.trim()
    ? path.resolve(process.env.COMFYUI_DIR.trim())
    : path.join(process.cwd(), 'vendor', 'ComfyUI');
  const inputDir = path.join(comfyDir, 'input', 'frame_refs');
  fs.mkdirSync(inputDir, { recursive: true });
  const ext = '.png';
  const name = `${path.basename(srcPath, path.extname(srcPath))}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dst = path.join(inputDir, name);
  await sharp(srcPath)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(dst);
  return `frame_refs/${name}`;
}

/** 生成缩略图 (320 宽) */
export async function makeThumbnail(srcPath: string, outPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp(srcPath).resize({ width: 320, withoutEnlargement: false }).webp({ quality: 80 }).toFile(outPath);
}
