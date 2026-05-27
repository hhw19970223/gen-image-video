import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { fromServeRel } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json'
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await params;
  const rel = parts.map(decodeURIComponent).join('/');
  const abs = fromServeRel(rel);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return new Response('not found', { status: 404 });
  }
  const ext = path.extname(abs).toLowerCase();
  const stat = fs.statSync(abs);
  const ifNoneMatch = req.headers.get('if-none-match');
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  // mp4 / webm: support Range
  const range = req.headers.get('range');
  if (range && (ext === '.mp4' || ext === '.webm')) {
    const m = /bytes=(\d+)-(\d+)?/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(abs, { start, end });
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
          'content-length': String(chunkSize),
          'content-type': MIME[ext] || 'application/octet-stream',
          etag
        }
      });
    }
  }

  return new Response(fs.createReadStream(abs) as unknown as ReadableStream, {
    headers: {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': String(stat.size),
      'accept-ranges': 'bytes',
      etag,
      'cache-control': 'public, max-age=300'
    }
  });
}
