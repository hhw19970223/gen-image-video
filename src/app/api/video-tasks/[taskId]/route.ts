import { NextRequest, NextResponse } from 'next/server';
import { fullTask, jsonError } from '@/lib/api-helpers';
import { deleteTask, getTask, resetTaskForRetry } from '@/lib/repo';
import { cancelTaskPipeline, enqueueTask, resumeTaskPipeline } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const t = getTask(taskId);
  if (!t) return jsonError(404, '任务不存在');
  return NextResponse.json(fullTask(taskId, t));
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const t = getTask(taskId);
  if (!t) return jsonError(404, '任务不存在');
  const body = (await req.json()) as { action?: string };

  if (body.action === 'retry') {
    if (t.status !== 'failed' && t.status !== 'cancelled') {
      return jsonError(400, '仅失败/取消任务可以重试');
    }
    resetTaskForRetry(taskId);
    enqueueTask(taskId);
    return NextResponse.json(fullTask(taskId, getTask(taskId)!));
  }

  if (body.action === 'cancel') {
    if (t.status === 'completed' || t.status === 'cancelled') {
      return jsonError(400, '该任务当前状态不能取消');
    }
    await cancelTaskPipeline(taskId);
    return NextResponse.json(fullTask(taskId, getTask(taskId)!));
  }

  if (body.action === 'resume') {
    if (t.status === 'completed' || t.status === 'cancelled') {
      return jsonError(400, '该任务当前状态不能继续');
    }
    resumeTaskPipeline(taskId);
    return NextResponse.json(fullTask(taskId, getTask(taskId)!));
  }

  return jsonError(400, '未知操作');
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  if (!getTask(taskId)) return jsonError(404, '任务不存在');
  deleteTask(taskId);
  return NextResponse.json({ ok: true });
}
