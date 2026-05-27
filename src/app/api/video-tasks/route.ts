import { NextRequest, NextResponse } from 'next/server';
import { jsonError, serializeTask, validateCreate } from '@/lib/api-helpers';
import { enqueueTask } from '@/lib/orchestrator';
import { checkComfyUI } from '@/lib/comfyui';
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
  const comfyui = await checkComfyUI();
  if (!comfyui.reachable) {
    return jsonError(
      503,
      `ComfyUI 未启动或不可访问 (${comfyui.url})。请运行 npm run comfyui:start,或在 .env.local 设置 COMFYUI_URL。`
    );
  }
  if (!comfyui.modelReady) {
    const missing = comfyui.missingVideoModels.length
      ? comfyui.missingVideoModels.join(', ')
      : 'Wan2.2 5B 视频模型';
    return jsonError(
      503,
      `ComfyUI 已启动,但视频模型未就绪。缺少: ${missing}。请等待 Wan2.2 5B 下载完成后重启 ComfyUI。`
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
