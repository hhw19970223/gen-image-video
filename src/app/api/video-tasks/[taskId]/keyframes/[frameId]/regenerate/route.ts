import { NextRequest, NextResponse } from 'next/server';
import { fullTask, jsonError } from '@/lib/api-helpers';
import { regenerateKeyframe } from '@/lib/orchestrator';
import { getKeyframe, getTask, updateKeyframe } from '@/lib/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string; frameId: string }> }
) {
  const { taskId, frameId } = await params;
  const t = getTask(taskId);
  const kf = getKeyframe(frameId);
  if (!t) return jsonError(404, '任务不存在');
  if (!kf || kf.task_id !== taskId) return jsonError(404, '关键帧不存在');

  let body: { prompt?: string; seed?: number; lock?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body OK */
  }

  // 锁定/解锁开关 (no regeneration)
  if (typeof body.lock === 'boolean') {
    updateKeyframe(frameId, { locked: body.lock ? 1 : 0 });
    return NextResponse.json(fullTask(taskId, t));
  }

  if (kf.locked) return jsonError(400, '该帧已锁定,先解锁再重新生成');
  if (body.prompt !== undefined && (typeof body.prompt !== 'string' || body.prompt.trim().length < 4)) {
    return jsonError(400, 'prompt 至少需要 4 个字符');
  }

  await regenerateKeyframe(taskId, frameId, {
    newPrompt: body.prompt?.trim(),
    newSeed: typeof body.seed === 'number' ? body.seed : undefined
  });

  return NextResponse.json(fullTask(taskId, getTask(taskId)!));
}
