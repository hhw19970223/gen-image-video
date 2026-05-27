import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WanHealth {
  configured: boolean;
  ready: boolean;
  python: string;
  script: string;
  modelId: string;
  ggufPath?: string;
  error?: string;
}

export async function checkWanDirect(timeoutMs = 10_000): Promise<WanHealth> {
  const python = resolveExecutable(process.env.WAN_PYTHON?.trim() || process.env.PYTHON_BIN?.trim() || 'python');
  const script = path.resolve(process.env.WAN_SCRIPT?.trim() || 'scripts/wan22-direct.py');
  const modelId = process.env.WAN_MODEL_ID || 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers';
  const ggufPath = process.env.WAN_GGUF_PATH?.trim()
    ? path.resolve(process.env.WAN_GGUF_PATH.trim())
    : undefined;
  if (!fs.existsSync(script)) {
    return { configured: false, ready: false, python, script, modelId, ggufPath, error: `script not found: ${script}` };
  }
  if (ggufPath && !fs.existsSync(ggufPath)) {
    return { configured: true, ready: false, python, script, modelId, ggufPath, error: `WAN_GGUF_PATH not found: ${ggufPath}` };
  }

  return new Promise(resolve => {
    const child = spawn(
      python,
      ['-c', 'import torch, diffusers, transformers, accelerate, gguf; from diffusers import GGUFQuantizationConfig, WanPipeline, WanTransformer3DModel, WanVACEPipeline, WanVACETransformer3DModel; print("ok")'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: false }
    );
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ configured: true, ready: false, python, script, modelId, ggufPath, error: 'python health check timed out' });
    }, timeoutMs);
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ configured: true, ready: false, python, script, modelId, ggufPath, error: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        configured: true,
        ready: code === 0,
        python,
        script,
        modelId,
        ggufPath,
        error: code === 0 ? undefined : err.slice(-800) || `python exited ${code}`
      });
    });
  });
}

function resolveExecutable(value: string): string {
  return value.includes('/') || value.includes('\\') ? path.resolve(value) : value;
}
