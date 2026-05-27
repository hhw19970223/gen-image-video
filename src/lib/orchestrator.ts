// 任务编排器 —— 串起 Codex 规划 + ComfyUI/Mock 生图 + FFmpeg 合成 + 缓存
//
// 入口: runTaskPipeline(taskId)
//   - 状态机: pending -> planning -> generating_keyframes -> composing_video -> completed
//   - 任意阶段失败 -> failed
//   - 单帧重生成: regenerateKeyframe(taskId, frameId, opts)
//
// MVP: 在 Next.js 进程内异步执行,不依赖 Redis/Celery

import fs from 'node:fs';
import path from 'node:path';
import { planFrames, translatePlanForGeneration, translateTextForGeneration } from './adapters/codex';
import { generateVideo } from './adapters/comfy-video';
import { composeVideo, extractCover, extractFramesFromVideo } from './adapters/ffmpeg';
import { generateImage, makeThumbnail } from './adapters/image-gen';
import { hashFile, keyframeCacheKey, videoCacheKey } from './cache-key';
import { cancelComfyPrompts } from './comfyui';
import { bus } from './events';
import { taskDir, cacheFile } from './paths';
import { parseReferenceImagePaths } from './reference-images';
import {
  appendChatLog,
  cancelTask,
  getCacheByKey,
  getKeyframe,
  getTask,
  insertCache,
  insertKeyframe,
  listKeyframes,
  recordCacheHit,
  setTaskStatus,
  updateKeyframe,
  updateTask
} from './repo';
import type { ConfirmedFramePlan, CreateTaskInput, KeyframeRow, VideoTaskRow } from './types';
import { COST_PER_KEYFRAME } from './types';

// 同一时间只跑一个 task,避免本地 ComfyUI 排队冲突
let _running: Promise<void> = Promise.resolve();
const _queue: Set<string> = new Set();

export function enqueueTask(taskId: string): void {
  if (_queue.has(taskId)) return;
  _queue.add(taskId);
  _running = _running.then(() =>
    runTaskPipeline(taskId).finally(() => _queue.delete(taskId))
  );
}

async function runTaskPipeline(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  try {
    await pipeline(task);
  } catch (e) {
    if (getTask(taskId)?.status === 'cancelled') {
      bus.emitTask(taskId, { type: 'status', payload: { status: 'cancelled', progress: 100 } });
      return;
    }
    const msg = (e as Error).message || String(e);
    setTaskStatus(taskId, 'failed', msg, 100);
    appendChatLog({ task_id: taskId, role: 'system', kind: 'error', content: msg });
    bus.emitTask(taskId, { type: 'failed', payload: { message: msg } });
  }
}

async function pipeline(task: VideoTaskRow): Promise<void> {
  const taskId = task.id;
  const referencePaths = parseReferenceImagePaths(task.reference_image_path);
  throwIfCancelled(taskId);
  emit(taskId, 'status', { status: 'planning', message: '规划帧节奏中…', progress: 4 });
  setTaskStatus(taskId, 'planning', '规划帧节奏中…', 4);

  // 1. 使用用户确认过的规划；没有确认规划时才现场调用 Codex/fallback。
  const plan = readConfirmedPlan(task) ?? await planFrames(
    taskCreateInput(task, referencePaths),
    task.frame_count,
    task.motion_type
  );
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
      storyboard: plan.storyboard,
      frameStills: plan.frameStills,
      agentSkills: plan.agentSkills,
      notes: plan.notes,
      framePrompts: plan.framePrompts,
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
    storyboard: plan.storyboard,
    frameStills: plan.frameStills,
    agentSkills: plan.agentSkills
  });

  emit(taskId, 'status', { status: 'planning', message: '翻译内部生成提示词中…', progress: 6 });
  setTaskStatus(taskId, 'planning', '翻译内部生成提示词中…', 6);
  const generationPrompts = await translatePlanForGeneration({
    userPrompt: task.prompt,
    framePrompts: plan.framePrompts,
    negativePrompt: plan.negativePrompt,
    overallPlan: plan.overallPlan,
    animationDescription: plan.animationDescription,
    smoothAnimation: plan.smoothAnimation,
    storyboard: plan.storyboard,
    frameStills: plan.frameStills,
    duration: task.duration,
    fps: task.fps,
    motion: task.motion_type,
    style: task.style
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

  // 2. 创建 keyframe rows + 计算 cache_key
  const refHash =
    referencePaths.length > 0
      ? referencePaths.filter(p => fs.existsSync(p)).map(hashFile).join(':')
      : null;

  const seedBase = task.seed ?? 0;
  const consistencyMode = resolveConsistencyMode();
  for (let i = 0; i < task.frame_count; i++) {
    const framePrompt = plan.framePrompts[i] ?? `${task.prompt} —— 第 ${i + 1} 帧`;
    const generationPrompt = generationPrompts.framePrompts[i] ?? framePrompt;
    const frameSeed = resolveFrameSeed(seedBase, i, consistencyMode);
    const cacheKey = keyframeCacheKey({
      prompt: task.prompt,
      framePrompt: generationPrompt,
      frameIndex: i,
      seed: frameSeed,
      width: task.width,
      height: task.height,
      style: task.style,
      reference_image_hash: refHash,
      model: `comfyui:${consistencyMode}:english:v3`
    });
    insertKeyframe({
      task_id: taskId,
      frame_index: i,
      prompt: framePrompt,
      generation_prompt: generationPrompt,
      seed: frameSeed,
      image_path: null,
      thumbnail_path: null,
      cache_key: cacheKey,
      cache_hit: 0,
      locked: 0,
      status: 'pending',
      error_message: null,
      duration_ms: 0
    });
  }

  // 3. 逐帧生成 / 命中缓存
  await generateVideoForTask(taskId, generationPrompts.videoPrompt, generationPrompts.negativePrompt, referencePaths);
  return;

  const taskForGeneration = getTask(taskId) ?? task;
  setTaskStatus(taskId, 'generating_keyframes', '生成关键帧中…', 8);
  emit(taskId, 'status', { status: 'generating_keyframes', message: '生成关键帧中…', progress: 8 });

  const keyframes = listKeyframes(taskId);
  let cacheHits = 0;
  let costSaved = 0;
  let completedFrames = 0;
  const frameConcurrency = readPositiveInt(process.env.COMFYUI_FRAME_CONCURRENCY, 1);
  appendChatLog({
    task_id: taskId,
    role: 'orchestrator',
    kind: 'note',
    content: JSON.stringify({ frame_concurrency: frameConcurrency, consistency_mode: consistencyMode })
  });

  const markCompleted = (kf: KeyframeRow): void => {
    const updated = getKeyframe(kf.id)!;
    if (updated.cache_hit) {
      cacheHits++;
      costSaved += COST_PER_KEYFRAME;
    }
    completedFrames++;
    const progress = 8 + Math.floor((completedFrames / keyframes.length) * 60);
    setTaskStatus(taskId, 'generating_keyframes', `已完成 ${completedFrames}/${keyframes.length} 帧`, progress);
    emit(taskId, 'frame', { index: kf.frame_index, total: keyframes.length, frameId: kf.id });
    emit(taskId, 'progress', { progress });
  };

  if ((consistencyMode === 'anchor' || consistencyMode === 'previous') && keyframes.length > 1) {
    const anchor = keyframes[0];
    throwIfCancelled(taskId);
    await generateOneFrame(taskForGeneration, anchor, /*forceRegenerate=*/ false);
    markCompleted(anchor);
    let initPath: string | undefined = getKeyframe(anchor.id)?.image_path ?? undefined;
    if (typeof initPath !== 'string' || !fs.existsSync(initPath as string)) {
      throw new Error('首帧锚定图不存在,无法生成连续关键帧');
    }

    const followupConcurrency = consistencyMode === 'previous' ? 1 : frameConcurrency;
    await mapWithConcurrency(keyframes.slice(1), followupConcurrency, async kf => {
      throwIfCancelled(taskId);
      await generateOneFrame(taskForGeneration, kf, /*forceRegenerate=*/ false, initPath);
      markCompleted(kf);
      if (consistencyMode === 'previous') {
        const currentPath = getKeyframe(kf.id)?.image_path;
        if (currentPath && fs.existsSync(currentPath)) initPath = currentPath;
      }
    });
  } else {
    await mapWithConcurrency(keyframes, frameConcurrency, async kf => {
      throwIfCancelled(taskId);
      await generateOneFrame(taskForGeneration, kf, /*forceRegenerate=*/ false);
      markCompleted(kf);
    });
  }
  throwIfCancelled(taskId);

  updateTask(taskId, {
    cache_keyframe_hits: cacheHits,
    cost_saved: +costSaved.toFixed(2)
  });

  // 4. 合成视频
  await composeForTask(taskId);
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
    if (!Array.isArray(parsed.framePrompts) || parsed.framePrompts.length !== task.frame_count) return null;
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
  const keyframes = listKeyframes(taskId);
  const comfy = await cancelComfyPrompts(keyframes.map(kf => ({
    prompt: kf.generation_prompt ?? kf.prompt,
    seed: kf.seed,
    width: task.width,
    height: task.height
  })));

  cancelTask(taskId);
  appendChatLog({
    task_id: taskId,
    role: 'system',
    kind: 'note',
    content: JSON.stringify({ action: 'cancel', message: '任务已取消', comfyui: comfy })
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

  const keyframes = listKeyframes(taskId);
  if (keyframes.length > 0) {
    await generateVideoForTask(
      taskId,
      task.generation_prompt ?? task.prompt,
      task.generation_negative_prompt ?? process.env.COMFYUI_NEGATIVE ?? 'lowres, blurry, watermark, text, deformed',
      parseReferenceImagePaths(task.reference_image_path)
    );
    return;
  }

  const pending = keyframes.filter(k => k.status !== 'completed' || !k.image_path);
  if (pending.length === 0) {
    await composeForTask(taskId);
    return;
  }

  setTaskStatus(taskId, 'generating_keyframes', `继续生成剩余 ${pending.length}/${keyframes.length} 帧…`, task.progress);
  emit(taskId, 'status', {
    status: 'generating_keyframes',
    message: `继续生成剩余 ${pending.length}/${keyframes.length} 帧…`,
    progress: task.progress
  });

  let completedFrames = keyframes.length - pending.length;
  let cacheHits = keyframes.filter(k => k.cache_hit).length;
  let costSaved = +(cacheHits * COST_PER_KEYFRAME).toFixed(2);
  const frameConcurrency = readPositiveInt(process.env.COMFYUI_FRAME_CONCURRENCY, 1);

  await mapWithConcurrency(pending, frameConcurrency, async kf => {
    throwIfCancelled(taskId);
    await generateOneFrame(task, kf, /*forceRegenerate=*/ false);
    const updated = getKeyframe(kf.id)!;
    if (updated.cache_hit) {
      cacheHits++;
      costSaved += COST_PER_KEYFRAME;
    }
    completedFrames++;
    const progress = 8 + Math.floor((completedFrames / keyframes.length) * 60);
    setTaskStatus(taskId, 'generating_keyframes', `已完成 ${completedFrames}/${keyframes.length} 帧`, progress);
    emit(taskId, 'frame', { index: kf.frame_index, total: keyframes.length, frameId: kf.id });
    emit(taskId, 'progress', { progress });
  });

  updateTask(taskId, {
    cache_keyframe_hits: cacheHits,
    cost_saved: +costSaved.toFixed(2)
  });
  throwIfCancelled(taskId);
  await composeForTask(taskId);
}

/**
 * 单帧生成: 检查缓存 -> 命中复用,未命中调用 image-gen + 写入缓存
 */
async function generateOneFrame(
  task: VideoTaskRow,
  kf: KeyframeRow,
  forceRegenerate: boolean,
  initImagePath?: string
): Promise<void> {
  throwIfCancelled(task.id);
  if (kf.locked && !forceRegenerate) {
    appendChatLog({
      task_id: task.id,
      role: 'system',
      kind: 'note',
      content: `第 ${kf.frame_index + 1} 帧已锁定,跳过生成`
    });
    return;
  }

  // 缓存查询
  if (!forceRegenerate) {
    const hit = getCacheByKey(kf.cache_key);
    if (hit && fs.existsSync(hit.file_path)) {
      const dst = path.join(taskDir(task.id), 'keyframes', `frame_${String(kf.frame_index).padStart(3, '0')}.png`);
      if (path.resolve(dst) !== path.resolve(hit.file_path)) {
        fs.copyFileSync(hit.file_path, dst);
      }
      const thumb = path.join(taskDir(task.id), 'thumbs', `frame_${String(kf.frame_index).padStart(3, '0')}.webp`);
      try {
        await makeThumbnail(dst, thumb);
      } catch {
        /* swallow */
      }
      recordCacheHit(kf.cache_key);
      updateKeyframe(kf.id, {
        image_path: dst,
        thumbnail_path: thumb,
        cache_hit: 1,
        status: 'completed',
        duration_ms: 0
      });
      appendChatLog({
        task_id: task.id,
        role: 'orchestrator',
        kind: 'frame_generation',
        content: JSON.stringify({ frame_index: kf.frame_index, cache_hit: true, cache_key: kf.cache_key })
      });
      return;
    }
  }

  // 未命中: 调用图像生成
  updateKeyframe(kf.id, { status: 'generating' });
  emit(task.id, 'frame', { index: kf.frame_index, status: 'generating', frameId: kf.id });

  const dst = path.join(taskDir(task.id), 'keyframes', `frame_${String(kf.frame_index).padStart(3, '0')}.png`);
  try {
    const result = await generateImageWithRetry(task, kf, dst, initImagePath);
    // 写入缓存
    const cacheDst = cacheFile(kf.cache_key, 'png');
    if (!fs.existsSync(cacheDst)) {
      fs.copyFileSync(dst, cacheDst);
    }
    insertCache({
      cache_key: kf.cache_key,
      cache_type: 'keyframe',
      file_path: cacheDst,
      meta: { frame_index: kf.frame_index, backend: result.backend, seed: kf.seed }
    });
    // 缩略图
    const thumb = path.join(taskDir(task.id), 'thumbs', `frame_${String(kf.frame_index).padStart(3, '0')}.webp`);
    try {
      await makeThumbnail(dst, thumb);
    } catch {
      /* swallow */
    }
    updateKeyframe(kf.id, {
      image_path: dst,
      thumbnail_path: thumb,
      cache_hit: 0,
      status: 'completed',
      duration_ms: result.durationMs
    });
    appendChatLog({
      task_id: task.id,
      role: 'orchestrator',
      kind: 'frame_generation',
      content: JSON.stringify({
        frame_index: kf.frame_index,
        cache_hit: false,
        backend: result.backend,
        duration_ms: result.durationMs
      })
    });
  } catch (e) {
    if (getTask(task.id)?.status === 'cancelled') {
      updateKeyframe(kf.id, {
        status: 'failed',
        error_message: '已取消'
      });
      throw e;
    }
    updateKeyframe(kf.id, {
      status: 'failed',
      error_message: (e as Error).message
    });
    appendChatLog({
      task_id: task.id,
      role: 'system',
      kind: 'error',
      content: `第 ${kf.frame_index + 1} 帧生成失败: ${(e as Error).message}`
    });
    throw e;
  }
}

async function generateImageWithRetry(
  task: VideoTaskRow,
  kf: KeyframeRow,
  outPath: string,
  initImagePath?: string
): Promise<Awaited<ReturnType<typeof generateImage>>> {
  const retries = Math.max(0, readInt(process.env.COMFYUI_FRAME_RETRIES, 2));
  const retryDelayMs = readPositiveInt(process.env.COMFYUI_RETRY_DELAY_MS, 10_000);
  const maxAttempts = 1 + retries;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfCancelled(task.id);
    try {
      const attemptStartedAt = Date.now();
      updateKeyframe(kf.id, {
        status: 'generating',
        error_message: attempt > 1 ? `第 ${attempt}/${maxAttempts} 次重试中…` : null
      });
      emit(task.id, 'frame', {
        index: kf.frame_index,
        status: 'generating',
        frameId: kf.id,
        attempt,
        maxAttempts,
        startedAt: attemptStartedAt,
        elapsedMs: 0
      });

      const referenceInitImage =
        initImagePath ??
        (parseReferenceImagePaths(task.reference_image_path).find(p => fs.existsSync(p))
          ? parseReferenceImagePaths(task.reference_image_path).find(p => fs.existsSync(p))
          : undefined);

      return await generateImage({
        prompt: await ensureFrameGenerationPrompt(task, kf),
        negativePrompt: task.generation_negative_prompt || process.env.COMFYUI_NEGATIVE || 'lowres, blurry, watermark, deformed',
        seed: kf.seed,
        width: task.width,
        height: task.height,
        outPath,
        initImagePath: referenceInitImage,
        onProgress: progress => {
          emit(task.id, 'frame', {
            index: kf.frame_index,
            status: 'generating',
            frameId: kf.id,
            attempt,
            maxAttempts,
            startedAt: attemptStartedAt,
            elapsedMs: progress.elapsedMs,
            step: progress.value,
            maxSteps: progress.max,
            node: progress.node,
            promptId: progress.promptId
          });
        }
      });
    } catch (e) {
      lastError = e;
      const message = (e as Error).message || String(e);
      if (attempt >= maxAttempts) break;

      updateKeyframe(kf.id, {
        status: 'generating',
        error_message: `第 ${attempt}/${maxAttempts} 次生成失败,${Math.round(retryDelayMs / 1000)} 秒后重试: ${message}`
      });
      appendChatLog({
        task_id: task.id,
        role: 'system',
        kind: 'error',
        content: `第 ${kf.frame_index + 1} 帧第 ${attempt}/${maxAttempts} 次生成失败,准备重试: ${message}`
      });
      emit(task.id, 'frame', {
        index: kf.frame_index,
        status: 'retrying',
        frameId: kf.id,
        attempt,
        maxAttempts,
        message
      });
      await sleep(retryDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function ensureFrameGenerationPrompt(task: VideoTaskRow, kf: KeyframeRow): Promise<string> {
  if (kf.generation_prompt?.trim()) return kf.generation_prompt;
  const translated = await translateTextForGeneration({
    text: kf.prompt,
    taskPrompt: task.prompt,
    frameIndex: kf.frame_index,
    duration: task.duration,
    motion: task.motion_type,
    style: task.style
  });
  updateKeyframe(kf.id, { generation_prompt: translated.text });
  if (translated.codexThreadId || translated.model) {
    updateTask(task.id, {
      codex_exec_thread_id: translated.codexThreadId ?? task.codex_exec_thread_id,
      codex_exec_model: translated.model ?? task.codex_exec_model
    });
  }
  return translated.text;
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

  const keyframes = listKeyframes(taskId);
  if (keyframes.length === 0) throw new Error('no keyframes to attach video frames');

  const videoPath = path.join(taskDir(taskId), 'video.mp4');
  const coverPath = path.join(taskDir(taskId), 'cover.jpg');
  const videoKey = videoCacheKey(task, keyframes, videoPrompt);

  setTaskStatus(taskId, 'generating_motion', 'ComfyUI 视频模型生成中…', 10);
  emit(taskId, 'status', { status: 'generating_motion', message: 'ComfyUI 视频模型生成中…', progress: 10 });
  for (const kf of keyframes) {
    updateKeyframe(kf.id, { status: 'generating', error_message: null });
    emit(taskId, 'frame', { index: kf.frame_index, status: 'generating', frameId: kf.id });
  }

  const cached = getCacheByKey(videoKey);
  let durationMs = 0;
  let cacheHit = false;
  if (cached && fs.existsSync(cached.file_path)) {
    fs.copyFileSync(cached.file_path, videoPath);
    recordCacheHit(videoKey);
    cacheHit = true;
  } else {
    const startedAt = Date.now();
    const result = await generateVideo({
      prompt: buildComfyVideoPrompt(task, videoPrompt, keyframes),
      negativePrompt: negativePrompt || task.generation_negative_prompt || process.env.COMFYUI_NEGATIVE || 'lowres, blurry, watermark, text, deformed',
      seed: task.seed ?? 0,
      width: task.width,
      height: task.height,
      duration: task.duration,
      fps: task.fps,
      frameCount: resolveVideoFrameCount(task),
      outPath: videoPath,
      referenceImagePath: referencePaths.find(p => fs.existsSync(p)),
      onProgress: progress => {
        const pct = 10 + Math.floor((progress.value / Math.max(1, progress.max)) * 55);
        setTaskStatus(taskId, 'generating_motion', `ComfyUI 视频模型生成中 ${progress.value}/${progress.max}`, pct);
        emit(taskId, 'status', {
          status: 'generating_motion',
          message: `ComfyUI 视频模型生成中 ${progress.value}/${progress.max}`,
          progress: pct,
          elapsedMs: progress.elapsedMs,
          node: progress.node,
          promptId: progress.promptId
        });
      }
    });
    durationMs = result.durationMs || (Date.now() - startedAt);
    const cacheDst = cacheFile(videoKey, 'mp4');
    fs.copyFileSync(videoPath, cacheDst);
    insertCache({
      cache_key: videoKey,
      cache_type: 'video',
      file_path: cacheDst,
      meta: { mode: 'video', backend: result.backend, duration: task.duration, fps: task.fps, generation_prompt: videoPrompt }
    });
  }
  throwIfCancelled(taskId);

  setTaskStatus(taskId, 'composing_video', '从视频抽取关键帧图册…', 75);
  emit(taskId, 'status', { status: 'composing_video', message: '从视频抽取关键帧图册…', progress: 75 });
  const extracted = await extractFramesFromVideo({
    videoPath,
    outDir: path.join(taskDir(taskId), 'video_frames'),
    frameCount: task.frame_count,
    width: task.width,
    height: task.height,
    duration: task.duration
  });
  if (extracted.length === 0) throw new Error('视频已生成,但抽帧失败');

  for (const [index, kf] of keyframes.entries()) {
    const src = extracted[Math.min(index, extracted.length - 1)];
    const dst = path.join(taskDir(taskId), 'keyframes', `frame_${String(kf.frame_index).padStart(3, '0')}.png`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const thumb = path.join(taskDir(taskId), 'thumbs', `frame_${String(kf.frame_index).padStart(3, '0')}.webp`);
    try {
      await makeThumbnail(dst, thumb);
    } catch {
      /* ignore thumbnail failures */
    }
    updateKeyframe(kf.id, {
      image_path: dst,
      thumbnail_path: fs.existsSync(thumb) ? thumb : null,
      cache_hit: cacheHit ? 1 : 0,
      status: 'completed',
      duration_ms: keyframes.length > 0 ? Math.round(durationMs / keyframes.length) : durationMs
    });
    emit(taskId, 'frame', { index: kf.frame_index, total: keyframes.length, frameId: kf.id });
  }

  try {
    await extractCover(videoPath, coverPath);
  } catch {
    /* ignore */
  }

  appendChatLog({
    task_id: taskId,
    role: 'orchestrator',
    kind: 'compose',
    content: JSON.stringify({
      mode: 'comfyui_video',
      model: process.env.COMFYUI_VIDEO_MODEL || 'wan2.2_ti2v_5B_fp16.safetensors',
      cache_hit: cacheHit,
      video_key: videoKey,
      duration_ms: durationMs,
      extracted_frames: extracted.length
    })
  });

  updateTask(taskId, {
    video_path: videoPath,
    cover_path: fs.existsSync(coverPath) ? coverPath : null,
    cache_video_hit: cacheHit ? 1 : 0,
    cache_keyframe_hits: cacheHit ? keyframes.length : 0,
    progress: 100,
    status: 'completed',
    stage_message: cacheHit ? '已完成(命中视频缓存)' : '已完成'
  });
  emit(taskId, 'completed', { videoPath, cache_hit: cacheHit, duration_ms: durationMs });
}

function buildComfyVideoPrompt(task: VideoTaskRow, videoPrompt: string, keyframes: KeyframeRow[]): string {
  const frameArc = keyframes
    .slice(0, 12)
    .map(kf => `second ${kf.frame_index}: ${kf.generation_prompt ?? kf.prompt}`)
    .join(' | ');
  return [
    videoPrompt,
    `Original user request: ${task.prompt}`,
    `Duration ${task.duration} seconds, ${task.fps} fps, ${task.aspect_ratio}, ${task.motion_type} camera motion.`,
    'Generate one continuous coherent video clip, not separate still images. Keep the same subject identity, scene, lighting direction, color palette, scale relationships, and camera continuity throughout.',
    frameArc ? `Per-second visual arc: ${frameArc}` : ''
  ].filter(Boolean).join(' ');
}

export async function composeForTask(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  throwIfCancelled(taskId);
  const keyframes = listKeyframes(taskId);
  const ready = keyframes.filter(k => k.status === 'completed' && k.image_path);
  if (ready.length < Math.min(2, keyframes.length)) {
    throw new Error(`关键帧不足,无法合成 (ready=${ready.length}/${keyframes.length})`);
  }

  setTaskStatus(taskId, 'composing_video', 'FFmpeg 合成视频中…', 75);
  emit(taskId, 'status', { status: 'composing_video', message: 'FFmpeg 合成视频中…', progress: 75 });

  // 视频缓存查询
  const videoKey = videoCacheKey(task, keyframes, task.generation_prompt ?? undefined);
  const videoPath = path.join(taskDir(taskId), 'video.mp4');
  const coverPath = path.join(taskDir(taskId), 'cover.jpg');

  const cacheHit = getCacheByKey(videoKey);
  if (cacheHit && fs.existsSync(cacheHit.file_path)) {
    fs.copyFileSync(cacheHit.file_path, videoPath);
    recordCacheHit(videoKey);
    appendChatLog({
      task_id: taskId,
      role: 'orchestrator',
      kind: 'compose',
      content: JSON.stringify({ cache_hit: true, video_key: videoKey })
    });
    try {
      await extractCover(videoPath, coverPath);
    } catch {
      /* ignore */
    }
    updateTask(taskId, {
      video_path: videoPath,
      cover_path: fs.existsSync(coverPath) ? coverPath : null,
      cache_video_hit: 1,
      progress: 100,
      status: 'completed',
      stage_message: '已完成(命中视频缓存)'
    });
    emit(taskId, 'completed', { videoPath, cache_hit: true });
    return;
  }

  // 真实合成
  const t0 = Date.now();
  const result = await composeVideo({
    framePaths: ready.map(k => k.image_path!),
    outPath: videoPath,
    width: task.width,
    height: task.height,
    fps: task.fps,
    duration: task.duration,
    motion: task.motion_type
  });
  try {
    await extractCover(videoPath, coverPath);
  } catch {
    /* ignore */
  }

  // 写入视频缓存
  const cacheDst = cacheFile(videoKey, 'mp4');
  fs.copyFileSync(videoPath, cacheDst);
  insertCache({
    cache_key: videoKey,
    cache_type: 'video',
    file_path: cacheDst,
    meta: { duration: task.duration, fps: task.fps, motion: task.motion_type, generation_prompt: task.generation_prompt ?? null }
  });

  appendChatLog({
    task_id: taskId,
    role: 'orchestrator',
    kind: 'compose',
    content: JSON.stringify({
      cache_hit: false,
      video_key: videoKey,
      duration_ms: Date.now() - t0,
      segments: result.segments
    })
  });

  updateTask(taskId, {
    video_path: videoPath,
    cover_path: fs.existsSync(coverPath) ? coverPath : null,
    cache_video_hit: 0,
    progress: 100,
    status: 'completed',
    stage_message: '已完成'
  });
  emit(taskId, 'completed', { videoPath, cache_hit: false, duration_ms: Date.now() - t0 });
}

/** 单帧重生成 */
export async function regenerateKeyframe(
  taskId: string,
  frameId: string,
  opts: { newPrompt?: string; newSeed?: number } = {}
): Promise<void> {
  const task = getTask(taskId);
  const kf = getKeyframe(frameId);
  if (!task || !kf || kf.task_id !== taskId) throw new Error('frame not found');
  if (kf.locked) throw new Error('该帧已锁定,不能重生成');

  // 更新 prompt / seed
  const referencePaths = parseReferenceImagePaths(task.reference_image_path);
  const refHash =
    referencePaths.length > 0
      ? referencePaths.filter(p => fs.existsSync(p)).map(hashFile).join(':')
      : null;
  const newPrompt = opts.newPrompt ?? kf.prompt;
  const newGenerationPrompt = opts.newPrompt
    ? (await translateTextForGeneration({
      text: newPrompt,
      taskPrompt: task.prompt,
      frameIndex: kf.frame_index,
      duration: task.duration,
      motion: task.motion_type,
      style: task.style
    })).text
    : (kf.generation_prompt ?? newPrompt);
  const newSeed = opts.newSeed ?? Math.floor(Math.random() * 1_000_000);
  const newKey = keyframeCacheKey({
    prompt: task.prompt,
    framePrompt: newGenerationPrompt,
    frameIndex: kf.frame_index,
    seed: newSeed,
    width: task.width,
    height: task.height,
    style: task.style,
    reference_image_hash: refHash,
    model: 'comfyui:regenerate:english:v3'
  });
  updateKeyframe(frameId, {
    prompt: newPrompt,
    generation_prompt: newGenerationPrompt,
    seed: newSeed,
    cache_key: newKey,
    cache_hit: 0,
    status: 'pending',
    error_message: null
  });

  appendChatLog({
    task_id: taskId,
    role: 'user',
    kind: 'frame_generation',
    content: JSON.stringify({ action: 'regenerate', frame_index: kf.frame_index, new_prompt: newPrompt, new_seed: newSeed })
  });

  // 异步触发流程: 重生成 + 重合成
  enqueueRegenerate(taskId, frameId);
}

function enqueueRegenerate(taskId: string, frameId: string): void {
  _running = _running.then(async () => {
    try {
      const task = getTask(taskId);
      const kf = getKeyframe(frameId);
      if (!task || !kf) return;
      setTaskStatus(taskId, 'generating_motion', `重新生成整段视频,并更新第 ${kf.frame_index + 1} 帧图册…`, 30);
      emit(taskId, 'status', { status: 'generating_motion', progress: 30 });
      await generateVideoForTask(
        taskId,
        task.generation_prompt ?? task.prompt,
        task.generation_negative_prompt ?? process.env.COMFYUI_NEGATIVE ?? 'lowres, blurry, watermark, text, deformed',
        parseReferenceImagePaths(task.reference_image_path)
      );
    } catch (e) {
      const msg = (e as Error).message;
      setTaskStatus(taskId, 'failed', msg, 100);
      bus.emitTask(taskId, { type: 'failed', payload: { message: msg } });
    }
  });
}

function emit(taskId: string, type: 'status' | 'progress' | 'frame' | 'log' | 'completed' | 'failed', payload: unknown): void {
  bus.emitTask(taskId, { type, payload });
}

function throwIfCancelled(taskId: string): void {
  if (getTask(taskId)?.status === 'cancelled') {
    throw new Error('task cancelled');
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await worker(item);
      }
    })
  );
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveConsistencyMode(): 'none' | 'seed' | 'anchor' | 'previous' {
  const value = process.env.COMFYUI_CONSISTENCY_MODE?.trim().toLowerCase();
  if (value === 'none' || value === 'seed' || value === 'anchor' || value === 'previous') return value;
  return 'previous';
}

function resolveFrameSeed(seedBase: number, frameIndex: number, mode: 'none' | 'seed' | 'anchor' | 'previous'): number {
  if (mode === 'seed') return seedBase >>> 0;
  return (seedBase + frameIndex * 1009) >>> 0;
}

function resolveVideoFrameCount(task: VideoTaskRow): number {
  const configured = readInt(process.env.COMFYUI_VIDEO_FRAMES, 0);
  if (configured > 0) return configured;
  return Math.max(41, Math.min(121, Math.round(task.duration * task.fps)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
