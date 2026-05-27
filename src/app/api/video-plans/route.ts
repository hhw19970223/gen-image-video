import { NextRequest, NextResponse } from 'next/server';
import { jsonError, validateCreate } from '@/lib/api-helpers';
import { planFrames } from '@/lib/adapters/codex';
import { logWarn, stepTimer } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const timer = stepTimer('api.video-plans', 'POST');
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    timer.fail(error, { stage: 'parseJson' });
    return jsonError(400, '请求体不是合法 JSON');
  }

  const v = validateCreate(body);
  if (!v.ok) {
    logWarn('api.video-plans', 'validationFailed', { error: v.error });
    timer.done({ ok: false, stage: 'validation', error: v.error });
    return jsonError(400, v.error);
  }

  const motion = v.value.motion_type ?? 'zoom_in';
  const frameCount = v.value.frame_count ?? v.value.duration;
  try {
    const plan = await planFrames(v.value, frameCount, motion);
    timer.done({
      ok: true,
      prompt: v.value.prompt,
      duration: v.value.duration,
      frameCount,
      motion,
      source: plan.source
    });
    return NextResponse.json({ plan });
  } catch (error) {
    timer.fail(error, { prompt: v.value.prompt, frameCount, motion });
    throw error;
  }
}
