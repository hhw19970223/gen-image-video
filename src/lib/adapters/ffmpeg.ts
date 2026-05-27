// FFmpeg 视频合成适配器
//
// MVP 实现:把 N 张关键帧按 motion 类型合成为 mp4
//   默认使用稳定静态段 + xfade 交叉溶解。
//   不在每张关键帧上单独做 zoompan,避免相邻段叠加时产生漂移/抖动。
//
// 预留 RIFE 插帧接口 (process.env.RIFE_ENABLED=true 时尝试调用,失败降级)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MotionType } from '../types';

export interface ComposeInput {
  framePaths: string[]; // sorted by frame_index
  outPath: string;
  width: number;
  height: number;
  fps: number;
  duration: number; // seconds
  motion: MotionType;
}

export interface ComposeResult {
  outPath: string;
  durationMs: number;
  segments: number;
  rifeUsed: boolean;
}

export interface ExtractFramesInput {
  videoPath: string;
  outDir: string;
  frameCount: number;
  width: number;
  height: number;
  duration: number;
}

export interface TranscodeVideoInput {
  inputPath: string;
  outPath: string;
}

const FFMPEG_BIN = resolveFfmpegBin();

function resolveFfmpegBin(): string {
  const configured = process.env.FFMPEG_BIN?.trim();
  if (configured) return configured;

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', exe);
  if (fs.existsSync(bundled)) return bundled;

  return 'ffmpeg';
}

export async function composeVideo(input: ComposeInput): Promise<ComposeResult> {
  const t0 = Date.now();
  if (input.framePaths.length === 0) throw new Error('no frames to compose');
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });

  const args = buildFfmpegArgs(input);
  await runFfmpeg(args);

  return {
    outPath: input.outPath,
    durationMs: Date.now() - t0,
    segments: input.framePaths.length,
    rifeUsed: false
  };
}

function buildFfmpegArgs(input: ComposeInput): string[] {
  const { framePaths, outPath, width, height, fps, duration } = input;
  const N = framePaths.length;
  const perFrame = duration / N; // 每帧持续秒数(单镜头 + 转场)

  // 输入: 每张关键帧作为静态图片 input
  const inputArgs: string[] = [];
  for (const p of framePaths) {
    inputArgs.push('-loop', '1', '-t', String(perFrame.toFixed(3)), '-i', p);
  }

  // filter_complex: 每张图生成一段稳定静态视频,然后用 xfade 链接。
  const filters: string[] = [];
  for (let i = 0; i < N; i++) {
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `trim=duration=${perFrame.toFixed(3)},setpts=PTS-STARTPTS,` +
      `setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
  }

  // 链式 xfade: v0 + v1 -> x1; x1 + v2 -> x2; ...
  // 用 fade 做真正的交叉溶解；fadeblack 会在每段之间插入黑场。
  const xfade = 'fade';
  const xfadeDur = Math.min(0.6, perFrame * 0.4);
  let lastTag = `v0`;
  let cumOffset = perFrame - xfadeDur;
  for (let i = 1; i < N; i++) {
    const out = i === N - 1 ? 'vout' : `x${i}`;
    filters.push(
      `[${lastTag}][v${i}]xfade=transition=${xfade}:duration=${xfadeDur.toFixed(3)}:offset=${cumOffset.toFixed(3)}[${out}]`
    );
    lastTag = out;
    cumOffset += perFrame - xfadeDur;
  }
  if (N === 1) filters.push(`[v0]copy[vout]`);

  return [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-preset',
    'medium',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    '-t',
    String(duration.toFixed(3)),
    outPath
  ];
}

function zoompanExpr(
  motion: MotionType,
  frames: number,
  fps: number,
  width: number,
  height: number,
  i: number,
  N: number
): string {
  const D = frames;
  const size = `${width}x${height}`;
  const intensity = readMotionIntensity();
  const zoomRate = +(0.0024 * intensity).toFixed(5);
  const zoomOutStart = +(1 + 0.32 * intensity).toFixed(3);
  const panZoom = +(1 + 0.18 * intensity).toFixed(3);
  const drift = +(0.02 * intensity).toFixed(4);
  switch (motion) {
    case 'zoom_in':
      return `zoompan=z='min(1.45,zoom+${zoomRate})':d=${D}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)-(on/${D})*ih*${drift}':s=${size}:fps=${fps}`;
    case 'zoom_out':
      return `zoompan=z='if(eq(on,1),${zoomOutStart},max(1.02,zoom-${zoomRate}))':d=${D}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+(on/${D})*ih*${drift}':s=${size}:fps=${fps}`;
    case 'pan_left':
      return `zoompan=z='${panZoom}':d=${D}:x='iw - (on/${D})*(iw - iw/${panZoom})':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`;
    case 'pan_right':
      return `zoompan=z='${panZoom}':d=${D}:x='(on/${D})*(iw - iw/${panZoom})':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`;
    case 'fade':
      return `zoompan=z='min(1.16,zoom+${(zoomRate / 3).toFixed(5)})':d=${D}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps},fade=in:0:${Math.min(18, Math.floor(D / 3))}`;
    case 'crossfade':
    default:
      return `zoompan=z='min(1.12,zoom+${(zoomRate / 4).toFixed(5)})':d=${D}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`;
  }
}

function readMotionIntensity(): number {
  const parsed = Number.parseFloat(process.env.FFMPEG_MOTION_INTENSITY ?? '');
  if (!Number.isFinite(parsed)) return 1.35;
  return Math.max(0.2, Math.min(3, parsed));
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1200)}`));
    });
  });
}

/** 用 ffmpeg 抓第一帧作为视频封面 */
export async function extractCover(videoPath: string, coverPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(coverPath), { recursive: true });
  await runFfmpeg(['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', coverPath]);
}

/** 从已生成的视频里按时间均匀抽出关键帧,用于前端图册展示。 */
export async function extractFramesFromVideo(input: ExtractFramesInput): Promise<string[]> {
  if (input.frameCount <= 0) return [];
  fs.mkdirSync(input.outDir, { recursive: true });
  const outPattern = path.join(input.outDir, 'frame_%03d.png');
  const fps = input.frameCount / Math.max(0.001, input.duration);
  await runFfmpeg([
    '-y',
    '-i',
    input.videoPath,
    '-vf',
    `fps=${fps.toFixed(6)},scale=${input.width}:${input.height}:force_original_aspect_ratio=increase,crop=${input.width}:${input.height}`,
    '-frames:v',
    String(input.frameCount),
    outPattern
  ]);
  return Array.from({ length: input.frameCount }, (_, index) =>
    path.join(input.outDir, `frame_${String(index + 1).padStart(3, '0')}.png`)
  ).filter(p => fs.existsSync(p));
}

/** Normalize a ComfyUI video output to browser-friendly mp4 when needed. */
export async function transcodeVideoToMp4(input: TranscodeVideoInput): Promise<void> {
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  await runFfmpeg([
    '-y',
    '-i',
    input.inputPath,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    input.outPath
  ]);
}

/** 检查 FFmpeg 是否可用 */
export async function checkFfmpeg(): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG_BIN, ['-version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => resolve({ ok: false }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false });
      const m = out.match(/ffmpeg version ([\w.\-+]+)/);
      resolve({ ok: true, version: m?.[1] });
    });
  });
}
