'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CodexMessageRow, CodexSessionRow } from '@/lib/types';

type LocalAttachment = { id: string; name: string; size: number; type: string; path?: string };
type ChatMessage = CodexMessageRow & { attachments?: LocalAttachment[] };

interface Props {
  initialActive: CodexSessionRow;
  initialMessages: CodexMessageRow[];
  codexConfigured: boolean;
}

const SUGGESTIONS: { title: string; subtitle: string; prompt: string }[] = [
  {
    title: '策划一段商品视频',
    subtitle: '从一句话扩成完整视频规划',
    prompt: '帮我策划一支 6 秒的商品视频:产品是冷调香水,目标平台小红书,风格电影感。给出概念、视觉风格、镜头语言和动画描述。'
  },
  {
    title: '把描述变成动画规划',
    subtitle: '导演级镜头 + 节奏 + 连续性',
    prompt: '把下面这段描述改写成一份可以直接交给 Wan 的动画规划,明确开场、运动、转场、结尾:\n一只柴犬在窗台上看雪'
  },
  {
    title: '审阅 prompt',
    subtitle: '指出歧义和容易跑偏的地方',
    prompt: '帮我审一下这条 prompt,挑出可能让模型走偏的措辞,并给出改写建议:\n一个人在街上跑'
  },
  {
    title: '生成 6 个分镜方向',
    subtitle: '同一主题、不同节奏',
    prompt: '基于"夏日雨后第一缕阳光照进窗台"这个主题,给我 6 个不同节奏和镜头语言的分镜方向。'
  }
];

export default function CodexChatView({ initialActive, initialMessages, codexConfigured }: Props) {
  const [active, setActive] = useState(initialActive);
  const [messages, setMessages] = useState<ChatMessage[]>(parseInitial(initialMessages));
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(260, Math.max(48, el.scrollHeight))}px`;
  }, [input]);

  const filePreviews = useMemo(() => files.map(file => ({
    file,
    isImage: file.type.startsWith('image/'),
    url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null
  })), [files]);
  useEffect(() => () => filePreviews.forEach(p => p.url && URL.revokeObjectURL(p.url)), [filePreviews]);

  async function commitRename(id: string, title: string) {
    if (!title.trim()) return;
    const res = await fetch('/api/codex-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', id, title: title.trim() })
    });
    const data = await res.json();
    if (res.ok && data.active) setActive(data.active);
  }

  async function commitTitleDraft() {
    if (titleDraft === null) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (!next || next === active.title) return;
    await commitRename(active.id, next);
  }

  async function send(textOverride?: string) {
    const message = (textOverride ?? input).trim();
    if ((!message && files.length === 0) || busy) return;
    const sendingFiles = files;
    if (!textOverride) setInput('');
    setFiles([]);
    setBusy(true);
    setError(null);
    const optimistic: ChatMessage = {
      id: `pending_${Date.now()}`,
      session_id: active.id,
      task_id: null,
      role: 'user',
      kind: 'chat',
      content: JSON.stringify({ text: message }),
      codex_thread_id: active.codex_thread_id,
      created_at: new Date().toISOString(),
      attachments: sendingFiles.map(file => ({
        id: `${file.name}_${file.lastModified}_${file.size}`,
        name: file.name,
        size: file.size,
        type: file.type
      }))
    };
    setMessages(prev => [...prev, optimistic]);
    try {
      const res = sendingFiles.length > 0
        ? await sendMultipart(message, sendingFiles)
        : await fetch('/api/codex-chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: active.id, message })
        });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '发送失败');
      if (data.active) setActive(data.active);
      setMessages(parseInitial(data.messages ?? []));
    } catch (e) {
      setError((e as Error).message);
      setFiles(sendingFiles);
      setMessages(prev => prev.filter(m => m.id !== optimistic.id));
    } finally {
      setBusy(false);
    }
  }

  function sendMultipart(message: string, sendingFiles: File[]) {
    const form = new FormData();
    form.set('sessionId', active.id);
    form.set('message', message);
    for (const file of sendingFiles) form.append('files', file);
    return fetch('/api/codex-chat', { method: 'POST', body: form });
  }

  function removeFile(index: number) {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }

  function copyText(text: string) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => undefined);
  }

  function quoteMessage(msg: ChatMessage) {
    const text = extractPlainText(msg);
    const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
    setInput(prev => (prev ? `${quoted}\n\n${prev}` : `${quoted}\n\n`));
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }

  const messageCount = messages.length;
  const lastActivity = messages[messages.length - 1]?.created_at ?? active.updated_at;
  const canSend = !busy && (input.trim().length > 0 || files.length > 0);

  return (
    <section className="codex-shell">
      <div className="codex-panel">
        <header className="codex-panel-head">
          <div className="codex-head-title">
            {titleDraft !== null ? (
              <input
                autoFocus
                className="codex-head-title-input"
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={commitTitleDraft}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitTitleDraft();
                  if (e.key === 'Escape') setTitleDraft(null);
                }}
              />
            ) : (
              <h2 onDoubleClick={() => setTitleDraft(active.title)} title="双击改名">{active.title}</h2>
            )}
            <div className="codex-head-meta">
              <span className={`thread-chip ${active.codex_thread_id ? 'is-bound' : 'is-pending'}`}>
                <span className="thread-dot" aria-hidden />
                {active.codex_thread_id ? '已绑定 Codex thread' : '等待首次调用'}
              </span>
              {active.codex_thread_id ? (
                <code className="thread-id mono" title={active.codex_thread_id} onClick={() => copyText(active.codex_thread_id!)}>
                  {truncateMid(active.codex_thread_id)}
                </code>
              ) : null}
              <span className="codex-head-stat mono">{messageCount} 条 · 更新于 {formatRelative(lastActivity)}</span>
              {!codexConfigured ? (
                <span className="codex-head-warn mono">CODEX_BIN 未配置</span>
              ) : null}
            </div>
          </div>
        </header>

        <div className="codex-messages" ref={scrollerRef}>
          {messages.length === 0 ? (
            <EmptyState onPick={(text) => { setInput(text); setTimeout(() => textareaRef.current?.focus(), 0); }} />
          ) : (
            messages.map(message => (
              <MessageBlock
                key={message.id}
                message={message}
                onCopy={copyText}
                onQuote={quoteMessage}
              />
            ))
          )}
          {busy ? (
            <div className="codex-thinking">
              <span className="dot-pulse" aria-hidden><span /><span /><span /></span>
              Codex 正在思考...
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="codex-error" role="alert">
            <span>⚠</span>
            <span>{error}</span>
            <button className="icon-btn" aria-label="关闭" onClick={() => setError(null)}>✕</button>
          </div>
        ) : null}

        <footer className="codex-input">
          <div className={`codex-composer${busy ? ' is-busy' : ''}`}>
            {filePreviews.length > 0 ? (
              <div className="codex-composer-attachments">
                {filePreviews.map((p, index) => (
                  <div className="codex-attachment-chip" key={`${p.file.name}_${p.file.lastModified}_${p.file.size}`}>
                    {p.isImage && p.url ? (
                      <img src={p.url} alt={p.file.name} />
                    ) : (
                      <span className="codex-attachment-icon" aria-hidden>📄</span>
                    )}
                    <span className="codex-attachment-name">{p.file.name}</span>
                    <span className="codex-attachment-size mono">{formatBytes(p.file.size)}</span>
                    <button type="button" className="icon-btn" aria-label="移除" onClick={() => removeFile(index)} disabled={busy}>✕</button>
                  </div>
                ))}
              </div>
            ) : null}

            <textarea
              ref={textareaRef}
              className="codex-composer-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={codexConfigured ? '与 Codex 对话 — 支持 Markdown · ⌘/Ctrl + Enter 发送' : 'CODEX_BIN 未配置 — 配置后可继续对话'}
              rows={1}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={busy}
            />

            <div className="codex-composer-bar">
              <div className="codex-composer-bar-left">
                <label className={`codex-composer-attach${busy ? ' is-disabled' : ''}`} title="上传图片或文件">
                  <AttachIcon />
                  <input
                    type="file"
                    multiple
                    disabled={busy}
                    onChange={e => {
                      const next = Array.from(e.target.files ?? []);
                      setFiles(prev => [...prev, ...next].slice(0, 6));
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                <span className="codex-composer-hint mono">支持 Markdown · 拖入或上传图片</span>
              </div>
              <button
                type="button"
                className={`codex-composer-send${canSend ? ' is-ready' : ''}`}
                onClick={() => send()}
                disabled={!canSend}
                aria-label="发送"
              >
                {busy ? (
                  <span className="dot-pulse" aria-hidden><span /><span /><span /></span>
                ) : (
                  <>
                    <span>发送</span>
                    <kbd className="mono">⌘⏎</kbd>
                  </>
                )}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </section>
  );
}

// ============== Message renderers ==============

function MessageBlock({ message, onCopy, onQuote }: {
  message: ChatMessage;
  onCopy: (text: string) => void;
  onQuote: (msg: ChatMessage) => void;
}) {
  const role = message.role;
  const kind = message.kind;
  const plain = extractPlainText(message);
  return (
    <article className={`codex-msg is-${role} kind-${kind}`}>
      <header className="codex-msg-head">
        <span className={`codex-msg-avatar avatar-${role}`} aria-hidden>{role === 'user' ? '你' : role === 'assistant' ? 'C' : '!'}</span>
        <span className="codex-msg-author">{roleLabel(role)}</span>
        {kind !== 'chat' ? <span className={`codex-kind-tag kind-${kind}`}>{kindLabel(kind)}</span> : null}
        <time className="codex-msg-time mono" title={message.created_at}>{formatTime(message.created_at)}</time>
        <div className="codex-msg-actions">
          <button className="icon-btn" title="复制" onClick={() => onCopy(plain)}>⧉</button>
          <button className="icon-btn" title="引用" onClick={() => onQuote(message)}>↩</button>
        </div>
      </header>
      <div className="codex-msg-body">
        {kind === 'plan' && role === 'assistant' ? <PlanCard raw={message.content} />
          : kind === 'translation' && role === 'assistant' ? <TranslationCard raw={message.content} />
          : kind === 'error' ? <div className="codex-error-inline">{plain}</div>
          : <ChatBubble text={plain} />
        }
        {message.attachments && message.attachments.length > 0 ? (
          <UserAttachments items={message.attachments} />
        ) : null}
      </div>
    </article>
  );
}

function ChatBubble({ text }: { text: string }) {
  return (
    <div className="codex-bubble">
      <div className="codex-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
            code: ({ node, className, children, ...props }) => {
              const isBlock = /\n/.test(String(children ?? ''));
              if (isBlock) {
                return (
                  <pre className="codex-md-pre">
                    <code className={`mono ${className ?? ''}`} {...props}>{children}</code>
                  </pre>
                );
              }
              return <code className={`mono ${className ?? ''}`} {...props}>{children}</code>;
            },
            table: ({ node, ...props }) => (
              <div className="codex-md-table-wrap">
                <table {...props} />
              </div>
            )
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function UserAttachments({ items }: { items: LocalAttachment[] }) {
  return (
    <div className="codex-msg-attachments">
      {items.map(file => {
        const isImage = file.type.startsWith('image/');
        const src = file.path ? `/api/files/${encodeFsPath(file.path)}` : null;
        return (
          <div className="codex-msg-attachment" key={file.id}>
            {isImage && src ? (
              <img src={src} alt={file.name} />
            ) : (
              <span className="codex-attachment-icon" aria-hidden>📄</span>
            )}
            <div>
              <div className="codex-attachment-name">{file.name}</div>
              <div className="codex-attachment-size mono">{formatBytes(file.size)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlanCard({ raw }: { raw: string }) {
  const parsed = useMemo(() => safeParsePlan(raw), [raw]);
  if (!parsed) return <ChatBubble text={raw} />;
  return (
    <div className="codex-plan">
      {parsed.overallPlan ? (
        <div className="codex-plan-grid">
          {parsed.overallPlan.concept ? <PlanField label="概念" value={parsed.overallPlan.concept} /> : null}
          {parsed.overallPlan.visualStyle ? <PlanField label="视觉风格" value={parsed.overallPlan.visualStyle} /> : null}
          {parsed.overallPlan.cameraLanguage ? <PlanField label="镜头语言" value={parsed.overallPlan.cameraLanguage} /> : null}
          {parsed.overallPlan.continuityRules ? <PlanField label="连续性约束" value={parsed.overallPlan.continuityRules} /> : null}
          {parsed.overallPlan.referenceUsage ? <PlanField label="参考图使用" value={parsed.overallPlan.referenceUsage} /> : null}
        </div>
      ) : null}
      {parsed.animationDescription ? (
        <div className="codex-plan-block">
          <div className="codex-plan-block-label">动画描述</div>
          <div className="codex-plan-block-body">{parsed.animationDescription}</div>
        </div>
      ) : null}
      {parsed.smoothAnimation ? (
        <div className="codex-plan-block">
          <div className="codex-plan-block-label">运动节奏</div>
          <dl className="codex-plan-dl">
            {parsed.smoothAnimation.summary ? <><dt>概述</dt><dd>{parsed.smoothAnimation.summary}</dd></> : null}
            {parsed.smoothAnimation.motionArc ? <><dt>运动弧线</dt><dd>{parsed.smoothAnimation.motionArc}</dd></> : null}
            {parsed.smoothAnimation.timing ? <><dt>时序</dt><dd>{parsed.smoothAnimation.timing}</dd></> : null}
            {parsed.smoothAnimation.transitionLogic ? <><dt>转场逻辑</dt><dd>{parsed.smoothAnimation.transitionLogic}</dd></> : null}
            {parsed.smoothAnimation.continuityStrategy ? <><dt>连续策略</dt><dd>{parsed.smoothAnimation.continuityStrategy}</dd></> : null}
          </dl>
        </div>
      ) : null}
      {parsed.negativePrompt ? (
        <div className="codex-plan-block is-negative">
          <div className="codex-plan-block-label">Negative</div>
          <div className="codex-plan-block-body mono">{parsed.negativePrompt}</div>
        </div>
      ) : null}
      {parsed.notes ? (
        <div className="codex-plan-notes">{parsed.notes}</div>
      ) : null}
    </div>
  );
}

function PlanField({ label, value }: { label: string; value: string }) {
  return (
    <div className="codex-plan-field">
      <div className="codex-plan-field-label">{label}</div>
      <div className="codex-plan-field-body">{value}</div>
    </div>
  );
}

function TranslationCard({ raw }: { raw: string }) {
  const parsed = useMemo(() => safeParseTranslation(raw), [raw]);
  if (!parsed) return <ChatBubble text={raw} />;
  return (
    <div className="codex-translation">
      {parsed.videoPrompt ? (
        <div className="codex-tr-block">
          <div className="codex-tr-label">video prompt</div>
          <div className="codex-tr-body mono">{parsed.videoPrompt}</div>
        </div>
      ) : null}
      {parsed.framePrompts && parsed.framePrompts.length > 0 ? (
        <div className="codex-tr-block">
          <div className="codex-tr-label">frame prompts ({parsed.framePrompts.length})</div>
          <ol className="codex-tr-frames">
            {parsed.framePrompts.map((p, i) => (
              <li key={i} className="mono">{p}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {parsed.negativePrompt ? (
        <div className="codex-tr-block is-negative">
          <div className="codex-tr-label">negative</div>
          <div className="codex-tr-body mono">{parsed.negativePrompt}</div>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="codex-empty-shell">
      <div className="codex-empty-head">
        <h3>这是和 Codex CLI 的会话</h3>
        <p>用来策划视频、翻译 prompt、迭代分镜。所有上下文由 Codex CLI 的 thread 保存,跨刷新可继续。</p>
      </div>
      <div className="codex-empty-grid">
        {SUGGESTIONS.map(s => (
          <button key={s.title} className="codex-empty-card" onClick={() => onPick(s.prompt)}>
            <span className="codex-empty-card-title">{s.title}</span>
            <span className="codex-empty-card-sub">{s.subtitle}</span>
            <span className="codex-empty-card-cta">使用 →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AttachIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

// ============== helpers ==============

function parseInitial(rows: CodexMessageRow[]): ChatMessage[] {
  return rows.map(row => {
    if (row.role === 'user' && row.kind === 'chat') {
      try {
        const parsed = JSON.parse(row.content) as { text?: string; attachments?: LocalAttachment[] };
        if (parsed && typeof parsed === 'object' && (parsed.text !== undefined || parsed.attachments)) {
          return { ...row, attachments: parsed.attachments ?? [] };
        }
      } catch { /* fallthrough */ }
    }
    return row;
  });
}

function extractPlainText(msg: ChatMessage): string {
  if (msg.role === 'user' && msg.kind === 'chat') {
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') return parsed.text;
    } catch { /* fallthrough */ }
  }
  if (msg.kind === 'plan' || msg.kind === 'translation') {
    return msg.content;
  }
  return msg.content;
}

function safeParsePlan(raw: string): {
  overallPlan?: { concept?: string; visualStyle?: string; cameraLanguage?: string; continuityRules?: string; referenceUsage?: string };
  animationDescription?: string;
  smoothAnimation?: { summary?: string; motionArc?: string; timing?: string; transitionLogic?: string; continuityStrategy?: string };
  negativePrompt?: string;
  notes?: string;
} | null {
  const json = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') return parsed as ReturnType<typeof safeParsePlan>;
  } catch { /* fallthrough */ }
  return null;
}

function safeParseTranslation(raw: string): {
  videoPrompt?: string;
  framePrompts?: string[];
  negativePrompt?: string;
} | null {
  const json = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') return parsed as ReturnType<typeof safeParseTranslation>;
  } catch { /* fallthrough */ }
  return null;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) return fenced[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return trimmed;
}

function roleLabel(role: CodexMessageRow['role']) {
  if (role === 'assistant') return 'Codex';
  if (role === 'user') return '你';
  return '系统';
}

function kindLabel(kind: CodexMessageRow['kind']) {
  const map: Record<CodexMessageRow['kind'], string> = {
    plan: '规划',
    translation: '提示词',
    chat: '对话',
    error: '错误',
    note: '备注'
  };
  return map[kind] ?? kind;
}

function formatTime(value: string) {
  const d = new Date(value);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatRelative(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 24 * 3600_000) return `${Math.floor(diff / (24 * 3600_000))} 天前`;
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function truncateMid(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function encodeFsPath(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/');
}
