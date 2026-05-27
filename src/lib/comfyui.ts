export interface ComfyHealth {
  url: string;
  configured: boolean;
  reachable: boolean;
  modelReady: boolean;
  checkpoints: string[];
  videoModels: string[];
  missingVideoModels: string[];
  error?: string;
}

export function resolveComfyUrl(): string {
  return process.env.COMFYUI_URL?.trim() || 'http://127.0.0.1:8188';
}

export async function checkComfyUI(timeoutMs = 2500): Promise<ComfyHealth> {
  const url = resolveComfyUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/system_stats`, {
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) {
      return {
        url,
        configured: true,
        reachable: false,
        modelReady: false,
        checkpoints: [],
        videoModels: [],
        missingVideoModels: [],
        error: `ComfyUI health returned ${response.status}`
      };
    }
    const [checkpoints, video] = await Promise.all([
      listComfyCheckpoints(url, timeoutMs),
      checkComfyVideoModels(url, timeoutMs)
    ]);
    return {
      url,
      configured: true,
      reachable: true,
      modelReady: video.ready,
      checkpoints,
      videoModels: video.available,
      missingVideoModels: video.missing
    };
  } catch (error) {
    return {
      url,
      configured: true,
      reachable: false,
      modelReady: false,
      checkpoints: [],
      videoModels: [],
      missingVideoModels: [],
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkComfyVideoModels(baseUrl = resolveComfyUrl(), timeoutMs = 2500): Promise<{
  ready: boolean;
  available: string[];
  missing: string[];
}> {
  const required = [
    { node: 'UNETLoader', input: 'unet_name', name: process.env.COMFYUI_VIDEO_MODEL?.trim() || 'wan2.2_ti2v_5B_fp16.safetensors' },
    { node: 'VAELoader', input: 'vae_name', name: process.env.COMFYUI_VIDEO_VAE?.trim() || 'wan2.2_vae.safetensors' },
    { node: 'CLIPLoader', input: 'clip_name', name: process.env.COMFYUI_VIDEO_TEXT_ENCODER?.trim() || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors' }
  ];
  const available: string[] = [];
  const missing: string[] = [];
  for (const item of required) {
    const options = await listComfyInputOptions(baseUrl, item.node, item.input, timeoutMs);
    if (options.includes(item.name)) available.push(item.name);
    else missing.push(item.name);
  }
  return { ready: missing.length === 0, available, missing };
}

async function listComfyInputOptions(
  baseUrl: string,
  nodeName: string,
  inputName: string,
  timeoutMs: number
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/object_info/${nodeName}`, {
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) return [];
    const data = await response.json() as Record<string, { input?: { required?: Record<string, [unknown, unknown]> } }>;
    const raw = data[nodeName]?.input?.required?.[inputName]?.[0];
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function listComfyCheckpoints(baseUrl = resolveComfyUrl(), timeoutMs = 2500): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/object_info/CheckpointLoaderSimple`, {
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) return [];
    const data = await response.json() as {
      CheckpointLoaderSimple?: {
        input?: { required?: { ckpt_name?: [unknown, unknown] } };
      };
    };
    const raw = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface ComfyTaskPromptRef {
  prompt: string;
  seed: number;
  width: number;
  height: number;
}

export interface ComfyCancelResult {
  deleted: string[];
  interrupted: boolean;
  error?: string;
}

type QueueEntry = [
  number,
  string,
  Record<string, { class_type?: string; inputs?: Record<string, unknown> }>,
  unknown?,
  unknown?
];

export async function cancelComfyPrompts(
  refs: ComfyTaskPromptRef[],
  baseUrl = resolveComfyUrl()
): Promise<ComfyCancelResult> {
  const result: ComfyCancelResult = { deleted: [], interrupted: false };
  const normalizedUrl = baseUrl.replace(/\/$/, '');

  try {
    const queueResp = await fetch(`${normalizedUrl}/queue`, { cache: 'no-store' });
    if (!queueResp.ok) {
      return { ...result, error: `ComfyUI /queue ${queueResp.status}` };
    }

    const queue = (await queueResp.json()) as {
      queue_running?: QueueEntry[];
      queue_pending?: QueueEntry[];
    };
    const pending = queue.queue_pending ?? [];
    const running = queue.queue_running ?? [];

    const pendingMatches = pending.filter(entry => workflowMatchesRefs(entry[2], refs));
    const runningMatches = running.filter(entry => workflowMatchesRefs(entry[2], refs));

    if (pendingMatches.length > 0) {
      const ids = pendingMatches.map(entry => entry[1]);
      const deleteResp = await fetch(`${normalizedUrl}/queue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: ids })
      });
      if (deleteResp.ok) {
        result.deleted = ids;
      } else {
        result.error = `ComfyUI queue delete ${deleteResp.status}`;
      }
    }

    if (runningMatches.length > 0) {
      const interruptResp = await fetch(`${normalizedUrl}/interrupt`, { method: 'POST' });
      result.interrupted = interruptResp.ok;
      if (!interruptResp.ok) {
        result.error = `ComfyUI interrupt ${interruptResp.status}`;
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

function workflowMatchesRefs(
  workflow: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>,
  refs: ComfyTaskPromptRef[]
): boolean {
  const seed = findSamplerSeed(workflow);
  const prompt = findPositivePrompt(workflow);
  const size = findLatentSize(workflow);
  if (seed === null || !prompt) return false;

  return refs.some(ref =>
    ref.seed === seed &&
    ref.prompt === prompt &&
    (!size || (ref.width === size.width && ref.height === size.height))
  );
}

function findSamplerSeed(workflow: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>): number | null {
  for (const node of Object.values(workflow)) {
    if (node.class_type !== 'KSampler' && node.class_type !== 'KSamplerAdvanced') continue;
    const seed = node.inputs?.seed;
    return typeof seed === 'number' ? seed : Number.isFinite(Number(seed)) ? Number(seed) : null;
  }
  return null;
}

function findPositivePrompt(workflow: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>): string | null {
  for (const node of Object.values(workflow)) {
    if (node.class_type !== 'CLIPTextEncode') continue;
    const title = String((node as { _meta?: { title?: string } })._meta?.title ?? '').toLowerCase();
    if (title.includes('negative')) continue;
    const text = node.inputs?.text;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

function findLatentSize(
  workflow: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
): { width: number; height: number } | null {
  for (const node of Object.values(workflow)) {
    if (node.class_type !== 'EmptyLatentImage') continue;
    const width = Number(node.inputs?.width);
    const height = Number(node.inputs?.height);
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  }
  return null;
}
