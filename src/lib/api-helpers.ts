// 共享 API 辅助 —— 输入校验、序列化

import { NextResponse } from 'next/server';
import { listChatLogs, listKeyframes } from './repo';
import { toServeUrl } from './paths';
import { referenceImageUrls, validateReferenceImagePaths } from './reference-images';
import type {
  AspectRatio,
  ChatLogRow,
  CreateTaskInput,
  KeyframeRow,
  MotionType,
  Style,
  VideoTaskRow
} from './types';
import { RATIO_DIMENSIONS } from './types';

const STYLES: readonly Style[] = ['realistic', 'cartoon', 'product_photography', 'cyberpunk', 'cinematic', 'anime'] as const;
const MOTIONS: readonly MotionType[] = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'fade', 'crossfade'] as const;
const RATIOS: readonly AspectRatio[] = ['9:16', '16:9', '1:1'] as const;

export function validateCreate(body: unknown): { ok: true; value: CreateTaskInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || !body) return { ok: false, error: '请求体必须是 JSON 对象' };
  const b = body as Record<string, unknown>;
  if (typeof b.prompt !== 'string' || b.prompt.trim().length < 4) {
    return { ok: false, error: 'prompt 至少需要 4 个字符' };
  }
  if (typeof b.aspect_ratio !== 'string' || !RATIOS.includes(b.aspect_ratio as AspectRatio)) {
    return { ok: false, error: `aspect_ratio 必须是 ${RATIOS.join('/')}` };
  }
  const duration = Number(b.duration);
  if (!Number.isInteger(duration) || duration < 3 || duration > 60) {
    return { ok: false, error: 'duration 必须在 3 - 60 秒之间' };
  }
  const fps = b.fps === undefined ? undefined : Number(b.fps);
  if (fps !== undefined && (!Number.isFinite(fps) || fps < 12 || fps > 60)) {
    return { ok: false, error: 'fps 必须在 12 - 60 之间' };
  }
  const frameCount = b.frame_count === undefined ? duration : Number(b.frame_count);
  if (!Number.isInteger(frameCount) || frameCount < 3 || frameCount > 60) {
    return { ok: false, error: 'frame_count 必须在 3 - 60 之间' };
  }
  if (b.style !== undefined && b.style !== null && !STYLES.includes(b.style as Style)) {
    return { ok: false, error: `style 必须是 ${STYLES.join('/')}` };
  }
  if (b.motion_type !== undefined && b.motion_type !== null && !MOTIONS.includes(b.motion_type as MotionType)) {
    return { ok: false, error: `motion_type 必须是 ${MOTIONS.join('/')}` };
  }
  return {
    ok: true,
    value: {
      prompt: b.prompt.trim(),
      aspect_ratio: b.aspect_ratio as AspectRatio,
      duration,
      fps,
      frame_count: frameCount,
      style: (b.style as Style) ?? undefined,
      motion_type: (b.motion_type as MotionType) ?? undefined,
      seed: typeof b.seed === 'number' ? b.seed : undefined,
      reference_image_paths: validateReferenceImagePaths(b.reference_image_paths ?? b.reference_image_path),
      confirmed_plan: validateConfirmedPlan(b.confirmed_plan, frameCount)
    }
  };
}

function validateConfirmedPlan(value: unknown, frameCount: number): CreateTaskInput['confirmed_plan'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const overallRaw = raw.overallPlan && typeof raw.overallPlan === 'object'
    ? raw.overallPlan as Record<string, unknown>
    : {};
  const smoothRaw = raw.smoothAnimation && typeof raw.smoothAnimation === 'object'
    ? raw.smoothAnimation as Record<string, unknown>
    : null;
  const agentSkills = Array.isArray(raw.agentSkills)
    ? raw.agentSkills.map(item => {
      const skill = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        agent: String(skill.agent ?? 'Agent'),
        skill: String(skill.skill ?? 'planning'),
        output: String(skill.output ?? '')
      };
    })
    : [];
  return {
    overallPlan: {
      concept: String(overallRaw.concept ?? ''),
      visualStyle: String(overallRaw.visualStyle ?? ''),
      cameraLanguage: String(overallRaw.cameraLanguage ?? ''),
      continuityRules: String(overallRaw.continuityRules ?? ''),
      referenceUsage: overallRaw.referenceUsage === undefined ? undefined : String(overallRaw.referenceUsage)
    },
    animationDescription: typeof raw.animationDescription === 'string' ? raw.animationDescription : undefined,
    smoothAnimation: smoothRaw
      ? {
        durationSeconds: Number.isFinite(Number(smoothRaw.durationSeconds)) ? Number(smoothRaw.durationSeconds) : frameCount,
        summary: String(smoothRaw.summary ?? ''),
        motionArc: String(smoothRaw.motionArc ?? ''),
        timing: String(smoothRaw.timing ?? ''),
        transitionLogic: String(smoothRaw.transitionLogic ?? ''),
        continuityStrategy: String(smoothRaw.continuityStrategy ?? '')
      }
      : undefined,
    agentSkills,
    negativePrompt: String(raw.negativePrompt ?? ''),
    notes: String(raw.notes ?? ''),
    source: raw.source === 'codex' || raw.source === 'fallback' ? raw.source : undefined,
    codexThreadId: typeof raw.codexThreadId === 'string' ? raw.codexThreadId : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined
  };
}

export function serializeTask(t: VideoTaskRow) {
  return {
    id: t.id,
    prompt: t.prompt,
    style: t.style,
    aspect_ratio: t.aspect_ratio,
    width: t.width,
    height: t.height,
    duration: t.duration,
    fps: t.fps,
    frame_count: t.frame_count,
    motion_type: t.motion_type,
    seed: t.seed,
    status: t.status,
    progress: t.progress,
    stage_message: t.stage_message,
    video_url: t.video_path ? toServeUrl(t.video_path) : null,
    cover_url: t.cover_path ? toServeUrl(t.cover_path) : null,
    cache_keyframe_hits: t.cache_keyframe_hits,
    cache_video_hit: !!t.cache_video_hit,
    cost_estimate: t.cost_estimate,
    cost_saved: t.cost_saved,
    error_message: t.error_message,
    codex_app_thread_id: t.codex_app_thread_id,
    codex_exec_thread_id: t.codex_exec_thread_id,
    codex_exec_model: t.codex_exec_model,
    created_at: t.created_at,
    updated_at: t.updated_at,
    reference_image_url: referenceImageUrls(t.reference_image_path)[0] ?? null,
    reference_image_urls: referenceImageUrls(t.reference_image_path)
  };
}

export function serializeKeyframe(k: KeyframeRow) {
  return {
    id: k.id,
    task_id: k.task_id,
    frame_index: k.frame_index,
    prompt: k.prompt,
    seed: k.seed,
    image_url: k.image_path ? toServeUrl(k.image_path) : null,
    thumbnail_url: k.thumbnail_path ? toServeUrl(k.thumbnail_path) : null,
    cache_key: k.cache_key,
    cache_hit: !!k.cache_hit,
    locked: !!k.locked,
    status: k.status,
    error_message: k.error_message,
    duration_ms: k.duration_ms,
    created_at: k.created_at,
    updated_at: k.updated_at
  };
}

export function serializeChat(c: ChatLogRow) {
  let parsed: unknown = c.content;
  try {
    parsed = JSON.parse(c.content);
  } catch {
    parsed = c.content;
  }
  return {
    id: c.id,
    role: c.role,
    kind: c.kind,
    content: parsed,
    created_at: c.created_at
  };
}

export function fullTask(taskId: string, t: VideoTaskRow) {
  return {
    task: serializeTask(t),
    keyframes: listKeyframes(taskId).map(serializeKeyframe),
    chat: listChatLogs(taskId).map(serializeChat),
    dimensions: RATIO_DIMENSIONS[t.aspect_ratio]
  };
}

export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}
