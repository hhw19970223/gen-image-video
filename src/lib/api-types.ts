// 共享给 client / server 的 API 响应类型 —— 不引用任何 server-only 模块

import type { AspectRatio, MotionType, Style, TaskStatus, FrameStatus } from './types';

export interface SerializedTask {
  id: string;
  prompt: string;
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
  progress: number;
  stage_message: string | null;
  video_url: string | null;
  cover_url: string | null;
  cache_keyframe_hits: number;
  cache_video_hit: boolean;
  cost_estimate: number;
  cost_saved: number;
  error_message: string | null;
  codex_app_thread_id: string | null;
  codex_exec_thread_id: string | null;
  codex_exec_model: string | null;
  created_at: string;
  updated_at: string;
  reference_image_url: string | null;
  reference_image_urls: string[];
}

export interface SerializedKeyframe {
  id: string;
  task_id: string;
  frame_index: number;
  prompt: string;
  seed: number;
  image_url: string | null;
  thumbnail_url: string | null;
  cache_key: string;
  cache_hit: boolean;
  locked: boolean;
  status: FrameStatus;
  error_message: string | null;
  duration_ms: number;
  created_at: string;
  updated_at: string;
}

export interface SerializedChat {
  id: string;
  role: 'user' | 'system' | 'orchestrator';
  kind: string;
  content: unknown;
  created_at: string;
}

export interface FullTaskPayload {
  task: SerializedTask;
  keyframes: SerializedKeyframe[];
  chat: SerializedChat[];
  dimensions: { width: number; height: number };
}

export interface HomeStats {
  monthCount: number;
  cacheHitRate: number;
  avgCost: number;
  weekCount: number;
  weekSaved: number;
  quotaUsed: number;
  quotaTotal: number;
  cacheKeyframes: number;
}
