import { NextRequest, NextResponse } from 'next/server';
import { serializeTask } from '@/lib/api-helpers';
import { listTasksByCodexAppThread } from '@/lib/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const threadId =
    searchParams.get('thread_id')?.trim() ||
    process.env.CODEX_THREAD_ID?.trim() ||
    null;

  if (!threadId) {
    return NextResponse.json({
      bound: false,
      thread_id: null,
      tasks: []
    });
  }

  const limit = Number(searchParams.get('limit') ?? 50);
  const tasks = listTasksByCodexAppThread(threadId, Number.isFinite(limit) ? limit : 50);

  return NextResponse.json({
    bound: true,
    thread_id: threadId,
    tasks: tasks.map(serializeTask)
  });
}
