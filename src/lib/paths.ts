import path from 'node:path';
import fs from 'node:fs';

const ROOT = process.cwd();
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? './data');
export const STORAGE_DIR = path.join(DATA_DIR, 'storage');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const DB_PATH = path.join(DATA_DIR, 'frame.db');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

export function ensureDirs(): void {
  for (const d of [DATA_DIR, STORAGE_DIR, CACHE_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function taskDir(taskId: string): string {
  const d = path.join(STORAGE_DIR, taskId);
  fs.mkdirSync(path.join(d, 'keyframes'), { recursive: true });
  fs.mkdirSync(path.join(d, 'motion'), { recursive: true });
  fs.mkdirSync(path.join(d, 'thumbs'), { recursive: true });
  return d;
}

export function cacheFile(cacheKey: string, ext: string): string {
  // shard by first 2 hex chars
  const shard = cacheKey.slice(0, 2);
  const dir = path.join(CACHE_DIR, shard);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${cacheKey}.${ext}`);
}

/** Convert an absolute path on disk to a project-relative URL the API can serve. */
export function toServeUrl(absPath: string): string {
  const rel = path.relative(DATA_DIR, absPath).replace(/\\/g, '/');
  return `/api/files/${rel}`;
}

/** Resolve a project-relative path back into an absolute file path inside DATA_DIR. */
export function fromServeRel(rel: string): string | null {
  const abs = path.resolve(DATA_DIR, rel);
  // prevent path traversal
  const relative = path.relative(DATA_DIR, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return abs;
}
