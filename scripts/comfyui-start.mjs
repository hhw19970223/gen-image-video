import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const comfyDir = process.env.COMFYUI_DIR
  ? path.resolve(process.env.COMFYUI_DIR)
  : path.join(root, 'vendor', 'ComfyUI');
const host = process.env.COMFYUI_HOST || '127.0.0.1';
const port = process.env.COMFYUI_PORT || '8188';

function fail(message) {
  console.error(`[comfyui] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(comfyDir, 'main.py'))) {
  fail(`ComfyUI not found at ${comfyDir}. Run npm run comfyui:install first, or set COMFYUI_DIR.`);
}

const venvPython = process.platform === 'win32'
  ? path.join(comfyDir, '.venv', 'Scripts', 'python.exe')
  : path.join(comfyDir, '.venv', 'bin', 'python');
const python = fs.existsSync(venvPython) ? venvPython : (process.env.PYTHON_BIN || 'python');

console.log(`[comfyui] starting ${comfyDir}`);
console.log(`[comfyui] url http://${host}:${port}`);

const args = ['main.py', '--listen', host, '--port', String(port)];
const hasCuda = (() => {
  try {
    const result = spawnSync(python, ['-c', 'import torch; print(torch.cuda.is_available())'], {
      cwd: comfyDir,
      encoding: 'utf8',
      shell: process.platform === 'win32'
    });
    return result.status === 0 && result.stdout.trim() === 'True';
  } catch {
    return false;
  }
})();

if (!hasCuda && !process.env.COMFYUI_EXTRA_ARGS?.includes('--cpu')) {
  args.push('--cpu');
  console.log('[comfyui] CUDA not detected; starting with --cpu');
}

if (process.env.COMFYUI_EXTRA_ARGS) {
  args.push(...process.env.COMFYUI_EXTRA_ARGS.split(' ').filter(Boolean));
}

const child = spawn(python, args, {
  cwd: comfyDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('error', (error) => fail(error.message));
child.on('close', (code) => process.exit(code ?? 0));
