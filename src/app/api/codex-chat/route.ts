import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { sendCodexChat } from '@/lib/adapters/codex';
import { ensureDirs, UPLOADS_DIR } from '@/lib/paths';
import {
  activateCodexSession,
  getActiveCodexSession,
  getCodexSession,
  listCodexMessages,
  renameCodexSession
} from '@/lib/repo';
import type { ChatAttachment } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CHAT_FILES = 6;
const MAX_CHAT_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_CHAT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') || undefined;
  const active = sessionId ? activateCodexSession(sessionId) ?? getActiveCodexSession() : getActiveCodexSession();
  return NextResponse.json({
    active,
    messages: listCodexMessages(active.id)
  });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  const body = contentType.includes('multipart/form-data')
    ? await parseMultipartChat(req).catch(error => ({ error: (error as Error).message }))
    : await req.json().catch(() => null) as { message?: string; sessionId?: string; action?: string; title?: string; id?: string } | null;
  if (!body) return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  if ('error' in body) return NextResponse.json({ error: body.error }, { status: 400 });

  const action = 'action' in body ? body.action : undefined;
  if (action === 'rename') {
    const id = 'id' in body ? body.id : undefined;
    const title = 'title' in body ? body.title : undefined;
    if (!id || !title) return NextResponse.json({ error: '缺少 id 或 title' }, { status: 400 });
    const session = renameCodexSession(id, title);
    if (!session) return NextResponse.json({ error: '会话不存在' }, { status: 404 });
    return NextResponse.json({ active: session, messages: listCodexMessages(session.id) });
  }

  const message = body.message?.trim();
  const attachments = 'attachments' in body ? body.attachments : [];
  if (!message && attachments.length === 0) return NextResponse.json({ error: '消息或附件不能为空' }, { status: 400 });

  const result = await sendCodexChat({ message: message ?? '', sessionId: body.sessionId, attachments });
  const active = getCodexSession(result.sessionId) ?? getActiveCodexSession();
  return NextResponse.json({
    result,
    active,
    messages: listCodexMessages(active.id)
  });
}

async function parseMultipartChat(req: NextRequest): Promise<{ message?: string; sessionId?: string; attachments: ChatAttachment[] } | null> {
  ensureDirs();
  const form = await req.formData().catch(() => null);
  if (!form) return null;

  const files = form.getAll('files').filter((item): item is File => item instanceof File).slice(0, MAX_CHAT_FILES);
  const attachments: ChatAttachment[] = [];
  for (const file of files) {
    if (file.size > MAX_CHAT_FILE_SIZE) {
      throw new Error(`${file.name} 超过 25MB`);
    }
    if (!isAllowedChatFile(file)) {
      throw new Error(`不支持的文件类型: ${file.type || path.extname(file.name) || file.name}`);
    }
    attachments.push(await saveChatAttachment(file));
  }

  return {
    message: valueToString(form.get('message')),
    sessionId: valueToString(form.get('sessionId')),
    attachments
  };
}

function valueToString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isAllowedChatFile(file: File): boolean {
  if (ALLOWED_CHAT_TYPES.has(file.type)) return true;
  return ['.md', '.txt', '.csv', '.json', '.pdf'].includes(path.extname(file.name).toLowerCase());
}

async function saveChatAttachment(file: File): Promise<ChatAttachment> {
  const originalExt = path.extname(file.name).toLowerCase();
  const ext = originalExt && originalExt.length <= 12 ? originalExt : extensionFromType(file.type);
  const id = `att_${nanoid(12)}`;
  const filename = `${id}${ext}`;
  const dst = path.join(UPLOADS_DIR, 'chat', filename);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(dst, buffer);

  return {
    id,
    name: file.name,
    type: file.type || mimeFromExt(ext),
    size: file.size,
    path: dst
  };
}

function extensionFromType(type: string): string {
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/gif') return '.gif';
  if (type === 'application/pdf') return '.pdf';
  if (type === 'application/json') return '.json';
  if (type === 'text/csv') return '.csv';
  return '.txt';
}

function mimeFromExt(ext: string): string {
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.md') return 'text/markdown';
  return 'text/plain';
}
