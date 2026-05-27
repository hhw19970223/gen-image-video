import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const comfyDir = process.env.COMFYUI_DIR
  ? path.resolve(process.env.COMFYUI_DIR)
  : path.join(root, 'vendor', 'ComfyUI');

const children = [];

function spawnChild(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  children.push(child);
  child.on('close', (code) => {
    if (code && code !== 0) console.error(`[${name}] exited ${code}`);
  });
  return child;
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

if (fs.existsSync(path.join(comfyDir, 'main.py'))) {
  const venvPython = process.platform === 'win32'
    ? path.join(comfyDir, '.venv', 'Scripts', 'python.exe')
    : path.join(comfyDir, '.venv', 'bin', 'python');
  const python = fs.existsSync(venvPython) ? venvPython : (process.env.PYTHON_BIN || 'python');
  const host = process.env.COMFYUI_HOST || '127.0.0.1';
  const port = process.env.COMFYUI_PORT || '8188';
  spawnChild('comfyui', python, ['main.py', '--listen', host, '--port', String(port)], { cwd: comfyDir });
} else {
  console.warn(`[comfyui] ${comfyDir} not found; run npm run comfyui:install`);
}

spawnChild('next', 'npm', ['run', 'dev']);
