import { checkComfyWanGguf } from './adapters/comfyui-gguf';

export interface WanHealth {
  configured: boolean;
  ready: boolean;
  backend: 'comfyui-gguf';
  url: string;
  model: string;
  clip: string;
  vae: string;
  error?: string;
}

export async function checkWanDirect(timeoutMs = 10_000): Promise<WanHealth> {
  return checkComfyWanGguf(timeoutMs);
}
