import { NextRequest } from 'next/server';
import { bus, type TaskEvent } from '@/lib/events';
import { getTask } from '@/lib/repo';
import { fullTask } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events stream for task progress.
 * Client: const es = new EventSource(`/api/video-tasks/${id}/stream`);
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const t = getTask(taskId);
  if (!t) return new Response('not found', { status: 404 });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* closed */
        }
      };

      // 1. 立即推送当前完整状态
      send('snapshot', fullTask(taskId, getTask(taskId)!));

      // 2. 订阅事件总线
      const onEvent = (ev: TaskEvent) => {
        send(ev.type, { ...ev, snapshot: fullTask(taskId, getTask(taskId)!) });
      };
      bus.on(taskId, onEvent);

      // 3. 心跳防止反向代理超时
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
      }, 15_000);

      // 4. 清理
      const cleanup = () => {
        clearInterval(ping);
        bus.off(taskId, onEvent);
        try {
          controller.close();
        } catch {
          /* */
        }
      };
      _req.signal.addEventListener('abort', cleanup);
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
}
