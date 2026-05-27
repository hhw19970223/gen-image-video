// 手动初始化数据库 / 检查环境
// 用法: npm run init-db

import { db } from './db';
import { checkFfmpeg } from './adapters/ffmpeg';
import { checkComfyUI } from './comfyui';
import { homeStats } from './repo';
import { DATA_DIR } from './paths';

async function main() {
  console.log('[init-db] DATA_DIR =', DATA_DIR);
  // 触发 schema 初始化
  db().prepare('SELECT 1').get();
  console.log('[init-db] schema OK');

  const ff = await checkFfmpeg();
  if (ff.ok) console.log(`[init-db] ffmpeg OK · ${ff.version ?? 'unknown'}`);
  else console.warn('[init-db] ffmpeg NOT FOUND — 视频合成将失败');

  const comfyui = await checkComfyUI();
  if (comfyui.reachable) {
    console.log(`[init-db] comfyui OK · ${comfyui.url}`);
    console.log(`[init-db] comfyui checkpoints · ${comfyui.checkpoints.length || 0}`);
  }
  else console.warn(`[init-db] comfyui NOT READY · ${comfyui.url}`);

  const stats = homeStats();
  console.log(`[init-db] 当前: ${stats.monthCount} 任务/月 · ${stats.cacheKeyframes} 关键帧缓存 · ${Math.round(stats.cacheHitRate * 100)}% 命中`);

  console.log('[init-db] env:');
  console.log('  COMFYUI_URL =', process.env.COMFYUI_URL || '(默认 http://127.0.0.1:8188)');
  console.log('  CODEX_BIN  =', process.env.CODEX_BIN || '(留空 → 规则 fallback)');
  console.log('  FFMPEG_BIN =', process.env.FFMPEG_BIN || '(从 PATH 读取)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
