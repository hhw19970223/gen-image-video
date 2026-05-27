import { NextResponse } from 'next/server';
import { checkFfmpeg } from '@/lib/adapters/ffmpeg';
import { checkWanDirect } from '@/lib/wan';
import { homeStats } from '@/lib/repo';
import { stepTimer } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const timer = stepTimer('api.health', 'GET');
  try {
    const [ff, wan] = await Promise.all([checkFfmpeg(), checkWanDirect()]);
    const body = {
      ffmpeg: ff,
      wan,
      codex: {
        bin: process.env.CODEX_BIN || null,
        configured: !!process.env.CODEX_BIN,
        appThreadId: process.env.CODEX_THREAD_ID || null
      },
      rife: { enabled: process.env.RIFE_ENABLED === 'true' },
      stats: homeStats()
    };
    timer.done({ ffmpegOk: ff.ok, wanReady: wan.ready, wanConfigured: wan.configured });
    return NextResponse.json(body);
  } catch (error) {
    timer.fail(error);
    throw error;
  }
}
