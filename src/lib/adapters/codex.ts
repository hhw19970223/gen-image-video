// Codex CLI orchestrator —— prompt 规划 + 调度
//
// 设计:
//   - 把 codex CLI 视为可选 LLM 编排器
//   - 输入: 用户原始 prompt + 视频参数(帧数/比例/动作/风格)
//   - 输出: 一个 plan { overallPlan; agentSkills; framePrompts; negativePrompt; notes }
//   - 如果 CODEX_BIN 可执行则真实调用,否则使用规则 fallback(确定性,可复现)

import { spawn } from 'node:child_process';
import type { CreateTaskInput } from '../types';

export interface FramePlan {
  overallPlan: {
    concept: string;
    visualStyle: string;
    cameraLanguage: string;
    continuityRules: string;
    referenceUsage?: string;
  };
  animationDescription: string;
  smoothAnimation: {
    durationSeconds: number;
    summary: string;
    motionArc: string;
    timing: string;
    transitionLogic: string;
    continuityStrategy: string;
  };
  storyboard: Array<{
    frameIndex: number;
    timeSec: number;
    coreFrame: string;
    previousToCurrentChange: string;
    cameraState: string;
    subjectState: string;
    continuityAnchor: string;
    comfyPrompt: string;
  }>;
  frameStills: Array<{
    frameIndex: number;
    timeSec: number;
    stillDescription: string;
    roleInAnimation: string;
    visualChange: string;
  }>;
  agentSkills: Array<{
    agent: string;
    skill: string;
    output: string;
  }>;
  framePrompts: string[];
  negativePrompt: string;
  notes: string;
  source: 'codex' | 'fallback';
  codexThreadId?: string;
  model?: string;
}

export interface GenerationPromptTranslation {
  videoPrompt: string;
  framePrompts: string[];
  negativePrompt: string;
  source: 'codex' | 'fallback';
  codexThreadId?: string;
  model?: string;
}

const SYSTEM_PROMPT = `你是一个 AI 视频创作多 Agent 编排组,不要写僵硬的说明文,要输出可以直接给图像/视频模型使用的导演级提示词。

团队角色:
- Creative Director Agent: 提炼概念、情绪、卖点和视觉隐喻。
- Storyboard Agent: 把画面拆成有节奏的镜头起承转合。
- Image Prompt Agent: 写出主体、构图、光影、材质、色彩、景深、镜头焦段。
- Animation Agent: 写出镜头运动、主体微动作、转场节奏,避免大幅跳变。
- Copy Polish Agent: 把平铺直叙改成自然、有画面感、适合短视频/广告片的表达。
- Continuity Reviewer Agent: 确保所有关键帧保持同一个主体、同一身份/产品外观、同一材质、同一服装/包装、同一场景和光线连续性。

任务:
- 第一层必须是给用户二次确认的中文导演规划,不是 Wan prompt。先写 animationDescription: 一段完整、顺滑、可执行的成片动画描述,明确在 duration 秒内画面如何开始、如何运动、如何过渡、如何收束。它要像导演给分镜师的说明,不能只是关键词堆叠。
- 第二层必须是给用户二次确认的中文逐帧定格描述 frameStills。按每秒 1 帧拆成 N 个定格画面,每一帧都写“这一秒暂停时画面应该是什么样”,而不是写模型提示词。每个 frameStill 必须包含 stillDescription、roleInAnimation、visualChange。
- 第三层才是内部 Wan 生成用 storyboard/comfyPrompt。它要从定格描述派生,但不要把它作为用户确认的主要内容。
- 必须先做整支视频的总规划,说明这个视频最终应该是什么样: 核心概念、视觉风格、镜头语言、节奏、连续性约束、参考图使用方式。
- 再把总规划拆成 N 张关键帧的时间轴分镜,每一秒一帧,每帧都必须是上一帧的自然推进,不能像独立海报。
- 每条 storyboard.coreFrame 的“核心画面”必须足够细: 主体外观、数量、姿态/朝向、相对画面位置、前景/中景/背景关系、材质纹理、颜色、光源方向、阴影、高光、景深、镜头焦段、画面边缘可见元素都要写清楚。
- 每一帧都要说明 previousToCurrentChange: “这一帧和上一帧相比具体变化了什么”,变化只能发生在镜头距离、角度、构图裁切、局部姿态、光影强弱或转场节奏,不能改变主体身份。
- 每一帧都要写 continuityAnchor,明确哪些主体身份、材质、服装/包装、场景、光源方向、色彩关系必须延续到上一帧和下一帧。
- 每一帧都要写 comfyPrompt,这是最终给 Wan 的提示词,必须重复主体身份、核心画面细节、相对上一帧变化、必须不变的连续性锚点、镜头位置/裁切/焦段/光线/背景。不要用“同上”“保持一致”这种省略说法。
- 每张关键帧体现镜头的渐进运动(zoom_in/zoom_out/pan/fade/crossfade 等),但不要改变主体身份。
- 如果 has_reference_image 为 true,提示词要综合所有参考图；第一张是主锚定图,其他参考图用于补充主体细节、材质、配色、包装/服装、场景和光线信息。
- 有多张参考图时,不要把它们画成多个并列主体,除非用户明确要求；默认融合为同一主体/同一产品的连续镜头约束。
- 文案要具体、顺滑、有导演感,避免“第几帧,远景/中景”这种机械句式。
- 输出 JSON: {"overallPlan": {"concept": "...", "visualStyle": "...", "cameraLanguage": "...", "continuityRules": "...", "referenceUsage": "..."}, "animationDescription": "...", "smoothAnimation": {"durationSeconds": 15, "summary": "...", "motionArc": "...", "timing": "...", "transitionLogic": "...", "continuityStrategy": "..."}, "frameStills": [{"frameIndex": 0, "timeSec": 0, "stillDescription": "...", "roleInAnimation": "...", "visualChange": "..."}], "storyboard": [{"frameIndex": 0, "timeSec": 0, "coreFrame": "...", "previousToCurrentChange": "...", "cameraState": "...", "subjectState": "...", "continuityAnchor": "...", "comfyPrompt": "..."}], "agentSkills": [{"agent": "Creative Director Agent", "skill": "...", "output": "..."}], "framePrompts": ["...", "..."], "negativePrompt": "...", "notes": "..."}
- agentSkills 必须至少包含 Creative Director Agent、Storyboard Agent、Image Prompt Agent、Animation Agent、Continuity Reviewer Agent；如果是商业/产品内容,还要包含 Copy Polish Agent。
- frameStills 数组长度必须等于 N,storyboard 数组长度必须等于 N,framePrompts 数组长度也必须等于 N,且 framePrompts 必须由 storyboard[].comfyPrompt 派生。
- negativePrompt 描述应避免的画面缺陷。
- notes 用一两句话给出整体节奏建议,说明用了哪些 Agent 角色。`;

function userPayload(input: CreateTaskInput, frameCount: number, motion: string): string {
  return JSON.stringify({
    user_prompt: input.prompt,
    frame_count: frameCount,
    aspect_ratio: input.aspect_ratio,
    motion_type: motion,
    style: input.style ?? null,
    duration: input.duration,
    fps: input.fps ?? 24,
    has_reference_image: Boolean(input.reference_image_paths?.length ?? input.reference_image_path),
    reference_image_path: input.reference_image_path ?? null,
    reference_image_count: input.reference_image_paths?.length ?? (input.reference_image_path ? 1 : 0)
  });
}

/** 主入口 */
export async function planFrames(
  input: CreateTaskInput,
  frameCount: number,
  motion: string
): Promise<FramePlan> {
  const codexBin = process.env.CODEX_BIN?.trim();
  if (codexBin) {
    try {
      return await runCodex(codexBin, input, frameCount, motion);
    } catch (e) {
      console.warn('[codex] failed, falling back:', (e as Error).message);
    }
  }
  return fallbackPlan(input, frameCount, motion);
}

export async function translatePlanForGeneration(input: {
  userPrompt: string;
  framePrompts: string[];
  negativePrompt?: string;
  overallPlan?: unknown;
  animationDescription?: unknown;
  smoothAnimation?: unknown;
  storyboard?: unknown;
  frameStills?: unknown;
  duration: number;
  fps: number;
  motion: string;
  style?: string | null;
}): Promise<GenerationPromptTranslation> {
  const codexBin = process.env.CODEX_BIN?.trim();
  if (codexBin) {
    try {
      return await runCodexTranslation(codexBin, input);
    } catch (e) {
      console.warn('[codex translate] failed, falling back:', (e as Error).message);
    }
  }
  return fallbackGenerationTranslation(input);
}

export async function translateTextForGeneration(input: {
  text: string;
  taskPrompt: string;
  frameIndex?: number;
  duration: number;
  motion: string;
  style?: string | null;
}): Promise<{ text: string; source: 'codex' | 'fallback'; codexThreadId?: string; model?: string }> {
  const translated = await translatePlanForGeneration({
    userPrompt: input.taskPrompt,
    framePrompts: [input.text],
    duration: input.duration,
    fps: 24,
    motion: input.motion,
    style: input.style,
    storyboard: [{
      frameIndex: input.frameIndex ?? 0,
      timeSec: input.frameIndex ?? 0,
      comfyPrompt: input.text
    }]
  });
  return {
    text: translated.framePrompts[0] ?? input.text,
    source: translated.source,
    codexThreadId: translated.codexThreadId,
    model: translated.model
  };
}

async function runCodex(
  bin: string,
  input: CreateTaskInput,
  frameCount: number,
  motion: string
): Promise<FramePlan> {
  return new Promise((resolve, reject) => {
    const model = process.env.CODEX_MODEL || 'gpt-5-mini';
    const args = ['exec', '-C', process.cwd(), '--skip-git-repo-check', '--model', model, '--json'];
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex CLI timed out after 60s'));
    }, 60_000);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`codex exited ${code}: ${err}`));
      try {
        // 提取 JSON: codex CLI 通常会输出一行行 JSON event,最后一段 text 是 assistant 内容
        const result = extractCodexResult(out);
        const json = extractJson(result.text);
        const parsed = JSON.parse(json);
        const fallbackPrompts = Array.isArray(parsed.framePrompts) ? parsed.framePrompts.map(String) : [];
        const storyboard = normalizeStoryboard(parsed.storyboard, fallbackPrompts, input, frameCount, motion);
        const prompts = storyboard.map(item => item.comfyPrompt);
        if (prompts.length !== frameCount) {
          return reject(new Error(`codex returned ${prompts.length} frames, expected ${frameCount}`));
        }
        const plan: FramePlan = {
          overallPlan: normalizeOverallPlan(parsed.overallPlan, input, frameCount, motion),
          animationDescription: normalizeAnimationDescription(parsed.animationDescription, input, frameCount, motion),
          smoothAnimation: normalizeSmoothAnimation(parsed.smoothAnimation, input, frameCount, motion),
          storyboard,
          frameStills: normalizeFrameStills(parsed.frameStills, storyboard, input, frameCount, motion),
          agentSkills: normalizeAgentSkills(parsed.agentSkills, input),
          framePrompts: prompts,
          negativePrompt: String(parsed.negativePrompt ?? ''),
          notes: String(parsed.notes ?? ''),
          source: 'codex',
          codexThreadId: result.threadId,
          model
        };
        const weakReason = weakCodexPlanReason(plan, input, frameCount);
        if (weakReason) {
          return reject(new Error(`codex plan rejected: ${weakReason}`));
        }
        resolve(plan);
      } catch (e) {
        reject(e as Error);
      }
    });
    // 写入 prompt
    child.stdin.write(`${SYSTEM_PROMPT}\n\n${userPayload(input, frameCount, motion)}\n`);
    child.stdin.end();
  });
}

async function runCodexTranslation(
  bin: string,
  input: Parameters<typeof translatePlanForGeneration>[0]
): Promise<GenerationPromptTranslation> {
  return new Promise((resolve, reject) => {
    const model = process.env.CODEX_MODEL || 'gpt-5-mini';
    const args = ['exec', '-C', process.cwd(), '--skip-git-repo-check', '--model', model, '--json'];
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex translation timed out after 90s'));
    }, 90_000);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`codex translation exited ${code}: ${err}`));
      try {
        const result = extractCodexResult(out);
        const parsed = JSON.parse(extractJson(result.text)) as Record<string, unknown>;
        const framePrompts = Array.isArray(parsed.framePrompts) ? parsed.framePrompts.map(String) : [];
        if (framePrompts.length !== input.framePrompts.length) {
          return reject(new Error(`codex translated ${framePrompts.length} frames, expected ${input.framePrompts.length}`));
        }
        resolve({
          videoPrompt: String(parsed.videoPrompt ?? englishVideoFallback(input)),
          framePrompts,
          negativePrompt: sanitizeNegativePrompt(
            String(parsed.negativePrompt ?? englishNegativeFallback(input.negativePrompt, input)),
            input
          ),
          source: 'codex',
          codexThreadId: result.threadId,
          model
        });
      } catch (e) {
        reject(e as Error);
      }
    });

    child.stdin.write(`${TRANSLATION_PROMPT}\n\n${JSON.stringify(input)}\n`);
    child.stdin.end();
  });
}

const TRANSLATION_PROMPT = `You are the internal prompt translator for a direct Wan video pipeline.
Translate the provided Chinese planning text into fluent, concrete English image-generation prompts.
Do not expose explanations. Preserve all visual details, continuity constraints, frame-to-frame changes, camera state, lighting, materials, subject identity, and reference-image instructions.
If the user requests two different subjects, especially animals such as a cat and a mouse, every frame prompt must explicitly state the exact requested subject count and species, for example: "exactly one cat and exactly one small mouse in the same frame, two different species, the mouse is much smaller than the cat, do not turn the mouse into a second cat".
The user-facing plan stays in the original language; your output is only for internal generation.
Return strict JSON only:
{"videoPrompt":"English video-level generation summary","framePrompts":["English Wan prompt 1"],"negativePrompt":"English negative prompt"}
Rules:
- framePrompts length must exactly match the input framePrompts length.
- Each frame prompt must be directly usable by Wan/video model.
- Repeat subject identity and continuity anchors in every frame.
- Do not use vague translation notes like "same as previous"; write the actual visual details again.
- Keep product names, brand names, and proper nouns unchanged when present.
- negativePrompt must be English and should include common image defects, text/watermark/logo errors, subject drift, background jumps, and unwanted extra subjects.
- Never put requested subjects into the negative prompt. If the requested subject includes animals, do not write "animals appearing" as a negative. If the requested subject is cat and mouse, useful negatives include: second cat, second mouse, missing mouse, missing cat, mouse transformed into cat.`;

function normalizeOverallPlan(
  value: unknown,
  input: CreateTaskInput,
  frameCount: number,
  motion: string
): FramePlan['overallPlan'] {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    return {
      concept: String(raw.concept ?? input.prompt),
      visualStyle: String(raw.visualStyle ?? `${input.style ?? 'default'} visual style`),
      cameraLanguage: String(raw.cameraLanguage ?? `${motion} across ${frameCount} frames`),
      continuityRules: String(raw.continuityRules ?? 'Keep subject identity, material, lighting, scene and composition continuous.'),
      referenceUsage: raw.referenceUsage === undefined ? undefined : String(raw.referenceUsage)
    };
  }
  return fallbackOverallPlan(input, frameCount, motion);
}

function normalizeAnimationDescription(
  value: unknown,
  input: CreateTaskInput,
  frameCount: number,
  motion: string
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallbackAnimationDescription(input, frameCount, motion);
}

function normalizeSmoothAnimation(
  value: unknown,
  input: CreateTaskInput,
  frameCount: number,
  motion: string
): FramePlan['smoothAnimation'] {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    return {
      durationSeconds: Number.isFinite(Number(raw.durationSeconds)) ? Number(raw.durationSeconds) : input.duration,
      summary: String(raw.summary ?? `围绕“${input.prompt}”生成一段连续顺滑的 ${input.duration}s 动画。`),
      motionArc: String(raw.motionArc ?? `${motion} across ${frameCount} one-second keyframes.`),
      timing: String(raw.timing ?? `每秒 1 张关键帧,共 ${frameCount} 张。`),
      transitionLogic: String(raw.transitionLogic ?? '每帧只做小幅镜头推进、裁切、光影或姿态变化。'),
      continuityStrategy: String(raw.continuityStrategy ?? '重复主体身份、材质、场景、光线和构图锚点,避免漂移。')
    };
  }
  return fallbackSmoothAnimation(input, frameCount, motion);
}

function normalizeFrameStills(
  value: unknown,
  storyboard: FramePlan['storyboard'],
  input: CreateTaskInput,
  frameCount: number,
  motion: string
): FramePlan['frameStills'] {
  if (Array.isArray(value) && value.length === frameCount) {
    return value.map((item, index) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        frameIndex: Number.isFinite(Number(raw.frameIndex)) ? Number(raw.frameIndex) : index,
        timeSec: Number.isFinite(Number(raw.timeSec)) ? Number(raw.timeSec) : index,
        stillDescription: String(raw.stillDescription ?? storyboard[index]?.coreFrame ?? input.prompt),
        roleInAnimation: String(raw.roleInAnimation ?? (index === 0 ? '建立动画的主体、空间和光线基准。' : '承接上一秒画面,推动动画继续变化。')),
        visualChange: String(raw.visualChange ?? storyboard[index]?.previousToCurrentChange ?? `${motion} 的第 ${index + 1}/${frameCount} 个定格变化。`)
      };
    });
  }
  return fallbackFrameStills(input, frameCount, motion, storyboard);
}

function normalizeStoryboard(
  value: unknown,
  fallbackPrompts: string[],
  input: CreateTaskInput,
  frameCount: number,
  motion: string
): FramePlan['storyboard'] {
  if (Array.isArray(value) && value.length === frameCount) {
    return value.map((item, index) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const comfyPrompt = String(raw.comfyPrompt ?? fallbackPrompts[index] ?? '');
      return {
        frameIndex: Number.isFinite(Number(raw.frameIndex)) ? Number(raw.frameIndex) : index,
        timeSec: Number.isFinite(Number(raw.timeSec)) ? Number(raw.timeSec) : index,
        coreFrame: String(raw.coreFrame ?? comfyPrompt),
        previousToCurrentChange: String(raw.previousToCurrentChange ?? (index === 0 ? '建立主体、场景和光线基准。' : '在上一帧基础上小幅推进镜头和构图。')),
        cameraState: String(raw.cameraState ?? `${motion} 第 ${index + 1}/${frameCount} 个连续锚点。`),
        subjectState: String(raw.subjectState ?? input.prompt),
        continuityAnchor: String(raw.continuityAnchor ?? '主体身份、材质、场景、光线方向和色彩关系延续到前后帧。'),
        comfyPrompt
      };
    });
  }

  const plan = fallbackPlan(input, frameCount, motion);
  return fallbackPrompts.length === frameCount
    ? plan.storyboard.map((item, index) => ({ ...item, comfyPrompt: fallbackPrompts[index] }))
    : plan.storyboard;
}

function normalizeAgentSkills(value: unknown, input: CreateTaskInput): FramePlan['agentSkills'] {
  if (Array.isArray(value) && value.length > 0) {
    return value.map(item => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        agent: String(raw.agent ?? 'Agent'),
        skill: String(raw.skill ?? 'planning'),
        output: String(raw.output ?? '')
      };
    });
  }
  return fallbackAgentSkills(input);
}

function weakCodexPlanReason(plan: FramePlan, input: CreateTaskInput, frameCount: number): string | null {
  const stills = plan.frameStills.map(item => item.stillDescription);
  const storyboardTexts = plan.storyboard.map(item => [
    item.coreFrame,
    item.previousToCurrentChange,
    item.subjectState,
    item.comfyPrompt
  ].join(' '));
  const frameTexts = stills.map((still, index) => `${still} ${storyboardTexts[index] ?? ''}`);

  const repeatedEndingCount = stills.filter(text => /结束定格/.test(text)).length;
  if (frameCount >= 10 && repeatedEndingCount > frameCount * 0.35) {
    return 'too many repeated ending stills';
  }

  const uniqueStillCount = new Set(stills.map(text => text.replace(/\d+\s*秒/g, '').trim())).size;
  if (frameCount >= 10 && uniqueStillCount < Math.ceil(frameCount * 0.6)) {
    return 'too few unique frame stills';
  }

  const templatePhraseCount = frameTexts.filter(text =>
    /原始用户提示|写清楚主体|主体完整入画|主体轮廓更清晰|只推进镜头运动和构图裁切/.test(text)
  ).length;
  if (frameCount >= 10 && templatePhraseCount > frameCount * 0.45) {
    return 'template phrases dominate the storyboard';
  }

  if (isCatMouseFightPrompt(input.prompt)) {
    const hasCatAndMouseCount = frameTexts.filter(text =>
      /猫|\bcat\b|\btabby\b|\bfeline\b/i.test(text) &&
      /鼠|老鼠|\bmouse\b|\bmice\b|\brodent\b/i.test(text)
    ).length;
    if (hasCatAndMouseCount < Math.ceil(frameCount * 0.85)) {
      return 'cat and mouse are not explicit in enough frames';
    }

    const hasConcreteCatMouseScene = /虎斑|橘|灰褐|线团|木地板|窗光|奶酪|tabby|mouse|yarn|wooden floor/i.test(frameTexts.join(' '));
    if (!hasConcreteCatMouseScene) {
      return 'cat and mouse scene lacks concrete visual anchors';
    }
  }

  return null;
}

/** 从混合输出中提取最大的合法 JSON 对象 */
function extractJson(s: string): string {
  // 优先尝试 ```json ... ``` 代码块
  const m = s.match(/```json\s*([\s\S]*?)```/);
  if (m) return m[1].trim();
  // 否则取首个 { 到末尾 } 的范围(贪婪)
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) return s.slice(i, j + 1);
  throw new Error(`no json in codex output: ${s.slice(0, 400)}`);
}

function extractCodexResult(s: string): { text: string; threadId?: string } {
  let threadId: string | undefined;
  let lastAgentText = '';

  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        thread_id?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        threadId = event.thread_id;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        lastAgentText = event.item.text ?? lastAgentText;
      }
    } catch {
      // Ignore non-JSON warning lines.
    }
  }

  return { text: lastAgentText || s, threadId };
}

// ===== Fallback: 确定性规则切分 =====

const MOTION_BEATS: Record<string, string[]> = {
  zoom_in: [
    '镜头从克制的环境距离缓慢靠近,主体先被空间和光影托住',
    '镜头继续推进,主体轮廓占据画面中心,背景轻微虚化',
    '镜头贴近主体的关键材质和高光,细节开始成为叙事重点',
    '镜头进入品牌级特写,让质感、纹理和边缘反光成为主角',
    '镜头停在最有记忆点的局部,画面干净、稳定、有呼吸感',
    '镜头靠近到微距质感,只保留最核心的触感和光线变化',
    '镜头推至极近的视觉锚点,主体仍保持同一形态和比例',
    '镜头轻轻定格,高光收束,画面留下精致的结束感'
  ],
  zoom_out: [
    '从主体最有识别度的局部特写开始,质感先抓住注意力',
    '镜头慢慢退开,主体完整轮廓逐渐显现,背景仍保持一致',
    '镜头退到舒展的中景,主体与环境关系变得清晰',
    '镜头继续拉远,空间层次打开,主体仍是视觉中心',
    '镜头到达广角全貌,场景氛围和品牌调性一起出现',
    '镜头保留空气感和留白,让画面从细节过渡到整体',
    '镜头稳定在完整构图上,主体与背景形成清晰记忆点',
    '镜头缓慢收尾,光线柔和,画面有余韵'
  ],
  pan_left: [
    '主体从画面右侧自然进入,镜头保持平稳横移',
    '镜头向左滑动,主体轮廓和材质在同一光线下连续展开',
    '主体到达画面中心,构图最稳定,细节最清楚',
    '镜头继续左移,背景视差轻微变化但场景保持一致',
    '主体接近左侧黄金分割点,边缘高光拉出运动感',
    '横移揭示更多同一场景细节,主体仍保持同一形态',
    '镜头接近结束位置,画面节奏放慢',
    '主体停在舒适构图里,横移动作自然收束'
  ],
  pan_right: [
    '主体从画面左侧自然进入,镜头保持平稳横移',
    '镜头向右滑动,主体轮廓和材质在同一光线下连续展开',
    '主体到达画面中心,构图最稳定,细节最清楚',
    '镜头继续右移,背景视差轻微变化但场景保持一致',
    '主体接近右侧黄金分割点,边缘高光拉出运动感',
    '横移揭示更多同一场景细节,主体仍保持同一形态',
    '镜头接近结束位置,画面节奏放慢',
    '主体停在舒适构图里,横移动作自然收束'
  ],
  fade: [
    '画面从柔暗中露出主体轮廓,只让一束光先出现',
    '光线慢慢抬起,主体材质和边缘线条开始变清楚',
    '主体完整显现,背景保持安静,画面像广告片开场',
    '高光达到最稳定的状态,主体成为唯一视觉焦点',
    '画面进入最精致的一刻,光线干净、质感明确',
    '景深变柔,主体仍清晰,氛围开始向结尾过渡',
    '亮度缓慢回落,主体边缘被柔光包住',
    '画面收进安静的暗部,留下清晰的视觉记忆'
  ],
  crossfade: [
    '以原始主体和场景建立第一眼记忆,构图稳定',
    '主体保持不变,只让光线和背景氛围发生轻微转场',
    '新氛围开始叠入,主体仍保持同一外观和位置关系',
    '转场进入中段,两种质感自然融合,没有跳切',
    '新画面风格稳定下来,主体仍是同一个对象',
    '镜头强化新氛围里的主体细节,质感更清楚',
    '转场完成,构图干净,主体和背景关系统一',
    '画面柔和收束,让变化看起来像连续发生'
  ]
};

const FRAME_DETAIL_BEATS = [
  '主体完整入画,明确主体数量、朝向、轮廓比例、所在位置、前景留白、背景层次和主光方向',
  '主体轮廓更清晰,补充可见材质纹理、颜色过渡、边缘高光、接触阴影和背景虚化程度',
  '主体占比增加,强调关键结构、表面细节、局部反射、前景遮挡关系和画面边缘仍可见的环境元素',
  '进入近景,锁定最重要的卖点区域或情绪表情,写清楚焦点位置、景深范围、阴影形状和高光落点',
  '进入特写,描述微观纹理、细小瑕疵或精致细节,说明哪些部分清晰、哪些部分柔化',
  '进一步贴近,画面只保留核心识别元素,明确裁切边界、材质颗粒、反光方向和背景色块',
  '极近画面,将视觉锚点压缩到最有记忆度的局部,保持主体身份可识别且不新增元素',
  '结束定格,描述最终构图、清晰焦点、收束光线、稳定背景和画面余韵'
];

interface FallbackSceneScript {
  continuityAnchor: string;
  frame: (index: number, progress: number) => {
    coreFrame: string;
    initialChange: string;
    change: string;
    cameraState: string;
    subjectState: string;
  };
}

const CAT_MOUSE_ACTION_BEATS = [
  {
    still: '猫伏在画面左侧三分之一处,前爪贴地,耳朵向前; 小老鼠站在画面右侧蓝色线团旁,身体侧向猫,粉色尾巴贴着木地板形成弯弧',
    change: '建立猫在左、老鼠在右、蓝色线团在中右的基准位置,右上方窗光投下同一方向阴影'
  },
  {
    still: '猫的右前爪抬起一点,爪尖还没有落下; 老鼠把一小片奶酪举到胸前,身体后仰半步,仍靠近蓝色线团',
    change: '猫的右前爪比上一秒抬高,老鼠身体略向后仰,线团和光线不变'
  },
  {
    still: '猫向前滑出半个爪掌距离,胡须朝老鼠方向张开; 老鼠向画面右下角侧跳一点,尾巴拖出清晰弧线',
    change: '猫和老鼠的距离缩短,老鼠从线团右侧跳到右下侧,镜头轻微推近'
  },
  {
    still: '猫的爪子拍在老鼠刚才站过的位置,木地板上有小小接触阴影; 老鼠已经绕到线团前方,抬头盯着猫',
    change: '猫爪落点前移,老鼠绕到线团前方,双方仍同框且没有新增动物'
  },
  {
    still: '猫低头靠近线团,鼻尖和胡须清楚; 老鼠抓住线团边缘,像用线团当盾牌一样挡在身体前',
    change: '动作焦点从双方距离转到线团附近,镜头继续按固定方向推进'
  },
  {
    still: '蓝色线团被轻轻推歪,一根线沿木地板延伸; 猫爪停在线团左侧,老鼠躲在线团右后方只露出头和尾巴',
    change: '线团角度轻微滚动,猫爪和老鼠围绕同一个道具调整位置'
  },
  {
    still: '老鼠突然从线团后探出身体,举起奶酪片; 猫睁大眼睛,白色胸口和铜色项圈牌在窗光下更亮',
    change: '老鼠从遮挡后重新露出完整身体,猫的表情更紧张但身份和外观不变'
  },
  {
    still: '猫向右伸出左前爪形成横向拦截姿势; 老鼠压低身体从爪下穿过,粉色尾巴贴近地板',
    change: '猫爪方向从前拍变为横向拦截,老鼠运动轨迹从线团右侧穿到更靠中间'
  },
  {
    still: '猫的身体仍在左侧,肩背形成弓形; 老鼠转身面对猫,双脚站稳,奶酪片像小盾牌一样挡在前面',
    change: '双方从追逐变成短暂停顿对峙,镜头更靠近猫爪和老鼠上半身'
  },
  {
    still: '猫爪轻轻碰到奶酪片边缘,没有伤害; 老鼠被推得后退一小步,蓝色线团仍在它身后',
    change: '猫爪第一次接触老鼠手里的奶酪片,老鼠只后退一点,动作保持非血腥喜剧感'
  },
  {
    still: '老鼠把奶酪片举高,猫的视线被吸引到奶酪上; 木地板的右上窗光把两者影子拉向左下',
    change: '视觉焦点从爪子转到奶酪片,光影方向继续保持右上到左下'
  },
  {
    still: '猫的鼻尖靠近奶酪片,胡须和毛发细节清晰; 老鼠趁机往左侧跨一小步,尾巴绕过线团',
    change: '镜头进入近景,猫鼻尖、老鼠尾巴和线团成为连续细节锚点'
  },
  {
    still: '老鼠从线团左侧探出,像反击一样把奶酪片顶向猫爪; 猫爪微微收回,铜色项圈牌仍可见',
    change: '老鼠开始主动反击,猫爪从伸出变为略收回,但双方位置仍围绕线团'
  },
  {
    still: '猫前爪悬在线团上方,爪垫清楚但不锋利; 老鼠站在线团前方抬头,身体被暖窗光勾出边缘亮线',
    change: '镜头更强调猫爪与老鼠的尺度差,老鼠仍完整可见'
  },
  {
    still: '猫低伏的脸进入更多画面,橘色虎斑纹和白胸口纹理明显; 老鼠在画面右下三分之一处保持防御姿态',
    change: '主体占比继续增加,猫脸更大,老鼠仍固定在同一木地板和线团旁'
  },
  {
    still: '老鼠向右侧快速闪避半步,奶酪片倾斜; 猫爪拍在线团旁边,一小段蓝线被压住',
    change: '老鼠做小幅闪避,猫爪落在线团旁边,只改变局部姿态和道具角度'
  },
  {
    still: '猫的耳朵和眼睛保持警觉,爪子没有继续前压; 老鼠回头看猫,尾巴在木地板上形成 S 形',
    change: '动作节奏放慢,双方从追逐切回对峙,镜头继续稳定推进'
  },
  {
    still: '老鼠站到蓝色线团顶端边缘,显得更勇敢; 猫爪停在线团下方,猫的胡须在浅景深里清楚',
    change: '老鼠位置从地板升到线团边缘,猫爪停住,形成更明确的高度关系'
  },
  {
    still: '猫轻轻拨动线团,线团只转了很小角度; 老鼠用奶酪片保持平衡,粉色尾巴翘起',
    change: '线团有轻微旋转,老鼠尾巴抬起,背景和光源保持完全一致'
  },
  {
    still: '镜头靠近到猫爪、线团和老鼠占据画面中央; 猫脸在左上方浅虚化,老鼠身体和奶酪片最清楚',
    change: '焦点从猫整体转移到猫爪和老鼠,景深更浅但双主体仍可识别'
  },
  {
    still: '老鼠从线团上跳下半步,落在猫爪前方; 猫爪停在空中,像被老鼠的动作打断',
    change: '老鼠从线团边缘回到木地板,猫爪悬停,画面进入收束前的动作停顿'
  },
  {
    still: '猫的爪垫和老鼠的小爪子在画面中形成大小对比; 奶酪片夹在两者之间,边缘被窗光照亮',
    change: '镜头把尺度对比作为重点,猫爪、老鼠和奶酪片形成稳定三角构图'
  },
  {
    still: '老鼠把奶酪片向前一推,猫爪略向后退; 猫眼仍看着老鼠,没有出现攻击伤害',
    change: '老鼠完成一次小反击,猫爪后退一点,喜剧式冲突更明确'
  },
  {
    still: '猫和老鼠同时停住,木地板上两道阴影方向一致; 蓝色线团靠在老鼠身后,一根线延伸到猫爪旁',
    change: '运动开始减速,双方停顿,线团、阴影和构图关系稳定下来'
  },
  {
    still: '近景里猫的白胸口、铜色项圈牌、橘色虎斑毛和老鼠灰褐色绒毛都清楚; 老鼠仍举着奶酪片',
    change: '镜头进入最终近景,强调材质细节,不改变双方身份和数量'
  },
  {
    still: '猫爪停在老鼠前方一小段距离,没有接触; 老鼠身体微微前倾,像赢下这一回合',
    change: '最终动作从打闹转为停手对峙,猫爪与老鼠之间保留清楚间距'
  },
  {
    still: '窗光在猫爪边缘形成柔亮高光,老鼠的粉色尾巴和奶酪片仍在画面右下可见',
    change: '光影成为收束重点,镜头只再推进一点,画面更稳定'
  },
  {
    still: '猫的脸在左侧近景里略微柔化,猫爪和老鼠保持清晰; 蓝色线团作为背景锚点没有移动',
    change: '景深更浅,焦点锁在猫爪与老鼠,背景道具固定不跳'
  },
  {
    still: '老鼠把奶酪片举到最高点,像小小胜利姿势; 猫爪停住,猫眼看向奶酪片,气氛从打架变成滑稽停顿',
    change: '老鼠姿态更有记忆点,猫动作完全收住,结尾情绪明确'
  },
  {
    still: '最终定格: 一只橘色虎斑猫的前爪停在画面左下,一只灰褐色小老鼠站在右下举着奶酪片,蓝色线团在两者之间,同一束右上方暖窗光照亮木地板',
    change: '最终帧只做稳定定格和高光收束,猫、老鼠、线团、木地板和窗光全部保持同一套设定'
  }
];

function fallbackSceneScript(input: CreateTaskInput, frameCount: number, motion: string): FallbackSceneScript | null {
  if (!isCatMouseFightPrompt(input.prompt)) return null;

  const subjectState =
    '固定双主体: exactly one ginger tabby house cat with white chest and copper tag collar; exactly one small gray-brown mouse with pink tail; mouse is much smaller than cat; no humans; no extra cats; no extra mice';
  const continuityAnchor =
    '同一只橘色虎斑家猫,同一只灰褐色小老鼠,同一间室内客厅,同一块浅棕木地板,同一个翻倒的蓝色线团,同一束来自右上方的暖窗光,同一组柔和阴影';

  return {
    continuityAnchor,
    frame: (index, progress) => {
      const action = pickProgressItem(CAT_MOUSE_ACTION_BEATS, progress);
      const cameraState = catMouseCameraState(motion, index, frameCount, progress);
      const coreFrame = [
        '写实动物动作摄影',
        '一只橘色虎斑家猫,白色胸口,戴铜色小圆牌项圈',
        '一只灰褐色小老鼠,粉色尾巴,体型明显比猫小',
        '猫和老鼠必须同时出现在同一画面,动作是非血腥的喜剧式打闹',
        '同一间室内客厅,浅棕色窄木地板,翻倒的蓝色线团,右上方暖窗光',
        `第 ${index} 秒定格: ${action.still}`,
        `构图要求: ${catMouseComposition(progress)}`,
        '猫毛、老鼠绒毛、木地板纹理、接触阴影、边缘高光都要清楚'
      ].join('; ');
      return {
        coreFrame,
        initialChange: action.change,
        change: action.change,
        cameraState,
        subjectState
      };
    }
  };
}

function catMouseCameraState(motion: string, index: number, frameCount: number, progress: number): string {
  const percent = Math.round(progress * 100);
  const label = motionEnglish(motion);
  if (motion === 'zoom_out') {
    return `${label} 的第 ${index + 1}/${frameCount} 个连续锚点: 从猫爪和老鼠的近景缓慢退到能看清线团与木地板的中景,当前退开进度 ${percent}%, 镜头高度保持贴近地板`;
  }
  if (motion === 'pan_left' || motion === 'pan_right') {
    return `${label} 的第 ${index + 1}/${frameCount} 个连续锚点: 镜头沿木地板平稳横移,猫鼠始终同框,当前横移进度 ${percent}%, 不改变场景和光源方向`;
  }
  if (motion === 'fade' || motion === 'crossfade') {
    return `${label} 的第 ${index + 1}/${frameCount} 个连续锚点: 只让亮度和景深轻微变化,猫鼠、线团和木地板位置保持连续,当前过渡进度 ${percent}%`;
  }
  return `slow zoom-in 的第 ${index + 1}/${frameCount} 个连续锚点: 从客厅木地板中景缓慢推向猫爪、老鼠和蓝色线团的近景,当前推进 ${percent}%, 镜头高度贴近地板,运动幅度小且顺滑`;
}

function catMouseComposition(progress: number): string {
  if (progress < 0.2) return '中全景,猫在左侧占画面约 45%,老鼠在右侧占画面约 10%,蓝色线团在两者之间,留出木地板前景';
  if (progress < 0.55) return '中近景,猫爪和猫脸占左半画面,老鼠和线团占右下区域,双方距离清楚,背景轻微虚化';
  if (progress < 0.85) return '近景,猫爪、线团、老鼠和奶酪片形成稳定三角构图,猫脸可在左上或左侧浅虚化';
  return '收束近景,焦点落在猫爪前方的小老鼠和奶酪片,猫的白胸口或铜色项圈牌仍作为身份锚点可见';
}

function isCatMouseFightPrompt(prompt: string): boolean {
  const hasCat = /猫|\bcat\b|\bcats\b|\btabby\b|\bfeline\b/i.test(prompt);
  const hasMouse = /鼠|老鼠|田鼠|\bmouse\b|\bmice\b|\brat\b|\brodent\b/i.test(prompt);
  const hasConflict = /打架|搏斗|争斗|冲突|战斗|追逐|fight|fighting|battle|chase/i.test(prompt);
  return hasCat && hasMouse && hasConflict;
}

function pickProgressItem<T>(items: T[], progress: number): T {
  const clamped = Math.max(0, Math.min(1, progress));
  const index = Math.min(items.length - 1, Math.floor(clamped * items.length));
  return items[index];
}

function fallbackPlan(input: CreateTaskInput, frameCount: number, motion: string): FramePlan {
  const beats = MOTION_BEATS[motion] ?? MOTION_BEATS.zoom_in;
  const scene = fallbackSceneScript(input, frameCount, motion);
  const consistencyPrefix =
    scene?.continuityAnchor ??
    '同一个主体,同一外观和材质,同一场景,同一光线,连续镜头,主体身份和背景不能改变';
  const referenceCount = input.reference_image_paths?.length ?? (input.reference_image_path ? 1 : 0);
  const referencePrefix = referenceCount > 0
    ? `参考已上传的 ${referenceCount} 张图片,以第 1 张为主锚定图,综合其余参考图补充主体细节、颜色、材质、构图关系和光线方向`
    : '';
  const tone = process.env.VIDEO_COPY_TONE?.trim() || '高级广告片,自然导演语言,克制但有画面感';
  const styleSuffix = (() => {
    switch (input.style) {
      case 'product_photography':
        return isLikelyProductPrompt(input.prompt)
          ? '商业产品摄影,棚拍控光,干净背景,高质感反射,边缘高光清晰,适合电商主视觉'
          : '写实电影感动作摄影,真实环境,主体动态清晰,自然光影,不要电商棚拍和商品摆拍';
      case 'cyberpunk':
        return '赛博朋克霓虹,湿润反光材质,未来都市氛围,高对比光影,冷暖色交错';
      case 'cartoon':
        return '高级卡通插画,干净线条,明确色块,轻微体积光,画面友好但不幼稚';
      case 'cinematic':
        return '电影级构图,浅景深,柔和体积光,镜头语言克制,有品牌短片质感';
      case 'anime':
        return '日系动画电影感,赛璐璐着色,细腻光影,高饱和但不过曝,背景层次清楚';
      case 'realistic':
        return '写实摄影,自然光,真实材质,细腻皮肤或物体纹理,镜头可信';
      default: return '';
    }
  })();

  const storyboard: FramePlan['storyboard'] = [];
  for (let i = 0; i < frameCount; i++) {
    const progress = frameCount <= 1 ? 1 : i / (frameCount - 1);
    const beat = pickProgressItem(beats, progress);
    const detailBeat = pickProgressItem(FRAME_DETAIL_BEATS, progress);
    const sceneBeat = scene?.frame(i, progress);
    const prevChange = i === 0
      ? (sceneBeat?.initialChange ?? '这是第一帧,先建立主体、空间、光线和画面基准')
      : (sceneBeat?.change ?? `相对上一帧只推进镜头运动和构图裁切,主体身份、材质、颜色、场景和光源方向不变`);
    const coreFrame = sceneBeat?.coreFrame ??
      `${englishSubjectHint(input.prompt)}${input.prompt}; ${detailBeat}; 写清楚主体在画面中的大小比例、朝向、边缘轮廓、主要颜色、可见材质、前景/中景/背景关系、光源方向、阴影和高光`;
    const cameraState = sceneBeat?.cameraState ?? `${beat}; ${motion} 的第 ${i + 1}/${frameCount} 个连续锚点,镜头运动幅度小且顺滑`;
    const subjectState = sceneBeat?.subjectState ?? `主体仍是“${input.prompt}”,不新增无关物体,不改变身份、数量、材质、服装/包装或核心外观`;
    const continuityAnchor = `${consistencyPrefix}; 前一帧与后一帧共享同一主体轮廓、同一背景空间、同一主光方向和同一色彩关系`;
    const comfyPrompt = [
      referencePrefix,
      consistencyPrefix,
      `核心画面细节: ${coreFrame}`,
      `帧间变化: ${prevChange}`,
      `镜头设计: ${cameraState}`,
      `主体状态: ${subjectState}`,
      `连续性锚点: ${continuityAnchor}`,
      styleSuffix ? `视觉风格: ${styleSuffix}` : '',
      `文案气质: ${tone}`,
      '构图稳定,主体清晰,背景不抢戏,无文字水印,不要省略主体细节,不要新增不相关物体'
    ].filter(Boolean).join(', ');
    storyboard.push({
      frameIndex: i,
      timeSec: i,
      coreFrame,
      previousToCurrentChange: prevChange,
      cameraState,
      subjectState,
      continuityAnchor,
      comfyPrompt
    });
  }
  const framePrompts = storyboard.map(item => item.comfyPrompt);

  return {
    overallPlan: fallbackOverallPlan(input, frameCount, motion),
    animationDescription: fallbackAnimationDescription(input, frameCount, motion),
    smoothAnimation: fallbackSmoothAnimation(input, frameCount, motion),
    storyboard,
    frameStills: fallbackFrameStills(input, frameCount, motion, storyboard),
    agentSkills: fallbackAgentSkills(input),
    framePrompts,
    negativePrompt:
      process.env.WAN_NEGATIVE ||
      (isCatMouseFightPrompt(input.prompt)
        ? '低分辨率, 模糊, 水印, 文字, logo错乱, 畸形, 解剖错误, 主体漂移, 背景突变, 构图跳变, 噪点, 多出第二只猫, 多出第二只老鼠, 缺少猫, 缺少老鼠, 老鼠变成猫, 猫变成老鼠, 人物, 人像, 血腥, 受伤'
        : '低分辨率, 模糊, 水印, 文字, logo错乱, 畸形, 解剖错误, 多手指, 主体漂移, 背景突变, 构图跳变, 噪点'),
    notes: `已启用 Creative Director / Storyboard / Image Prompt / Animation / Copy Polish / Continuity Reviewer agents · ${frameCount} 帧 · ${motion}${referenceCount > 0 ? ` · ${referenceCount} 张参考图约束` : ''}${input.style ? ` · ${input.style}` : ''}`,
    source: 'fallback'
  };
}

function fallbackGenerationTranslation(input: Parameters<typeof translatePlanForGeneration>[0]): GenerationPromptTranslation {
  return {
    videoPrompt: englishVideoFallback(input),
    framePrompts: input.framePrompts.map((prompt, index) => englishFrameFallback(prompt, input, index)),
    negativePrompt: englishNegativeFallback(input.negativePrompt, input),
    source: 'fallback'
  };
}

function englishVideoFallback(input: Parameters<typeof translatePlanForGeneration>[0]): string {
  return [
    `A smooth ${input.duration}-second short video animation generated from the user's concept.`,
    `Original concept: ${stripCjkIfPossible(input.userPrompt) || input.userPrompt}.`,
    `Motion: ${input.motion}; style: ${input.style ?? 'realistic visual style'}; ${input.fps} fps.`,
    'Keep the same subject identity, materials, color palette, lighting direction, scene layout, and camera continuity throughout the whole video.',
    'One keyframe per second, each frame should connect naturally to the previous and next frame.'
  ].join(' ');
}

function englishFrameFallback(
  prompt: string,
  input: Parameters<typeof translatePlanForGeneration>[0],
  index: number
): string {
  const subjectHints = englishSubjectHint(`${input.userPrompt} ${prompt}`);
  const motion = motionEnglish(input.motion);
  const style = styleEnglish(input.style);
  return [
    subjectHints || 'clear main subject, visually consistent subject identity',
    `frame ${index + 1} of ${input.framePrompts.length}, time ${index}s`,
    `original visual description to preserve: ${prompt}`,
    `continuous ${motion} camera movement, only small changes from the previous frame`,
    style,
    'same subject, same material, same outfit or packaging, same background space, same lighting direction, same color palette',
    'detailed composition, foreground midground background relationship, clear edges, realistic lighting, shadows, highlights, depth of field',
    'no text, no watermark, no extra unrelated objects, no sudden background change'
  ].filter(Boolean).join(', ');
}

function englishNegativeFallback(value: string | undefined, input: Parameters<typeof translatePlanForGeneration>[0]): string {
  return sanitizeNegativePrompt([
    value,
    'low resolution, blurry, watermark, text, malformed logo, bad anatomy, extra limbs, extra fingers, subject drift, identity change, background jump, composition jump, noise, duplicate subjects, unrelated people, unrelated objects'
  ].filter(Boolean).join(', '), input);
}

function sanitizeNegativePrompt(
  value: string,
  input: Parameters<typeof translatePlanForGeneration>[0]
): string {
  const context = [
    input.userPrompt,
    JSON.stringify(input.overallPlan ?? ''),
    JSON.stringify(input.smoothAnimation ?? ''),
    JSON.stringify(input.storyboard ?? ''),
    input.framePrompts.join(' ')
  ].join(' ');
  const hasCat = /猫|\bcat\b|\bcats\b|\btabby\b|\bfeline\b/i.test(context);
  const hasMouse = /鼠|老鼠|田鼠|\bmouse\b|\bmice\b|\brat\b|\brodent\b/i.test(context);
  const hasAnimal = hasCat || hasMouse || /狗|犬|猴|猿|\bdog\b|\bdogs\b|\bmonkey\b|\bmonkeys\b/i.test(context);

  let cleaned = value;
  if (hasAnimal) {
    cleaned = cleaned
      .replace(/\bpeople or animals appearing\b/gi, 'unrelated extra people')
      .replace(/\banimals appearing\b/gi, 'unrelated extra animals')
      .replace(/\banimal\b(?!\s+(anatomy|action|photography|subject|subjects|pair|species))/gi, 'unrelated animal');
  }
  if (hasCat && hasMouse) {
    cleaned = [
      cleaned,
      'missing mouse',
      'missing cat',
      'second cat',
      'second mouse',
      'mouse transformed into cat',
      'cat transformed into mouse',
      'two cats instead of cat and mouse',
      'two mice instead of cat and mouse'
    ].join(', ');
  }
  return dedupe(cleaned.split(',')).join(', ');
}

function stripCjkIfPossible(value: string): string {
  return /[\u3400-\u9fff]/.test(value) ? '' : value;
}

function motionEnglish(motion: string): string {
  const labels: Record<string, string> = {
    zoom_in: 'slow zoom-in',
    zoom_out: 'slow zoom-out',
    pan_left: 'smooth pan left',
    pan_right: 'smooth pan right',
    fade: 'soft fade',
    crossfade: 'smooth crossfade'
  };
  return labels[motion] ?? motion;
}

function styleEnglish(style?: string | null): string {
  const labels: Record<string, string> = {
    product_photography: 'commercial product photography, clean controlled lighting, premium material detail',
    cinematic: 'cinematic composition, shallow depth of field, soft volumetric light',
    realistic: 'realistic photography, natural light, true-to-life materials',
    cartoon: 'high-quality stylized cartoon illustration, clean shapes, readable composition',
    anime: 'anime film style, clean cel shading, detailed background layers',
    cyberpunk: 'cyberpunk neon atmosphere, reflective wet surfaces, high contrast lighting'
  };
  return style ? labels[style] ?? style : '';
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function fallbackOverallPlan(input: CreateTaskInput, frameCount: number, motion: string): FramePlan['overallPlan'] {
  const referenceCount = input.reference_image_paths?.length ?? (input.reference_image_path ? 1 : 0);
  if (isCatMouseFightPrompt(input.prompt)) {
    return {
      concept: `把“${input.prompt}”明确拍成一支 ${input.duration}s 的写实连续动物动作短片: 一只橘色虎斑家猫和一只灰褐色小老鼠在同一间客厅木地板上发生非血腥、偏动画喜剧感的追逐扭打。观众始终能看清猫比老鼠大很多,两者一直在同一画面内互动。`,
      visualStyle: `${input.style ?? 'realistic'} 风格,真实动物摄影质感,猫毛、老鼠绒毛、木地板反光和窗光阴影清楚,画面不出现人物、不出现文字、不切换场景。`,
      cameraLanguage: `${motion} 镜头语言,${frameCount} 张每秒定格从全景逐步推到近景,只改变镜头距离、裁切和猫鼠局部姿态,不换主体、不换背景、不把老鼠画成第二只猫。`,
      continuityRules: '每一帧都固定为一只橘色虎斑猫、一只灰褐色小老鼠、同一块浅棕木地板、同一只翻倒的蓝色线团、同一束右上方暖窗光; 猫的白胸口和铜色项圈牌、老鼠的粉色尾巴必须持续可见。',
      referenceUsage: referenceCount > 0
        ? `使用 ${referenceCount} 张参考图作为外观锚点,但仍保持“一只猫 + 一只小老鼠”的双主体关系,不要扩展成多只动物。`
        : '无参考图时,直接用文字锚定主体: 橘色虎斑猫、灰褐色小老鼠、客厅木地板、右上方暖窗光。'
    };
  }
  return {
    concept: `围绕“${input.prompt}”做一支 ${input.duration}s 的连续短视频,先建立主体记忆,再通过镜头运动强化质感和情绪。`,
    visualStyle: `${input.style ?? 'default'} 风格,画面干净,主体明确,光影和材质服务于同一个视觉卖点。`,
    cameraLanguage: `${motion} 镜头语言,按每秒 1 张关键帧拆成 ${frameCount} 个连续视觉锚点,节奏从建立画面到细节强化再到收束。`,
    continuityRules: '所有关键帧保持同一个主体、同一外观材质、同一场景、同一光线方向和一致的构图关系,只改变镜头距离、角度、局部姿态或运动节奏。',
    referenceUsage: referenceCount > 0
      ? `使用 ${referenceCount} 张参考图作为主体与材质锚点,第 1 张为主参考,其余参考只补充细节,不生成多个并列主体。`
      : '无参考图时,以用户提示词建立主体锚点,后续帧通过重复主体描述保持一致性。'
  };
}

function fallbackAnimationDescription(input: CreateTaskInput, frameCount: number, motion: string): string {
  if (isCatMouseFightPrompt(input.prompt)) {
    return `这是一段 ${input.duration}s 的连续写实动物动作短片: 开场在客厅木地板上建立一只橘色虎斑猫和一只灰褐色小老鼠的空间关系,猫伏低身体从画面左侧盯着右前方的小老鼠,老鼠背靠翻倒的蓝色线团做防御姿态; 中段镜头按 ${motion} 缓慢推进,猫伸爪、老鼠侧跳、两者围着同一个线团转圈,动作像喜剧式打闹而不是血腥搏斗; 后段镜头进入近景,重点落在猫的白胸口、铜色项圈牌、猫爪旁的小老鼠和木地板上的细小阴影,最后定格在猫爪停在老鼠前方、老鼠举起一小片奶酪反击的清晰画面。整段始终是同一只猫、同一只老鼠、同一客厅、同一束右上方窗光,看起来像一支连续镜头里的 ${frameCount} 个动作定格。`;
  }
  return `这是一段 ${input.duration}s 的连续动画: 画面从“${input.prompt}”的完整主体和环境基准开始,先让观众看清主体、背景和主光方向; 随后镜头按 ${motion} 的运动方式每秒推进一个很小的视觉变化,主体的外观、材质、颜色、场景和光源保持同一套设定,只改变镜头距离、裁切、局部高光和画面重心; 中段逐步把注意力引到主体最重要的材质、轮廓或情绪卖点; 结尾停在一个稳定、清晰、有记忆点的定格画面,让整段视频看起来像同一支顺滑镜头里的 ${frameCount} 个连续定格,而不是 ${frameCount} 张无关图片。`;
}

function fallbackSmoothAnimation(input: CreateTaskInput, frameCount: number, motion: string): FramePlan['smoothAnimation'] {
  if (isCatMouseFightPrompt(input.prompt)) {
    return {
      durationSeconds: input.duration,
      summary: `把“${input.prompt}”拆成 ${frameCount} 张连续动作定格: 猫和老鼠围绕同一个蓝色线团发生追逐、试探、扑爪、闪躲和定格反击,全程保持双主体同框。`,
      motionArc: `${motion} 作为主运动,镜头从能看清客厅木地板和双方距离的中全景,逐秒推进到猫爪与老鼠表情的近景; 每秒只推进一个小动作,避免跳切。`,
      timing: `0-${Math.max(1, Math.floor(frameCount * 0.2))} 秒建立猫鼠、线团、木地板和窗光; 中段让猫伸爪、老鼠闪躲、双方绕线团对峙; 最后 2-3 秒收束到猫爪停住、老鼠举奶酪反击的记忆点。`,
      transitionLogic: '每一帧都继承上一帧的猫鼠位置关系和光线方向,只改变爪子高度、老鼠跳跃方向、尾巴弧线、线团滚动角度或镜头裁切。不要突然换场景、换动物数量、换成肖像照或抽象海报。',
      continuityStrategy: '每条 Wan 提示词重复: exactly one ginger tabby cat, exactly one small gray-brown mouse, same living room wooden floor, same blue yarn ball, warm window light from upper right, no humans, no text。'
    };
  }
  return {
    durationSeconds: input.duration,
    summary: `把用户描述“${input.prompt}”扩写成一段 ${input.duration}s 的丝滑短动画: 先用首帧建立主体、空间和光线基准,随后按每秒 1 帧连续推进镜头,最后以稳定、清晰的视觉锚点收束。`,
    motionArc: `${motion} 作为主运动,所有帧只做小幅、可插值的镜头距离/角度/裁切/光影变化,让 Wan 生成的关键帧能首尾串联。`,
    timing: `共 ${frameCount} 张关键帧,第 0 秒建立画面,中段逐步强化主体细节和情绪,最后 1-2 秒收束到最有记忆点的画面。`,
    transitionLogic: '每一帧都继承上一帧的主体、场景和光线,只推进一个明确变化点,避免跳切、换主体、换背景或突然新增元素。',
    continuityStrategy: '在每条 Wan 提示词中重复主体身份、材质、主要颜色、构图位置、主光方向、背景关系和前后帧连续性锚点。'
  };
}

function fallbackFrameStills(
  input: CreateTaskInput,
  frameCount: number,
  motion: string,
  storyboard?: FramePlan['storyboard']
): FramePlan['frameStills'] {
  return Array.from({ length: frameCount }, (_, index) => {
    const progress = frameCount <= 1 ? 1 : index / (frameCount - 1);
    const phase = progress < 0.2
      ? '开场建立'
      : progress < 0.7
        ? '中段推进'
        : '结尾收束';
    return {
      frameIndex: index,
      timeSec: index,
      stillDescription:
        storyboard?.[index]?.coreFrame ??
        `第 ${index + 1} 秒的定格画面: “${input.prompt}”仍是同一个主体,处在同一场景和同一光线下; 画面根据 ${motion} 的运动节奏推进到 ${Math.round(progress * 100)}% 的位置,主体比例、裁切和高光比上一秒略有变化,但身份、材质、颜色和背景关系不改变。`,
      roleInAnimation: `${phase}: 这一帧负责${index === 0 ? '建立观众对主体、空间和光线的第一眼记忆' : progress > 0.85 ? '把运动收束到最终记忆点' : '承接上一帧并继续推动镜头运动'},让整段 ${input.duration}s 动画保持连续。`,
      visualChange:
        storyboard?.[index]?.previousToCurrentChange ??
        (index === 0
          ? '第一帧不做突变,只建立主体、空间、材质和光线基准。'
          : `相对第 ${index} 秒,只让镜头位置和画面裁切推进一小步,主体身份和背景不变。`)
    };
  });
}

function isLikelyProductPrompt(prompt: string): boolean {
  return /产品|商品|包装|香水|瓶|饮料|罐|盒|手机|耳机|键盘|鼠标|鞋|衣服|夹克|美妆|护肤|口红|手表|首饰|无人机/.test(prompt);
}

function englishSubjectHint(prompt: string): string {
  const parts: string[] = [];
  const add = (condition: boolean, value: string) => {
    if (condition) parts.push(value);
  };
  const hasCat = /猫|\bcat\b|\bcats\b|\btabby\b|\bfeline\b/i.test(prompt);
  const hasMouse = /鼠|老鼠|田鼠|\bmouse\b|\bmice\b|\brat\b|\brodent\b/i.test(prompt);
  if (hasCat && hasMouse) {
    parts.push(
      'English visual anchor: exactly one ginger tabby cat with white chest and copper tag collar',
      'exactly one small gray-brown mouse with pink tail',
      'cat and mouse in the same frame, mouse much smaller than cat',
      'playful non-violent fight, no humans'
    );
  }
  add(/[狗犬]/.test(prompt), 'English visual anchor: dogs');
  add(/猴|猿/.test(prompt), 'monkeys');
  add(/群殴|打架|搏斗|争斗|冲突|战斗/.test(prompt) && !(hasCat && hasMouse), 'non-graphic chaotic group fight, dynamic action');
  add(/森林|丛林|树|草地|野外/.test(prompt), 'outdoor natural environment');
  add(/产品|商品|包装|香水|瓶|饮料|罐|盒/.test(prompt), 'product hero shot');
  return parts.length ? `${parts.join(', ')}; 原始用户提示: ` : '';
}

function fallbackAgentSkills(input: CreateTaskInput): FramePlan['agentSkills'] {
  const skills: FramePlan['agentSkills'] = [
    {
      agent: 'Creative Director Agent',
      skill: '概念与视觉卖点提炼',
      output: `把“${input.prompt}”收敛为一个清晰主体、一种核心情绪和一条可连续推进的视觉主线。`
    },
    {
      agent: 'Storyboard Agent',
      skill: '镜头起承转合拆解',
      output: '把总规划拆成连续关键帧,让每帧都是上一帧的自然推进,避免跳切。'
    },
    {
      agent: 'Image Prompt Agent',
      skill: '图像生成提示词细化',
      output: '补足主体、构图、光影、材质、色彩、景深和镜头焦段,让提示词可直接给 Wan 使用。'
    },
    {
      agent: 'Animation Agent',
      skill: '运动节奏约束',
      output: `把 ${input.motion_type ?? '镜头运动'} 转译成每帧的镜头距离、角度、微动作和转场连续性。`
    },
    {
      agent: 'Continuity Reviewer Agent',
      skill: '主体一致性审查',
      output: '检查每帧都重复主体身份、材质、光线和场景约束,降低换脸、换物、背景漂移。'
    }
  ];
  if (input.style === 'product_photography' || /商品|产品|包装|品牌|电商|香水|饮品|服装/.test(input.prompt)) {
    skills.push({
      agent: 'Copy Polish Agent',
      skill: '商业短视频表达润色',
      output: '把画面描述改成更像广告片/电商主视觉的导演语言,突出质感、卖点和可读性。'
    });
  }
  return skills;
}
