import { NextRequest, NextResponse } from 'next/server';
import { jsonError, serializeTask, validateCreate } from '@/lib/api-helpers';
import { enqueueTask } from '@/lib/orchestrator';
import { checkWanDirect } from '@/lib/wan';
import { homeStats, insertTask, listTasks } from '@/lib/repo';
import type { TaskStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, '请求体不是合法 JSON');
  }
  const v = validateCreate(body);
  if (!v.ok) return jsonError(400, v.error);
  const wan = await checkWanDirect();
  if (!wan.ready) {
    return jsonError(
      503,
      `Wan 直接生成后端未就绪: ${wan.error ?? '请配置 Python / CUDA / diffusers 环境'}`
    );
  }
  const task = insertTask(v.value);
  enqueueTask(task.id);
  return NextResponse.json({ task: serializeTask(task) }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') as TaskStatus | null;
  const limit = Number(searchParams.get('limit') ?? 50);
  const tasks = listTasks({ status: status ?? undefined, limit });
  return NextResponse.json({
    tasks: tasks.map(serializeTask),
    stats: homeStats()
  });
}
