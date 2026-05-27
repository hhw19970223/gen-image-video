import { NextRequest, NextResponse } from 'next/server';
import { jsonError, serializeTask, validateCreate } from '@/lib/api-helpers';
import { enqueueTask } from '@/lib/orchestrator';
import { checkWanDirect } from '@/lib/wan';
import { homeStats, insertTask, listTasks } from '@/lib/repo';
import { logInfo, logWarn, stepTimer } from '@/lib/logger';
import type { TaskStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const timer = stepTimer('api.video-tasks', 'POST');
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    timer.fail(error, { stage: 'parseJson' });
    return jsonError(400, '请求体不是合法 JSON');
  }

  const v = validateCreate(body);
  if (!v.ok) {
    logWarn('api.video-tasks', 'validationFailed', { error: v.error });
    timer.done({ ok: false, stage: 'validation', error: v.error });
    return jsonError(400, v.error);
  }

  const healthTimer = stepTimer('api.video-tasks', 'wanHealthBeforeCreate', {
    prompt: v.value.prompt,
    duration: v.value.duration,
    frameCount: v.value.frame_count
  });
  const wan = await checkWanDirect();
  healthTimer.done({ ready: wan.ready, configured: wan.configured, error: wan.error });
  if (!wan.ready) {
    logWarn('api.video-tasks', 'wanNotReady', { wan });
    timer.done({ ok: false, stage: 'wanHealth', wanReady: false });
    return jsonError(
      503,
      `ComfyUI GGUF 后端未就绪: ${wan.error ?? '请启动 ComfyUI 并安装 GGUF 工作流节点'}`
    );
  }

  const task = insertTask(v.value);
  logInfo('api.video-tasks', 'taskInserted', {
    taskId: task.id,
    prompt: task.prompt,
    duration: task.duration,
    frameCount: task.frame_count,
    fps: task.fps,
    motion: task.motion_type
  });
  enqueueTask(task.id);
  timer.done({ ok: true, taskId: task.id });
  return NextResponse.json({ task: serializeTask(task) }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const timer = stepTimer('api.video-tasks', 'GET');
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') as TaskStatus | null;
  const limit = Number(searchParams.get('limit') ?? 50);
  const tasks = listTasks({ status: status ?? undefined, limit });
  const stats = homeStats();
  timer.done({ status, limit, taskCount: tasks.length });
  return NextResponse.json({
    tasks: tasks.map(serializeTask),
    stats
  });
}
