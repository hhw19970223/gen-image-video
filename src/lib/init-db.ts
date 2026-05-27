import { checkFfmpeg } from './adapters/ffmpeg';
import { db } from './db';
import { DATA_DIR } from './paths';
import { homeStats } from './repo';
import { checkWanDirect } from './wan';

async function main() {
  console.log('[init-db] DATA_DIR =', DATA_DIR);
  db().prepare('SELECT 1').get();
  console.log('[init-db] schema OK');

  const ff = await checkFfmpeg();
  if (ff.ok) console.log(`[init-db] ffmpeg OK · ${ff.version ?? 'unknown'}`);
  else console.warn('[init-db] ffmpeg NOT FOUND');

  const wan = await checkWanDirect();
  if (wan.ready) console.log(`[init-db] ComfyUI GGUF OK · ${wan.model}`);
  else console.warn(`[init-db] ComfyUI GGUF NOT READY · ${wan.error ?? 'unknown'}`);

  const stats = homeStats();
  console.log(`[init-db] tasks this month: ${stats.monthCount}`);
  console.log('[init-db] env:');
  console.log('  COMFYUI_URL       =', process.env.COMFYUI_URL || 'http://127.0.0.1:8188');
  console.log('  COMFYUI_WAN_MODEL =', process.env.COMFYUI_WAN_MODEL || 'wan2.1_t2v_1.3b-q2_k.gguf');
  console.log('  CODEX_BIN         =', process.env.CODEX_BIN || '(fallback)');
  console.log('  FFMPEG_BIN        =', process.env.FFMPEG_BIN || '(PATH)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
