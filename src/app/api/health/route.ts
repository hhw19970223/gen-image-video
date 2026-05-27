import { NextResponse } from 'next/server';
import { checkFfmpeg } from '@/lib/adapters/ffmpeg';
import { checkWanDirect } from '@/lib/wan';
import { homeStats } from '@/lib/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const [ff, wan] = await Promise.all([checkFfmpeg(), checkWanDirect()]);
  return NextResponse.json({
    ffmpeg: ff,
    wan,
    codex: {
      bin: process.env.CODEX_BIN || null,
      configured: !!process.env.CODEX_BIN,
      appThreadId: process.env.CODEX_THREAD_ID || null
    },
    rife: { enabled: process.env.RIFE_ENABLED === 'true' },
    stats: homeStats()
  });
}
