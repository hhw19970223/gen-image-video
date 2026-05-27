import { NextRequest, NextResponse } from 'next/server';
import { jsonError, validateCreate } from '@/lib/api-helpers';
import { planFrames } from '@/lib/adapters/codex';

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

  const motion = v.value.motion_type ?? 'zoom_in';
  const frameCount = v.value.frame_count ?? v.value.duration;
  const plan = await planFrames(v.value, frameCount, motion);

  return NextResponse.json({ plan });
}
