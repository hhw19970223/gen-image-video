import { NextRequest, NextResponse } from 'next/server';
import { fullTask, jsonError } from '@/lib/api-helpers';
import { composeForTask } from '@/lib/orchestrator';
import { getTask } from '@/lib/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const t = getTask(taskId);
  if (!t) return jsonError(404, '任务不存在');
  try {
    await composeForTask(taskId);
  } catch (e) {
    return jsonError(500, (e as Error).message);
  }
  return NextResponse.json(fullTask(taskId, getTask(taskId)!));
}
