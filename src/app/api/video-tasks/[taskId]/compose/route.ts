import { NextRequest } from 'next/server';
import { jsonError } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  await params;
  return jsonError(410, '当前已切换为 ComfyUI GGUF 视频模式,不再支持图片合成视频');
}
