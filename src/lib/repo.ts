// 数据访问层 — 封装常用查询,避免在路由里直接拼 SQL

import { nanoid } from 'nanoid';
import { db, touchTask } from './db';
import { encodeReferenceImagePaths } from './reference-images';
import type {
  CacheRow,
  CacheType,
  ChatLogRow,
  CodexMessageRow,
  CodexSessionRow,
  CreateTaskInput,
  KeyframeRow,
  TaskStatus,
  VideoTaskRow
} from './types';
import {
  COST_PER_KEYFRAME,
  DEFAULT_FPS,
  DEFAULT_FRAME_COUNT,
  DEFAULT_MOTION,
  RATIO_DIMENSIONS
} from './types';

// ===== Tasks =====

export function insertTask(input: CreateTaskInput): VideoTaskRow {
  const dims = RATIO_DIMENSIONS[input.aspect_ratio];
  const id = `tsk_${nanoid(10)}`;
  const fps = input.fps ?? DEFAULT_FPS;
  const frame_count = input.frame_count ?? DEFAULT_FRAME_COUNT;
  const motion_type = input.motion_type ?? DEFAULT_MOTION;
  const seed = input.seed ?? Math.floor(Math.random() * 1_000_000);
  const cost_estimate = +(frame_count * COST_PER_KEYFRAME).toFixed(2);
  const codex_app_thread_id = process.env.CODEX_THREAD_ID?.trim() || null;
  const reference_image_path = encodeReferenceImagePaths(
    input.reference_image_paths?.length ? input.reference_image_paths : input.reference_image_path ? [input.reference_image_path] : []
  );
  const confirmed_plan_json = input.confirmed_plan ? JSON.stringify(input.confirmed_plan) : null;

  db()
    .prepare(
      `INSERT INTO video_tasks
        (id, prompt, generation_prompt, generation_negative_prompt, reference_image_path, style, aspect_ratio, width, height,
         duration, fps, frame_count, motion_type, seed, status, progress,
         cost_estimate, codex_app_thread_id, confirmed_plan_json)
       VALUES
        (@id, @prompt, @generation_prompt, @generation_negative_prompt, @reference_image_path, @style, @aspect_ratio, @width, @height,
         @duration, @fps, @frame_count, @motion_type, @seed, 'pending', 0,
         @cost_estimate, @codex_app_thread_id, @confirmed_plan_json)`
    )
    .run({
      id,
      prompt: input.prompt,
      generation_prompt: null,
      generation_negative_prompt: null,
      reference_image_path,
      style: input.style ?? null,
      aspect_ratio: input.aspect_ratio,
      width: dims.width,
      height: dims.height,
      duration: input.duration,
      fps,
      frame_count,
      motion_type,
      seed,
      cost_estimate,
      codex_app_thread_id,
      confirmed_plan_json
    });

  return getTask(id)!;
}

export function getTask(id: string): VideoTaskRow | undefined {
  return db()
    .prepare(`SELECT * FROM video_tasks WHERE id = ?`)
    .get(id) as VideoTaskRow | undefined;
}

export function listTasks(opts: { status?: TaskStatus; limit?: number } = {}): VideoTaskRow[] {
  const limit = opts.limit ?? 50;
  if (opts.status) {
    return db()
      .prepare(`SELECT * FROM video_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(opts.status, limit) as VideoTaskRow[];
  }
  return db()
    .prepare(`SELECT * FROM video_tasks ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as VideoTaskRow[];
}

export function listTasksByCodexAppThread(threadId: string, limit = 50): VideoTaskRow[] {
  return db()
    .prepare(
      `SELECT * FROM video_tasks
       WHERE codex_app_thread_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(threadId, limit) as VideoTaskRow[];
}

export function updateTask(id: string, patch: Partial<VideoTaskRow>): void {
  const keys = Object.keys(patch).filter(k => k !== 'id' && k !== 'created_at');
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  db()
    .prepare(`UPDATE video_tasks SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id });
}

export function setTaskStatus(
  id: string,
  status: TaskStatus,
  message?: string,
  progress?: number
): void {
  const sets: string[] = [`status = @status`, `updated_at = datetime('now')`];
  const params: Record<string, unknown> = { id, status };
  if (message !== undefined) {
    sets.push(`stage_message = @stage_message`);
    params.stage_message = message;
  }
  if (progress !== undefined) {
    sets.push(`progress = @progress`);
    params.progress = progress;
  }
  if (status === 'failed' && message) {
    sets.push(`error_message = @error_message`);
    params.error_message = message;
  }
  db()
    .prepare(`UPDATE video_tasks SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);
}

export function deleteTask(id: string): void {
  db().prepare(`DELETE FROM video_tasks WHERE id = ?`).run(id);
}

export function resetTaskForRetry(id: string): void {
  const d = db();
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM keyframes WHERE task_id = ?`).run(id);
    d.prepare(
      `UPDATE video_tasks
       SET status = 'pending',
           progress = 0,
           stage_message = @stage_message,
           video_path = NULL,
           cover_path = NULL,
           cache_keyframe_hits = 0,
           cache_motion_hits = 0,
           cache_video_hit = 0,
           cost_saved = 0,
           error_message = NULL,
           updated_at = datetime('now')
       WHERE id = @id`
    ).run({ id, stage_message: '排队中…' });
  });
  tx();
}

export function cancelTask(id: string, message = '已取消'): void {
  const d = db();
  const tx = d.transaction(() => {
    d.prepare(
      `UPDATE video_tasks
       SET status = 'cancelled',
           progress = 100,
           stage_message = @message,
           error_message = NULL,
           updated_at = datetime('now')
       WHERE id = @id`
    ).run({ id, message });
    d.prepare(
      `UPDATE keyframes
       SET status = 'failed',
           error_message = @message,
           updated_at = datetime('now')
       WHERE task_id = @id
         AND status IN ('pending', 'generating')`
    ).run({ id, message });
  });
  tx();
}

// ===== Keyframes =====

export function insertKeyframe(row: Omit<KeyframeRow, 'id' | 'created_at' | 'updated_at'>): KeyframeRow {
  const id = `kf_${nanoid(10)}`;
  db()
    .prepare(
      `INSERT INTO keyframes
        (id, task_id, frame_index, prompt, generation_prompt, seed, image_path, thumbnail_path,
         cache_key, cache_hit, locked, status, error_message, duration_ms)
       VALUES
        (@id, @task_id, @frame_index, @prompt, @generation_prompt, @seed, @image_path, @thumbnail_path,
         @cache_key, @cache_hit, @locked, @status, @error_message, @duration_ms)`
    )
    .run({ id, ...row });
  return db().prepare(`SELECT * FROM keyframes WHERE id = ?`).get(id) as KeyframeRow;
}

export function getKeyframe(id: string): KeyframeRow | undefined {
  return db().prepare(`SELECT * FROM keyframes WHERE id = ?`).get(id) as KeyframeRow | undefined;
}

export function listKeyframes(taskId: string): KeyframeRow[] {
  return db()
    .prepare(`SELECT * FROM keyframes WHERE task_id = ? ORDER BY frame_index ASC`)
    .all(taskId) as KeyframeRow[];
}

export function updateKeyframe(id: string, patch: Partial<KeyframeRow>): void {
  const keys = Object.keys(patch).filter(k => k !== 'id' && k !== 'created_at');
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  db()
    .prepare(`UPDATE keyframes SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id });
  // also bump task updated_at
  const kf = getKeyframe(id);
  if (kf) touchTask(kf.task_id);
}

// ===== Cache =====

export function getCacheByKey(cacheKey: string): CacheRow | undefined {
  return db()
    .prepare(`SELECT * FROM cache_records WHERE cache_key = ?`)
    .get(cacheKey) as CacheRow | undefined;
}

export function recordCacheHit(cacheKey: string): void {
  db()
    .prepare(
      `UPDATE cache_records SET hit_count = hit_count + 1, last_hit_at = datetime('now')
       WHERE cache_key = ?`
    )
    .run(cacheKey);
}

export function insertCache(input: {
  cache_key: string;
  cache_type: CacheType;
  file_path: string;
  meta?: object;
}): CacheRow {
  const id = `cch_${nanoid(10)}`;
  db()
    .prepare(
      `INSERT OR REPLACE INTO cache_records
         (id, cache_key, cache_type, file_path, meta, hit_count, created_at, last_hit_at)
       VALUES (@id, @cache_key, @cache_type, @file_path, @meta, 0,
               datetime('now'), datetime('now'))`
    )
    .run({
      id,
      cache_key: input.cache_key,
      cache_type: input.cache_type,
      file_path: input.file_path,
      meta: input.meta ? JSON.stringify(input.meta) : null
    });
  return getCacheByKey(input.cache_key)!;
}

export function cacheStats(): { keyframes: number; videos: number; total_hits: number } {
  const keyframes = (db()
    .prepare(`SELECT COUNT(*) AS n FROM cache_records WHERE cache_type = 'keyframe'`)
    .get() as { n: number }).n;
  const videos = (db()
    .prepare(`SELECT COUNT(*) AS n FROM cache_records WHERE cache_type = 'video'`)
    .get() as { n: number }).n;
  const total_hits = (db()
    .prepare(`SELECT COALESCE(SUM(hit_count), 0) AS s FROM cache_records`)
    .get() as { s: number }).s;
  return { keyframes, videos, total_hits };
}

// ===== Chat logs =====

export function appendChatLog(row: Omit<ChatLogRow, 'id' | 'created_at'>): ChatLogRow {
  const id = `cl_${nanoid(10)}`;
  db()
    .prepare(
      `INSERT INTO chat_logs (id, task_id, role, kind, content)
       VALUES (@id, @task_id, @role, @kind, @content)`
    )
    .run({ id, ...row });
  return db().prepare(`SELECT * FROM chat_logs WHERE id = ?`).get(id) as ChatLogRow;
}

export function listChatLogs(taskId: string): ChatLogRow[] {
  return db()
    .prepare(`SELECT * FROM chat_logs WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as ChatLogRow[];
}

// ===== Codex sessions =====

export function getActiveCodexSession(): CodexSessionRow {
  const existing = db()
    .prepare(`SELECT * FROM codex_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`)
    .get() as CodexSessionRow | undefined;
  if (existing) return existing;
  return createCodexSession('默认 Codex 会话');
}

export function createCodexSession(title: string): CodexSessionRow {
  const id = `cdx_${nanoid(10)}`;
  db()
    .prepare(
      `INSERT INTO codex_sessions (id, title, status)
       VALUES (@id, @title, 'active')`
    )
    .run({ id, title: title.trim() || 'Codex 会话' });
  return getCodexSession(id)!;
}

export function getCodexSession(id: string): CodexSessionRow | undefined {
  return db()
    .prepare(`SELECT * FROM codex_sessions WHERE id = ?`)
    .get(id) as CodexSessionRow | undefined;
}

export function listCodexSessions(limit = 50): CodexSessionRow[] {
  return db()
    .prepare(`SELECT * FROM codex_sessions ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as CodexSessionRow[];
}

export function updateCodexSession(id: string, patch: Partial<Pick<CodexSessionRow, 'title' | 'codex_thread_id' | 'status'>>): void {
  const keys = Object.keys(patch).filter(k => patch[k as keyof typeof patch] !== undefined);
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  db()
    .prepare(`UPDATE codex_sessions SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id });
}

export function activateCodexSession(id: string): CodexSessionRow | undefined {
  db()
    .prepare(`UPDATE codex_sessions SET updated_at = datetime('now') WHERE id = ?`)
    .run(id);
  return getCodexSession(id);
}

export function appendCodexMessage(row: Omit<CodexMessageRow, 'id' | 'created_at'>): CodexMessageRow {
  const id = `cdm_${nanoid(10)}`;
  db()
    .prepare(
      `INSERT INTO codex_messages
         (id, session_id, task_id, role, kind, content, codex_thread_id)
       VALUES
         (@id, @session_id, @task_id, @role, @kind, @content, @codex_thread_id)`
    )
    .run({ id, ...row });
  updateCodexSession(row.session_id, { codex_thread_id: row.codex_thread_id ?? undefined });
  return db().prepare(`SELECT * FROM codex_messages WHERE id = ?`).get(id) as CodexMessageRow;
}

export function listCodexMessages(sessionId: string, limit = 200): CodexMessageRow[] {
  return db()
    .prepare(
      `SELECT * FROM codex_messages
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(sessionId, limit) as CodexMessageRow[];
}

export function deleteCodexSession(id: string): void {
  db().prepare(`DELETE FROM codex_sessions WHERE id = ?`).run(id);
}

export function renameCodexSession(id: string, title: string): CodexSessionRow | undefined {
  const trimmed = title.trim();
  if (!trimmed) return getCodexSession(id);
  updateCodexSession(id, { title: trimmed });
  return getCodexSession(id);
}

// ===== Aggregates =====

export function homeStats(): {
  monthCount: number;
  cacheHitRate: number; // 0..1
  avgCost: number;
  weekCount: number;
  weekSaved: number;
  quotaUsed: number;
  quotaTotal: number;
  cacheKeyframes: number;
} {
  const month = (db()
    .prepare(
      `SELECT COUNT(*) AS n FROM video_tasks
       WHERE created_at >= date('now', 'start of month')`
    )
    .get() as { n: number }).n;
  const week = db()
    .prepare(
      `SELECT
         COUNT(*) AS n,
         COALESCE(SUM(cost_saved), 0) AS s
       FROM video_tasks
       WHERE created_at >= datetime('now', '-7 days')`
    )
    .get() as { n: number; s: number };
  const totalKeyframes = (db()
    .prepare(`SELECT COUNT(*) AS n FROM keyframes`)
    .get() as { n: number }).n;
  const hitKeyframes = (db()
    .prepare(`SELECT COUNT(*) AS n FROM keyframes WHERE cache_hit = 1`)
    .get() as { n: number }).n;
  const avgCost = (db()
    .prepare(
      `SELECT COALESCE(AVG(cost_estimate - cost_saved), 0) AS a
         FROM video_tasks WHERE status = 'completed'`
    )
    .get() as { a: number }).a;
  const stats = cacheStats();
  return {
    monthCount: month,
    cacheHitRate: totalKeyframes === 0 ? 0 : hitKeyframes / totalKeyframes,
    avgCost: +avgCost.toFixed(2),
    weekCount: week.n,
    weekSaved: +week.s.toFixed(2),
    quotaUsed: month,
    quotaTotal: 500,
    cacheKeyframes: stats.keyframes
  };
}
