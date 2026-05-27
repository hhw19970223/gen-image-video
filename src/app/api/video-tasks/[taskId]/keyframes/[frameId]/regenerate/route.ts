import { NextRequest } from 'next/server';
import { jsonError } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string; frameId: string }> }
) {
  await params;
  await req.text().catch(() => '');
  return jsonError(410, '当前已切换为 ComfyUI GGUF 视频模式,不再支持单帧操作');
}
