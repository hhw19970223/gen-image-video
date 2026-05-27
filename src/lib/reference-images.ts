import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, toServeUrl } from './paths';

export function parseReferenceImagePaths(value: string | null | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }
  } catch {
    // Backward compatibility: old tasks store a single absolute path.
  }
  return [trimmed];
}

export function encodeReferenceImagePaths(paths: string[]): string | null {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] : JSON.stringify(unique);
}

export function referenceImageUrls(value: string | null | undefined): string[] {
  return parseReferenceImagePaths(value)
    .filter(p => fs.existsSync(p) && fs.statSync(p).isFile())
    .map(toServeUrl);
}

export function validateReferenceImagePaths(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const abs = path.resolve(item);
    const relative = path.relative(DATA_DIR, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    paths.push(abs);
  }
  return Array.from(new Set(paths)).slice(0, 6);
}
