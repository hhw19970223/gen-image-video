import { NextResponse } from 'next/server';
import { checkFfmpeg } from '@/lib/adapters/ffmpeg';
import { checkComfyUI } from '@/lib/comfyui';
import { homeStats } from '@/lib/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const [ff, comfyui] = await Promise.all([checkFfmpeg(), checkComfyUI()]);
  return NextResponse.json({
    ffmpeg: ff,
    comfyui,
    codex: {
      bin: process.env.CODEX_BIN || null,
      configured: !!process.env.CODEX_BIN,
      appThreadId: process.env.CODEX_THREAD_ID || null
    },
    rife: { enabled: process.env.RIFE_ENABLED === 'true' },
    stats: homeStats()
  });
}
