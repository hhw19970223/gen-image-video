import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const vendorDir = path.join(root, 'vendor');
const comfyDir = process.env.COMFYUI_DIR
  ? path.resolve(process.env.COMFYUI_DIR)
  : path.join(vendorDir, 'ComfyUI');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`));
    });
  });
}

function canRun(command, args = ['--version']) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function main() {
  fs.mkdirSync(vendorDir, { recursive: true });

  if (!fs.existsSync(comfyDir)) {
    console.log(`[comfyui] cloning into ${comfyDir}`);
    await run('git', ['clone', 'https://github.com/comfyanonymous/ComfyUI.git', comfyDir]);
  } else {
    console.log(`[comfyui] using existing ${comfyDir}`);
  }

  const venvDir = path.join(comfyDir, '.venv');
  const uvAvailable = await canRun('uv');
  const python = process.env.PYTHON_BIN || 'python';
  const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');

  if (!fs.existsSync(venvPython)) {
    console.log('[comfyui] creating Python venv');
    if (uvAvailable) {
      await run('uv', ['python', 'install', process.env.COMFYUI_PYTHON_VERSION || '3.12']);
      await run('uv', ['venv', venvDir, '--python', process.env.COMFYUI_PYTHON_VERSION || '3.12'], { cwd: comfyDir });
    } else {
      await run(python, ['-m', 'venv', venvDir], { cwd: comfyDir });
    }
  }

  console.log('[comfyui] installing Python dependencies');
  if (uvAvailable) {
    try {
      await run('uv', ['pip', 'install', '--python', venvPython, '--upgrade', 'pip', '--link-mode=copy'], { cwd: comfyDir });
      await run('uv', ['pip', 'install', '--python', venvPython, '-r', 'requirements.txt', '--link-mode=copy'], { cwd: comfyDir });
    } catch (error) {
      console.warn('[comfyui] uv pip install failed, retrying with venv pip');
      console.warn(error instanceof Error ? error.message : error);
      await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: comfyDir });
      await run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: comfyDir });
    }
  } else {
    await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: comfyDir });
    await run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: comfyDir });
  }

  console.log('');
  console.log('[comfyui] install complete');
  console.log(`[comfyui] directory: ${comfyDir}`);
  console.log('[comfyui] next: put an SDXL checkpoint in ComfyUI/models/checkpoints');
  console.log('[comfyui] then run: npm run comfyui:start');
}

main().catch((error) => {
  console.error('[comfyui] install failed');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
