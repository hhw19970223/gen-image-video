import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const root = process.cwd();
const comfyDir = process.env.COMFYUI_DIR
  ? path.resolve(process.env.COMFYUI_DIR)
  : path.join(root, 'vendor', 'ComfyUI');
const modelUrl = process.env.COMFYUI_MODEL_URL || process.argv[2];

if (!modelUrl) {
  console.error('[comfyui:model] missing model URL');
  console.error('[comfyui:model] usage: npm run comfyui:model -- https://example.com/model.safetensors');
  process.exit(1);
}

const urlName = decodeURIComponent(new URL(modelUrl).pathname.split('/').filter(Boolean).pop() || '');
const modelName = process.env.COMFYUI_MODEL_NAME || process.argv[3] || urlName;
if (!modelName || !/\.(safetensors|ckpt)$/i.test(modelName)) {
  console.error('[comfyui:model] model name must end with .safetensors or .ckpt');
  process.exit(1);
}

const outDir = path.join(comfyDir, 'models', 'checkpoints');
const outPath = path.join(outDir, modelName);
fs.mkdirSync(outDir, { recursive: true });

if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
  console.log(`[comfyui:model] already exists: ${outPath}`);
  process.exit(0);
}

console.log(`[comfyui:model] downloading ${modelUrl}`);
console.log(`[comfyui:model] output ${outPath}`);

const response = await fetch(modelUrl);
if (!response.ok || !response.body) {
  console.error(`[comfyui:model] download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const total = Number(response.headers.get('content-length') || 0);
let received = 0;
const progress = new TransformStream({
  transform(chunk, controller) {
    received += chunk.byteLength;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      process.stdout.write(`\r[comfyui:model] ${pct}% ${Math.round(received / 1024 / 1024)}MB/${Math.round(total / 1024 / 1024)}MB`);
    } else {
      process.stdout.write(`\r[comfyui:model] ${Math.round(received / 1024 / 1024)}MB`);
    }
    controller.enqueue(chunk);
  }
});

await finished(Readable.fromWeb(response.body.pipeThrough(progress)).pipe(fs.createWriteStream(outPath)));
process.stdout.write('\n');
console.log(`[comfyui:model] saved ${outPath}`);
console.log(`[comfyui:model] set COMFYUI_CKPT=${modelName} if you want to pin this model`);
