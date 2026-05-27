import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { ensureDirs, UPLOADS_DIR, toServeUrl } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export async function POST(req: NextRequest) {
  ensureDirs();
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: '需要 multipart/form-data' }, { status: 400 });
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 });
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: `不支持的类型: ${file.type}` }, { status: 400 });
  }
  if (file.size > 12 * 1024 * 1024) {
    return NextResponse.json({ error: '文件超过 12MB' }, { status: 400 });
  }
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'png';
  const name = `${nanoid(12)}.${ext}`;
  const dst = path.join(UPLOADS_DIR, name);
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(dst, buf);
  return NextResponse.json({ path: dst, url: toServeUrl(dst), name: file.name, size: file.size });
}
