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
  if (wan.ready) console.log(`[init-db] wan direct OK · ${wan.modelId}`);
  else console.warn(`[init-db] wan direct NOT READY · ${wan.error ?? 'unknown'}`);

  const stats = homeStats();
  console.log(`[init-db] tasks this month: ${stats.monthCount}`);
  console.log('[init-db] env:');
  console.log('  WAN_MODEL_ID =', process.env.WAN_MODEL_ID || 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers');
  console.log('  CODEX_BIN    =', process.env.CODEX_BIN || '(fallback)');
  console.log('  FFMPEG_BIN   =', process.env.FFMPEG_BIN || '(PATH)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
