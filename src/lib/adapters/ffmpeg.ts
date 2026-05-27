import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logError, logInfo, stepTimer } from '../logger';
import type { MotionType } from '../types';

export interface ComposeInput {
  framePaths: string[];
  outPath: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
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
  fps?: number;
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
  const timer = stepTimer('ffmpeg', 'composeVideo', {
    outPath: input.outPath,
    frameCount: input.framePaths.length,
    width: input.width,
    height: input.height,
    fps: input.fps,
    duration: input.duration,
    motion: input.motion
  });

  try {
    if (input.framePaths.length === 0) throw new Error('no frames to compose');
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true });

    const args = buildFfmpegArgs(input);
    await runFfmpeg(args, {
      operation: 'composeVideo',
      outPath: input.outPath,
      frameCount: input.framePaths.length
    });

    const stat = fs.existsSync(input.outPath) ? fs.statSync(input.outPath) : null;
    const durationMs = Date.now() - t0;
    timer.done({ outPath: input.outPath, durationMs, bytes: stat?.size ?? null });

    return {
      outPath: input.outPath,
      durationMs,
      segments: input.framePaths.length,
      rifeUsed: false
    };
  } catch (error) {
    timer.fail(error, { outPath: input.outPath });
    throw error;
  }
}

function buildFfmpegArgs(input: ComposeInput): string[] {
  const { framePaths, outPath, width, height, fps, duration } = input;
  const N = framePaths.length;
  const perFrame = duration / N;

  const inputArgs: string[] = [];
  for (const p of framePaths) {
    inputArgs.push('-loop', '1', '-t', String(perFrame.toFixed(3)), '-i', p);
  }

  const filters: string[] = [];
  for (let i = 0; i < N; i++) {
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `trim=duration=${perFrame.toFixed(3)},setpts=PTS-STARTPTS,` +
      `setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
  }

  const xfade = 'fade';
  const xfadeDur = Math.min(0.6, perFrame * 0.4);
  let lastTag = 'v0';
  let cumOffset = perFrame - xfadeDur;
  for (let i = 1; i < N; i++) {
    const out = i === N - 1 ? 'vout' : `x${i}`;
    filters.push(
      `[${lastTag}][v${i}]xfade=transition=${xfade}:duration=${xfadeDur.toFixed(3)}:offset=${cumOffset.toFixed(3)}[${out}]`
    );
    lastTag = out;
    cumOffset += perFrame - xfadeDur;
  }
  if (N === 1) filters.push('[v0]copy[vout]');

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

function runFfmpeg(args: string[], meta: Record<string, unknown> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    logInfo('ffmpeg', 'process.spawn', {
      bin: FFMPEG_BIN,
      argsCount: args.length,
      output: args[args.length - 1],
      ...meta
    });

    const child = spawn(FFMPEG_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', error => {
      logError('ffmpeg', 'process.spawnError', error, meta);
      reject(error);
    });
    child.on('close', code => {
      const elapsedMs = Date.now() - startedAt;
      if (code === 0) {
        logInfo('ffmpeg', 'process.done', { code, elapsedMs, ...meta });
        return resolve();
      }

      const error = new Error(`ffmpeg exited ${code}: ${err.slice(-1200)}`);
      logError('ffmpeg', 'process.failed', error, {
        code,
        elapsedMs,
        stderrTail: err.slice(-4000),
        ...meta
      });
      reject(error);
    });
  });
}

export async function extractCover(videoPath: string, coverPath: string): Promise<void> {
  const timer = stepTimer('ffmpeg', 'extractCover', { videoPath, coverPath });
  try {
    fs.mkdirSync(path.dirname(coverPath), { recursive: true });
    await runFfmpeg(['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', coverPath], {
      operation: 'extractCover',
      videoPath,
      coverPath
    });
    const stat = fs.existsSync(coverPath) ? fs.statSync(coverPath) : null;
    timer.done({ coverPath, bytes: stat?.size ?? null });
  } catch (error) {
    timer.fail(error, { videoPath, coverPath });
    throw error;
  }
}

export async function extractFramesFromVideo(input: ExtractFramesInput): Promise<string[]> {
  const timer = stepTimer('ffmpeg', 'extractFramesFromVideo', {
    videoPath: input.videoPath,
    outDir: input.outDir,
    frameCount: input.frameCount,
    width: input.width,
    height: input.height,
    duration: input.duration
  });

  try {
    if (input.frameCount <= 0) {
      timer.done({ extractedFrames: 0, reason: 'frameCount <= 0' });
      return [];
    }
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
    ], {
      operation: 'extractFramesFromVideo',
      videoPath: input.videoPath,
      outDir: input.outDir,
      expectedFrames: input.frameCount
    });

    const frames = Array.from({ length: input.frameCount }, (_, index) =>
      path.join(input.outDir, `frame_${String(index + 1).padStart(3, '0')}.png`)
    ).filter(p => fs.existsSync(p));
    timer.done({ extractedFrames: frames.length, expectedFrames: input.frameCount });
    return frames;
  } catch (error) {
    timer.fail(error, { videoPath: input.videoPath, outDir: input.outDir });
    throw error;
  }
}

export async function transcodeVideoToMp4(input: TranscodeVideoInput): Promise<void> {
  const timer = stepTimer('ffmpeg', 'transcodeVideoToMp4', {
    inputPath: input.inputPath,
    outPath: input.outPath
  });
  try {
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
    const args = [
      '-y',
      '-i',
      input.inputPath,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ...(input.fps ? ['-r', String(input.fps)] : []),
      '-movflags',
      '+faststart',
      input.outPath
    ];
    await runFfmpeg(args, { operation: 'transcodeVideoToMp4', inputPath: input.inputPath, outPath: input.outPath, fps: input.fps ?? null });
    const stat = fs.existsSync(input.outPath) ? fs.statSync(input.outPath) : null;
    timer.done({ outPath: input.outPath, bytes: stat?.size ?? null });
  } catch (error) {
    timer.fail(error, {
      inputPath: input.inputPath,
      outPath: input.outPath
    });
    throw error;
  }
}

export async function checkFfmpeg(): Promise<{ ok: boolean; version?: string }> {
  const timer = stepTimer('ffmpeg', 'checkFfmpeg', { bin: FFMPEG_BIN });
  return new Promise(resolve => {
    const child = spawn(FFMPEG_BIN, ['-version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', error => {
      timer.fail(error);
      resolve({ ok: false });
    });
    child.on('close', code => {
      if (code !== 0) {
        timer.done({ ok: false, code });
        return resolve({ ok: false });
      }
      const m = out.match(/ffmpeg version ([\w.\-+]+)/);
      timer.done({ ok: true, version: m?.[1] });
      resolve({ ok: true, version: m?.[1] });
    });
  });
}
