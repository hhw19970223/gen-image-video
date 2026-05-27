// 缓存 key 哈希计算 — 与 PRD 7.6 对齐

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { KeyframeRow, VideoTaskRow } from './types';

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashFile(path: string): string {
  const buf = fs.readFileSync(path);
  return sha256Hex(buf).slice(0, 16);
}

/** 关键帧缓存 key — 受帧文本、风格、seed、尺寸、参考图、模型影响 */
export function keyframeCacheKey(opts: {
  prompt: string;
  framePrompt: string;
  frameIndex: number;
  seed: number;
  width: number;
  height: number;
  style: string | null;
  reference_image_hash?: string | null;
  model?: string | null;
}): string {
  const payload = JSON.stringify({
    p: opts.prompt.trim(),
    fp: opts.framePrompt.trim(),
    fi: opts.frameIndex,
    s: opts.seed,
    w: opts.width,
    h: opts.height,
    st: opts.style ?? '',
    ri: opts.reference_image_hash ?? '',
    m: opts.model ?? 'wan-direct'
  });
  return sha256Hex(payload).slice(0, 32);
}

/** 视频缓存 key — 受任务核心参数 + 所有关键帧的 image hash 影响 */
export function videoCacheKey(task: VideoTaskRow, keyframes: KeyframeRow[], generationPrompt?: string): string {
  const frameHashes = keyframes
    .sort((a, b) => a.frame_index - b.frame_index)
    .map(k => (k.image_path && fs.existsSync(k.image_path) ? hashFile(k.image_path) : k.cache_key));
  const payload = JSON.stringify({
    v: 'ffmpeg-static-xfade-english-v4',
    p: (generationPrompt ?? task.generation_prompt ?? task.prompt).trim(),
    display_p: task.prompt.trim(),
    s: task.style ?? '',
    ar: task.aspect_ratio,
    d: task.duration,
    f: task.fps,
    mt: task.motion_type,
    sd: task.seed,
    fh: frameHashes
  });
  return sha256Hex(payload).slice(0, 32);
}

/** 中间帧 cache key — 受相邻两关键帧 + motion type + 帧数影响 */
export function motionCacheKey(opts: {
  fromHash: string;
  toHash: string;
  motion: string;
  frames: number;
  width: number;
  height: number;
}): string {
  return sha256Hex(JSON.stringify(opts)).slice(0, 32);
}
