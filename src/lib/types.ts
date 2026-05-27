// Frame · 数据模型 / 公共类型

export type AspectRatio = '9:16' | '16:9' | '1:1';
export type Style =
  | 'realistic'
  | 'cartoon'
  | 'product_photography'
  | 'cyberpunk'
  | 'cinematic'
  | 'anime';
export type MotionType =
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'fade'
  | 'crossfade';
export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'generating_keyframes'
  | 'generating_motion'
  | 'composing_video'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type FrameStatus =
  | 'pending'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'locked';
export type CacheType = 'keyframe' | 'motion_frame' | 'video' | 'prompt';

export interface VideoTaskRow {
  id: string;
  prompt: string;
  generation_prompt: string | null;
  generation_negative_prompt: string | null;
  reference_image_path: string | null;
  style: Style | null;
  aspect_ratio: AspectRatio;
  width: number;
  height: number;
  duration: number;
  fps: number;
  frame_count: number;
  motion_type: MotionType;
  seed: number | null;
  status: TaskStatus;
  progress: number; // 0-100
  stage_message: string | null;
  video_path: string | null;
  cover_path: string | null;
  cache_keyframe_hits: number;
  cache_motion_hits: number;
  cache_video_hit: number; // 0|1
  cost_estimate: number; // ¥
  cost_saved: number; // ¥
  error_message: string | null;
  codex_app_thread_id: string | null;
  codex_exec_thread_id: string | null;
  codex_exec_model: string | null;
  confirmed_plan_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface KeyframeRow {
  id: string;
  task_id: string;
  frame_index: number;
  prompt: string;
  generation_prompt: string | null;
  seed: number;
  image_path: string | null;
  thumbnail_path: string | null;
  cache_key: string;
  cache_hit: number; // 0|1
  locked: number; // 0|1
  status: FrameStatus;
  error_message: string | null;
  duration_ms: number; // generation duration
  created_at: string;
  updated_at: string;
}

export interface CacheRow {
  id: string;
  cache_key: string;
  cache_type: CacheType;
  file_path: string;
  meta: string | null; // JSON
  hit_count: number;
  created_at: string;
  last_hit_at: string;
}

export interface ChatLogRow {
  id: string;
  task_id: string;
  role: 'user' | 'system' | 'orchestrator';
  kind: 'prompt' | 'plan' | 'frame_generation' | 'motion' | 'compose' | 'error' | 'note';
  content: string; // text or JSON string
  created_at: string;
}

export interface CodexSessionRow {
  id: string;
  title: string;
  codex_thread_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface CodexMessageRow {
  id: string;
  session_id: string;
  task_id: string | null;
  role: 'user' | 'assistant' | 'system';
  kind: 'plan' | 'translation' | 'chat' | 'error' | 'note';
  content: string;
  codex_thread_id: string | null;
  created_at: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
}

export interface CreateTaskInput {
  prompt: string;
  reference_image_path?: string;
  reference_image_paths?: string[];
  confirmed_plan?: ConfirmedFramePlan;
  style?: Style;
  aspect_ratio: AspectRatio;
  duration: number;
  fps?: number;
  frame_count?: number;
  motion_type?: MotionType;
  seed?: number;
}

export interface ConfirmedFramePlan {
  overallPlan: {
    concept: string;
    visualStyle: string;
    cameraLanguage: string;
    continuityRules: string;
    referenceUsage?: string;
  };
  animationDescription?: string;
  smoothAnimation?: {
    durationSeconds: number;
    summary: string;
    motionArc: string;
    timing: string;
    transitionLogic: string;
    continuityStrategy: string;
  };
  agentSkills: Array<{
    agent: string;
    skill: string;
    output: string;
  }>;
  storyboard?: Array<{
    frameIndex: number;
    timeSec: number;
    coreFrame: string;
    previousToCurrentChange: string;
    cameraState: string;
    subjectState: string;
    continuityAnchor: string;
    comfyPrompt: string;
  }>;
  frameStills?: Array<{
    frameIndex: number;
    timeSec: number;
    stillDescription: string;
    roleInAnimation: string;
    visualChange: string;
  }>;
  framePrompts?: string[];
  negativePrompt: string;
  notes: string;
  source?: 'codex' | 'fallback';
  codexThreadId?: string;
  model?: string;
}

export const RATIO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  '9:16': { width: 512, height: 768 },
  '16:9': { width: 768, height: 512 },
  '1:1': { width: 512, height: 512 }
};

export const DEFAULT_FPS = 24;
export const DEFAULT_FRAME_COUNT = 6;
export const DEFAULT_MOTION: MotionType = 'zoom_in';
export const COST_PER_KEYFRAME = 0.08; // ¥ — 估算单价
