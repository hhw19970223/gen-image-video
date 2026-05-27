// 任务编排器 —— 串起 Codex 视频规划 + ComfyUI GGUF 视频生成 + 封面提取 + 缓存
//
// 入口: runTaskPipeline(taskId)
//   - 状态机: pending -> planning -> generating_motion -> composing_video -> completed
//   - 任意阶段失败 -> failed
//
// MVP: 在 Next.js 进程内异步执行,不依赖 Redis/Celery

import fs from 'node:fs';
import path from 'node:path';
import { planFrames, translatePlanForGeneration } from './adapters/codex';
import { generateVideo } from './adapters/comfyui-gguf';
import { extractCover } from './adapters/ffmpeg';
import { videoCacheKey } from './cache-key';
import { bus } from './events';
import { taskDir, cacheFile } from './paths';
import { parseReferenceImagePaths } from './reference-images';
import { logError, logInfo, logWarn, stepTimer } from './logger';
import {
  appendChatLog,
  cancelTask,
  getCacheByKey,
  getTask,
  insertCache,
  recordCacheHit,
  setTaskStatus,
  updateTask
} from './repo';
import type { ConfirmedFramePlan, CreateTaskInput, VideoTaskRow } from './types';

// 同一时间只跑一个 task,避免本地视频模型抢占显存/内存
let _running: Promise<void> = Promise.resolve();
const _queue: Set<string> = new Set();

export function enqueueTask(taskId: string): void {
  if (_queue.has(taskId)) return;
  _queue.add(taskId);
  logInfo('orchestrator', 'enqueueTask', { taskId, queueSize: _queue.size });
  _running = _running.then(() =>
    runTaskPipeline(taskId).finally(() => _queue.delete(taskId))
  );
}

async function runTaskPipeline(taskId: string): Promise<void> {
  const timer = stepTimer('orchestrator', 'runTaskPipeline', { taskId });
  const task = getTask(taskId);
  if (!task) {
    timer.done({ skipped: true, reason: 'task not found' });
    return;
  }
  try {
    await pipeline(task);
    timer.done({ status: getTask(taskId)?.status });
  } catch (e) {
    if (getTask(taskId)?.status === 'cancelled') {
      timer.done({ status: 'cancelled' });
      bus.emitTask(taskId, { type: 'status', payload: { status: 'cancelled', progress: 100 } });
      return;
    }
    const msg = (e as Error).message || String(e);
    timer.fail(e, { taskId });
    setTaskStatus(taskId, 'failed', msg, 100);
    appendChatLog({ task_id: taskId, role: 'system', kind: 'error', content: msg });
    bus.emitTask(taskId, { type: 'failed', payload: { message: msg } });
  }
}

async function pipeline(task: VideoTaskRow): Promise<void> {
  const taskId = task.id;
  logInfo('orchestrator', 'pipeline.start', {
    taskId,
    prompt: task.prompt,
    duration: task.duration,
    fps: task.fps,
    motion: task.motion_type,
    style: task.style,
    width: task.width,
    height: task.height
  });
  const referencePaths = parseReferenceImagePaths(task.reference_image_path);
  logInfo('orchestrator', 'pipeline.references', { taskId, referenceCount: referencePaths.length, referencePaths });
  throwIfCancelled(taskId);
  emit(taskId, 'status', { status: 'planning', message: '规划整段视频中…', progress: 4 });
  setTaskStatus(taskId, 'planning', '规划整段视频中…', 4);

  // 1. 使用用户确认过的规划；没有确认规划时才现场调用 Codex/fallback。
  const planTimer = stepTimer('orchestrator', 'pipeline.plan', { taskId, confirmed: Boolean(task.confirmed_plan_json) });
  const plan = readConfirmedPlan(task) ?? await planFrames(
    taskCreateInput(task, referencePaths),
    task.frame_count,
    task.motion_type
  );
  planTimer.done({
    taskId,
    source: plan.source,
    codexThreadId: plan.codexThreadId,
    model: plan.model
  });
  throwIfCancelled(taskId);

  if (plan.codexThreadId || plan.model) {
    updateTask(taskId, {
      codex_exec_thread_id: plan.codexThreadId ?? task.codex_exec_thread_id,
      codex_exec_model: plan.model ?? task.codex_exec_model
    });
  }

  appendChatLog({
    task_id: taskId,
    role: 'orchestrator',
    kind: 'plan',
    content: JSON.stringify({
      source: plan.source,
      overallPlan: plan.overallPlan,
      animationDescription: plan.animationDescription,
      smoothAnimation: plan.smoothAnimation,
      agentSkills: plan.agentSkills,
      notes: plan.notes,
      codexThreadId: plan.codexThreadId ?? null,
      model: plan.model ?? null
    })
  });
  emit(taskId, 'log', {
    kind: 'plan',
    source: plan.source,
    notes: plan.notes,
    overallPlan: plan.overallPlan,
    animationDescription: plan.animationDescription,
    smoothAnimation: plan.smoothAnimation,
    agentSkills: plan.agentSkills
  });

  emit(taskId, 'status', { status: 'planning', message: '生成视频模型提示词中…', progress: 6 });
  setTaskStatus(taskId, 'planning', '生成视频模型提示词中…', 6);
  const translateTimer = stepTimer('orchestrator', 'pipeline.translateVideoPrompt', { taskId });
  const generationPrompts = await translatePlanForGeneration({
    userPrompt: task.prompt,
    negativePrompt: plan.negativePrompt,
    overallPlan: plan.overallPlan,
    animationDescription: plan.animationDescription,
    smoothAnimation: plan.smoothAnimation,
    duration: task.duration,
    fps: task.fps,
    motion: task.motion_type,
    style: task.style
  });
  translateTimer.done({
    taskId,
    source: generationPrompts.source,
    videoPromptLength: generationPrompts.videoPrompt.length,
    negativePromptLength: generationPrompts.negativePrompt.length
  });
  throwIfCancelled(taskId);
  updateTask(taskId, {
    generation_prompt: generationPrompts.videoPrompt,
    generation_negative_prompt: generationPrompts.negativePrompt,
    codex_exec_thread_id: generationPrompts.codexThreadId ?? plan.codexThreadId ?? task.codex_exec_thread_id,
    codex_exec_model: generationPrompts.model ?? plan.model ?? task.codex_exec_model
  });
  appendChatLog({
    task_id: taskId,
    role: 'orchestrator',
    kind: 'note',
    content: JSON.stringify({
      action: 'internal_prompt_translation',
      source: generationPrompts.source,
      message: '已生成英文内部提示词,界面继续展示中文原文'
    })
  });

  // 2. 通过 ComfyUI GGUF 工作流生成视频
  await generateVideoForTask(taskId, generationPrompts.videoPrompt, generationPrompts.negativePrompt, referencePaths);
}

function taskCreateInput(task: VideoTaskRow, referencePaths: string[]): CreateTaskInput {
  return {
    prompt: task.prompt,
    reference_image_path: referencePaths[0],
    reference_image_paths: referencePaths,
    style: (task.style ?? undefined) as CreateTaskInput['style'],
    aspect_ratio: task.aspect_ratio,
    duration: task.duration,
    fps: task.fps,
    frame_count: task.frame_count,
    motion_type: task.motion_type,
    seed: task.seed ?? undefined
  };
}

function readConfirmedPlan(task: VideoTaskRow): (ConfirmedFramePlan & { source: 'codex' | 'fallback' }) | null {
  if (!task.confirmed_plan_json) return null;
  try {
    const parsed = JSON.parse(task.confirmed_plan_json) as ConfirmedFramePlan;
    return {
      ...parsed,
      source: parsed.source ?? 'codex'
    };
  } catch {
    return null;
  }
}

export async function cancelTaskPipeline(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  cancelTask(taskId);
  appendChatLog({
    task_id: taskId,
    role: 'system',
    kind: 'note',
    content: JSON.stringify({ action: 'cancel', message: '任务已取消' })
  });
  bus.emitTask(taskId, {
    type: 'status',
    payload: { status: 'cancelled', message: '已取消', progress: 100 }
  });
}

export function resumeTaskPipeline(taskId: string): void {
  _running = _running.then(async () => {
    try {
      await resumeExistingTask(taskId);
    } catch (e) {
      if (getTask(taskId)?.status === 'cancelled') return;
      const msg = (e as Error).message || String(e);
      setTaskStatus(taskId, 'failed', msg, 100);
      appendChatLog({ task_id: taskId, role: 'system', kind: 'error', content: msg });
      bus.emitTask(taskId, { type: 'failed', payload: { message: msg } });
    }
  });
}

async function resumeExistingTask(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  throwIfCancelled(taskId);

  await generateVideoForTask(
    taskId,
    task.generation_prompt ?? task.prompt,
    task.generation_negative_prompt ?? process.env.WAN_NEGATIVE ?? 'lowres, blurry, watermark, text, deformed',
    parseReferenceImagePaths(task.reference_image_path)
  );
}

/** 合成阶段 */
async function generateVideoForTask(
  taskId: string,
  videoPrompt: string,
  negativePrompt: string,
  referencePaths: string[]
): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  throwIfCancelled(taskId);

  const videoPath = path.join(taskDir(taskId), 'video.mp4');
  const coverPath = path.join(taskDir(taskId), 'cover.jpg');
  const videoKey = videoCacheKey(task, [], videoPrompt);
  const videoTimer = stepTimer('orchestrator', 'generateVideoForTask', {
    taskId,
    videoPath,
    coverPath,
    videoKey,
    referenceCount: referencePaths.length,
    promptLength: videoPrompt.length,
    negativePromptLength: negativePrompt.length
  });
  logInfo('orchestrator', 'generateVideoForTask.paths', {
    taskId,
    videoPath,
    coverPath,
    videoKey,
    taskDir: taskDir(taskId)
  });

  setTaskStatus(taskId, 'generating_motion', 'ComfyUI GGUF 生成视频中…', 10);
  emit(taskId, 'status', { status: 'generating_motion', message: 'ComfyUI GGUF 生成视频中…', progress: 10 });

  const cached = getCacheByKey(videoKey);
  let durationMs = 0;
  let cacheHit = false;
  if (cached && fs.existsSync(cached.file_path)) {
    logInfo('orchestrator', 'generateVideoForTask.cacheHit', {
      taskId,
      videoKey,
      cachedPath: cached.file_path,
      videoPath
    });
    fs.copyFileSync(cached.file_path, videoPath);
    recordCacheHit(videoKey);
    cacheHit = true;
  } else {
    logInfo('orchestrator', 'generateVideoForTask.cacheMiss', {
      taskId,
      videoKey,
      cachedPath: cached?.file_path ?? null,
      cachedPathExists: cached?.file_path ? fs.existsSync(cached.file_path) : false
    });
    const startedAt = Date.now();
    const wanFrameCount = resolveVideoFrameCount(task);
    const wanReferencePath = referencePaths.find(p => fs.existsSync(p));
    const wanTimer = stepTimer('orchestrator', 'generateVideoForTask.wanGenerate', {
      taskId,
      videoPath,
      frameCount: wanFrameCount,
      referenceImagePath: wanReferencePath ?? null
    });
    let result: Awaited<ReturnType<typeof generateVideo>>;
    try {
      result = await generateVideo({
      prompt: buildVideoPrompt(task, videoPrompt),
      negativePrompt: negativePrompt || task.generation_negative_prompt || process.env.WAN_NEGATIVE || 'lowres, blurry, watermark, text, deformed',
      seed: task.seed ?? 0,
      width: task.width,
      height: task.height,
      duration: task.duration,
      fps: task.fps,
      frameCount: wanFrameCount,
      outPath: videoPath,
      referenceImagePath: wanReferencePath,
      onProgress: progress => {
        const pct = progress.step && progress.maxSteps
          ? 37 + Math.floor((progress.step / Math.max(1, progress.maxSteps)) * 35)
          : 10 + Math.floor((progress.value / Math.max(1, progress.max)) * 55);
        const message = progress.step && progress.maxSteps
          ? `ComfyUI GGUF 生成视频中 第 ${progress.step}/${progress.maxSteps} 步`
          : `ComfyUI GGUF 生成视频中 ${progress.value}/${progress.max}`;
        logInfo('orchestrator', 'generateVideoForTask.wanProgress', {
          taskId,
          value: progress.value,
          max: progress.max,
          pct,
          elapsedMs: progress.elapsedMs,
          node: progress.node,
          promptId: progress.promptId,
          step: progress.step,
          maxSteps: progress.maxSteps
        });
        setTaskStatus(taskId, 'generating_motion', message, pct);
        emit(taskId, 'status', {
          status: 'generating_motion',
          message,
          progress: pct,
          elapsedMs: progress.elapsedMs,
          node: progress.node,
          promptId: progress.promptId,
          step: progress.step,
          maxSteps: progress.maxSteps
        });
      }
    });
    } catch (error) {
      wanTimer.fail(error, { taskId, videoPath });
      videoTimer.fail(error, { taskId, stage: 'wanGenerate' });
      throw error;
    }
    wanTimer.done({ taskId, backend: result.backend, durationMs: result.durationMs, outPath: result.outPath });
    durationMs = result.durationMs || (Date.now() - startedAt);
    const cacheDst = cacheFile(videoKey, 'mp4');
    fs.copyFileSync(videoPath, cacheDst);
    insertCache({
      cache_key: videoKey,
      cache_type: 'video',
      file_path: cacheDst,
      meta: { mode: 'video', backend: result.backend, duration: task.duration, fps: task.fps, generation_prompt: videoPrompt }
    });
    logInfo('orchestrator', 'generateVideoForTask.cacheInsert', {
      taskId,
      videoKey,
      cacheDst,
      durationMs,
      backend: result.backend
    });
  }
  throwIfCancelled(taskId);

  setTaskStatus(taskId, 'composing_video', '提取视频封面中…', 82);
  emit(taskId, 'status', { status: 'composing_video', message: '提取视频封面中…', progress: 82 });

  try {
    await extractCover(videoPath, coverPath);
    logInfo('orchestrator', 'generateVideoForTask.coverDone', {
      taskId,
      videoPath,
      coverPath,
      exists: fs.existsSync(coverPath)
    });
  } catch (error) {
    logWarn('orchestrator', 'generateVideoForTask.coverFailed', {
      taskId,
      videoPath,
      coverPath,
      reason: (error as Error).message
    });
    /* ignore */
  }

  appendChatLog({
    task_id: taskId,
    role: 'orchestrator',
    kind: 'compose',
    content: JSON.stringify({
      mode: 'comfyui_gguf',
      model: process.env.COMFYUI_WAN_MODEL || 'wan2.1_t2v_1.3b-q2_k.gguf',
      cache_hit: cacheHit,
      video_key: videoKey,
      duration_ms: durationMs
    })
  });

  updateTask(taskId, {
    video_path: videoPath,
    cover_path: fs.existsSync(coverPath) ? coverPath : null,
    cache_video_hit: cacheHit ? 1 : 0,
    cache_keyframe_hits: 0,
    progress: 100,
    status: 'completed',
    stage_message: cacheHit ? '已完成(命中视频缓存)' : '已完成'
  });
  emit(taskId, 'completed', { videoPath, cache_hit: cacheHit, duration_ms: durationMs });
  videoTimer.done({
    taskId,
    videoPath,
    coverPath: fs.existsSync(coverPath) ? coverPath : null,
    cacheHit,
    durationMs
  });
}

function buildVideoPrompt(task: VideoTaskRow, videoPrompt: string): string {
  return [
    videoPrompt,
    `Original user request: ${task.prompt}`,
    `Duration ${task.duration} seconds, ${task.fps} fps, ${task.aspect_ratio}, ${task.motion_type} camera motion.`,
    'Generate one continuous coherent video clip, not separate still images. Keep the same subject identity, scene, lighting direction, color palette, scale relationships, and camera continuity throughout.',
  ].filter(Boolean).join(' ');
}

function emit(taskId: string, type: 'status' | 'progress' | 'frame' | 'log' | 'completed' | 'failed', payload: unknown): void {
  bus.emitTask(taskId, { type, payload });
}

function throwIfCancelled(taskId: string): void {
  if (getTask(taskId)?.status === 'cancelled') {
    throw new Error('task cancelled');
  }
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveVideoFrameCount(task: VideoTaskRow): number {
  const configured = readInt(process.env.WAN_VIDEO_FRAMES, 0);
  if (configured > 0) return Math.max(41, configured);
  return Math.max(41, Math.min(121, Math.round(task.duration * task.fps)));
}
