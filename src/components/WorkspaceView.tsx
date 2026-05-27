'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FullTaskPayload, SerializedChat, SerializedTask } from '@/lib/api-types';

type FullTask = FullTaskPayload;
type Snapshot = FullTaskPayload;
type ChatMsg = SerializedChat;
type ProgressEntry = {
  id: string;
  ts: number;
  title: string;
  detail?: string;
  progress?: number;
  tone?: 'active' | 'done' | 'error' | 'muted';
};

const STAGE_LABEL: Record<string, string> = {
  pending: '排队中',
  planning: '规划中',
  generating_keyframes: '生成视频',
  generating_motion: '生成视频',
  composing_video: '处理视频',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

export default function WorkspaceView({
  initial,
  sidebarTasks
}: {
  initial: FullTask;
  sidebarTasks: SerializedTask[];
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [liveProgress, setLiveProgress] = useState<ProgressEntry[]>([]);

  // SSE 订阅
  useEffect(() => {
    const es = new EventSource(`/api/video-tasks/${initial.task.id}/stream`);
    const onMsg = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.snapshot) setSnapshot(data.snapshot);
        const entry = progressEntryFromEvent(data);
        if (entry) setLiveProgress(prev => appendProgressEntry(prev, entry));
      } catch {
        /* */
      }
    };
    es.addEventListener('snapshot', (ev) => {
      try {
        setSnapshot(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* */
      }
    });
    es.addEventListener('status', onMsg);
    es.addEventListener('progress', onMsg);
    es.addEventListener('frame', onMsg);
    es.addEventListener('completed', (ev) => {
      onMsg(ev);
    });
    es.addEventListener('failed', onMsg);
    es.onerror = () => {
      // auto-reconnect by browser; do nothing
    };
    return () => es.close();
  }, [initial.task.id]);

  const task = snapshot.task;
  const progressEntries = useMemo(
    () => buildProgressEntries(snapshot, liveProgress),
    [snapshot, liveProgress]
  );
  const onRetry = useCallback(async () => {
    const r = await fetch(`/api/video-tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' })
    });
    if (r.ok) setSnapshot((await r.json()) as Snapshot);
  }, [task.id]);

  const onCancelTask = useCallback(async () => {
    if (!window.confirm('确定取消这个任务吗？正在生成的视频进程会被标记中断。')) return;
    const r = await fetch(`/api/video-tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' })
    });
    if (r.ok) {
      setSnapshot((await r.json()) as Snapshot);
      return;
    }
    const j = await r.json().catch(() => ({}));
    alert((j as { error?: string }).error || '取消任务失败');
  }, [task.id]);

  const goPreview = () => router.push(`/preview/${task.id}`);

  return (
    <div className="ws-shell">
      {/* === Left: task sidebar === */}
      <aside className="ws-side">
        <div className="ws-side-head">
          <h3>任务</h3>
          <Link href="/" className="btn btn-sm btn-ghost">＋ 新建</Link>
        </div>
        <div className="ws-task-list">
          {sidebarTasks.map((t) => (
            <Link
              key={t.id}
              href={t.status === 'completed' ? `/preview/${t.id}` : `/workspace/${t.id}`}
              className={`ws-task-row${t.id === task.id ? ' is-active' : ''}`}
            >
              <div className="ws-task-thumb">
                {t.cover_url ? <img src={t.cover_url} alt="" /> : null}
              </div>
              <div className="ws-task-info">
                <div className="ws-task-title-row">
                  <div className="ws-task-title">{t.prompt.slice(0, 36)}</div>
                  <span className={`badge ws-task-status ${badgeClass(t.status)}`}>
                    <span className="badge-dot" />{STAGE_LABEL[t.status]}
                  </span>
                </div>
                <div className="ws-task-meta">
                  <span>{t.aspect_ratio} · {t.duration}s · {t.fps}fps</span>
                  <span className="tab-num">{t.progress}%</span>
                </div>
                {isCancellableStatus(t.status) ? (
                  <div className="ws-task-progress">
                    <div style={{ width: `${t.progress}%` }} />
                  </div>
                ) : null}
                <div className="ws-task-stage">{t.stage_message ?? STAGE_LABEL[t.status]}</div>
              </div>
            </Link>
          ))}
        </div>

      </aside>

      {/* === Middle: chat stream === */}
      <section className="ws-mid">
        <div className="ws-mid-head">
          <h3>{task.prompt.slice(0, 70)}</h3>
          <span className={`badge ${badgeClass(task.status)}`}>
            <span className="badge-dot" />{STAGE_LABEL[task.status]}
          </span>
          {task.status === 'failed' && (
            <button className="btn btn-sm" onClick={onRetry}>重试</button>
          )}
          {isCancellableStatus(task.status) && (
            <button className="btn btn-sm btn-danger" onClick={onCancelTask}>取消任务</button>
          )}
          {task.status === 'completed' && task.video_url && (
            <button className="btn btn-sm btn-accent" onClick={goPreview}>预览视频 →</button>
          )}
        </div>

        <div className="ws-status-row">
          <div className="progress-track" style={{ flex: 1 }}>
            <div className="progress-bar" style={{ width: `${task.progress}%` }} />
          </div>
          <span className="tab-num" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {task.progress}% · {task.stage_message ?? ''}
          </span>
        </div>

        <div className="chat-stream">
          {/* User original */}
          <ChatItem
            role="user"
            head={`你 · ${task.aspect_ratio} · ${task.duration}s · ${task.fps}fps`}
            body={
              <>
                <div>{task.prompt}</div>
                <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  风格: {task.style ?? '—'} · 运动: {task.motion_type} · seed: <span className="mono">#{task.seed}</span>
                </div>
              </>
            }
          />

          {/* Chat log */}
          {snapshot.chat.map((m) => (
            <ChatItemFromLog
              key={m.id}
              msg={m}
            />
          ))}

          {task.status === 'completed' && task.video_url && (
            <ChatItem
              role="orchestrator"
              head="Frame Orchestrator · 视频已生成"
              body={
                <>
                  <video
                    src={task.video_url}
                    controls
                    style={{
                      width: '100%',
                      borderRadius: 'var(--r-sm)',
                      border: '1px solid var(--border)',
                      maxHeight: 480,
                      background: 'black'
                    }}
                  />
                  <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                    <button className="btn btn-sm btn-accent" onClick={goPreview}>打开预览页</button>
                    <a className="btn btn-sm" href={task.video_url} download={`frame-${task.id}.mp4`}>下载 mp4</a>
                  </div>
                </>
              }
            />
          )}

          {task.error_message && (
            <ChatItem
              role="system"
              head="错误"
              body={<div style={{ color: 'var(--danger)' }}>{task.error_message}</div>}
            />
          )}
        </div>

        <div className="chat-foot">
          {task.status === 'completed' ? (
            <>
              <button className="btn btn-accent" onClick={goPreview}>预览视频</button>
              <span style={{ flex: 1 }} />
              <Link className="btn btn-ghost btn-sm" href="/">回到创作台</Link>
            </>
          ) : task.status === 'failed' ? (
            <>
              <button className="btn btn-accent" onClick={onRetry}>重试任务</button>
              <span style={{ flex: 1 }} />
              <Link className="btn btn-ghost btn-sm" href="/">回到创作台</Link>
            </>
          ) : task.status === 'cancelled' ? (
            <>
              <button className="btn btn-accent" onClick={onRetry}>重新开始</button>
              <span style={{ flex: 1 }} />
              <Link className="btn btn-ghost btn-sm" href="/">回到创作台</Link>
            </>
          ) : (
            <>
              <button className="btn" disabled>
                <span className="spinner" /> 处理中…
              </button>
              <button className="btn btn-danger" onClick={onCancelTask}>取消任务</button>
              <span style={{ flex: 1 }} />
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                ComfyUI GGUF 正在生成整段视频
              </span>
            </>
          )}
        </div>
      </section>

      {/* === Right: video inspector === */}
      <aside className="ws-right">
        <div className="ws-right-head">
          <h3>视频信息</h3>
        </div>
        <div className="ws-right-section">
          <h4>Codex 绑定</h4>
          <div className="kv">
            <div className="k">App thread</div>
            <div className="v">{task.codex_app_thread_id ? shortId(task.codex_app_thread_id) : '未绑定'}</div>
            <div className="k">Exec thread</div>
            <div className="v">{task.codex_exec_thread_id ? shortId(task.codex_exec_thread_id) : '待生成'}</div>
            <div className="k">Model</div>
            <div className="v">{task.codex_exec_model ?? 'fallback'}</div>
          </div>
        </div>

        <div className="ws-right-section">
          <h4>任务参数</h4>
          <div className="kv">
            <div className="k">比例</div>
            <div className="v">{task.aspect_ratio}</div>
            <div className="k">尺寸</div>
            <div className="v">{task.width} × {task.height}</div>
            <div className="k">时长</div>
            <div className="v">{task.duration}s</div>
            <div className="k">fps</div>
            <div className="v">{task.fps}</div>
            <div className="k">运动</div>
            <div className="v">{task.motion_type}</div>
            <div className="k">视频缓存</div>
            <div className="v">{task.cache_video_hit ? '命中' : '未命中'}</div>
            <div className="k">节省成本</div>
            <div className="v">¥{task.cost_saved.toFixed(2)}</div>
          </div>
        </div>

        <ProgressPanel task={task} entries={progressEntries} />
      </aside>

    </div>
  );
}

function ProgressPanel({ task, entries }: { task: SerializedTask; entries: ProgressEntry[] }) {
  return (
    <div className="ws-right-section ws-progress-panel">
      <div className="ws-section-title-row">
        <h4>生成进度</h4>
        <span className={`badge ${badgeClass(task.status)}`}>
          <span className="badge-dot" />{task.progress}%
        </span>
      </div>
      <div className="ws-progress-summary">
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${task.progress}%` }} />
        </div>
        <div className="ws-progress-current">{task.stage_message ?? STAGE_LABEL[task.status]}</div>
      </div>
      <div className="ws-progress-timeline">
        {entries.map(entry => (
          <div key={entry.id} className={`ws-progress-item tone-${entry.tone ?? 'muted'}`}>
            <div className="ws-progress-dot" />
            <div className="ws-progress-content">
              <div className="ws-progress-row">
                <strong>{entry.title}</strong>
                <span>{formatClock(entry.ts)}</span>
              </div>
              {entry.detail ? <p>{entry.detail}</p> : null}
              {typeof entry.progress === 'number' ? (
                <div className="ws-progress-mini">
                  <div style={{ width: `${Math.max(0, Math.min(100, entry.progress))}%` }} />
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildProgressEntries(snapshot: Snapshot, live: ProgressEntry[]): ProgressEntry[] {
  const task = snapshot.task;
  const base: ProgressEntry[] = [
    {
      id: `task-created-${task.id}`,
      ts: parseDbTime(task.created_at),
      title: '任务已创建',
      detail: `${task.aspect_ratio} · ${task.width}×${task.height} · ${task.duration}s · ${task.fps}fps`,
      progress: 0,
      tone: 'done'
    }
  ];

  for (const msg of snapshot.chat) {
    const entry = progressEntryFromChat(msg);
    if (entry) base.push(entry);
  }

  base.push({
    id: `task-current-${task.id}-${task.status}-${task.progress}`,
    ts: parseDbTime(task.updated_at),
    title: statusTitle(task.status),
    detail: task.error_message || task.stage_message || STAGE_LABEL[task.status],
    progress: task.progress,
    tone: task.status === 'failed' ? 'error' : task.status === 'completed' ? 'done' : 'active'
  });

  const byId = new Map<string, ProgressEntry>();
  [...base, ...live].forEach(entry => byId.set(entry.id, entry));
  return [...byId.values()]
    .sort((a, b) => a.ts - b.ts)
    .slice(-80);
}

function progressEntryFromChat(msg: ChatMsg): ProgressEntry | null {
  const content = msg.content as Record<string, unknown> | string;
  const ts = parseDbTime(msg.created_at);
  if (msg.kind === 'plan') {
    const source = typeof content === 'object' ? content.source as string | undefined : undefined;
    return {
      id: `chat-${msg.id}`,
      ts,
      title: 'Codex 规划完成',
      detail: source ? `来源: ${source}` : undefined,
      progress: 6,
      tone: 'done'
    };
  }
  if (msg.kind === 'note') {
    const action = typeof content === 'object' ? content.action as string | undefined : undefined;
    return {
      id: `chat-${msg.id}`,
      ts,
      title: action === 'internal_prompt_translation' ? '视频提示词已生成' : '流程记录',
      detail: typeof content === 'object' ? readableDetail(content.message) : readableDetail(content),
      tone: 'done'
    };
  }
  if (msg.kind === 'compose') {
    const backend = typeof content === 'object' ? content.backend as string | undefined : undefined;
    const cacheHit = typeof content === 'object' ? content.cache_hit as boolean | undefined : undefined;
    return {
      id: `chat-${msg.id}`,
      ts,
      title: '视频生成完成',
      detail: `${backend ?? 'comfyui_gguf'} · ${cacheHit ? '命中缓存' : '新生成'}`,
      progress: 100,
      tone: 'done'
    };
  }
  if (msg.kind === 'error') {
    return {
      id: `chat-${msg.id}`,
      ts,
      title: '生成失败',
      detail: readableDetail(content),
      tone: 'error'
    };
  }
  return null;
}

function progressEntryFromEvent(data: unknown): ProgressEntry | null {
  if (!data || typeof data !== 'object') return null;
  const ev = data as { type?: string; payload?: unknown; ts?: number };
  const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload as Record<string, unknown> : {};
  const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
  const progress = typeof payload.progress === 'number' ? payload.progress : undefined;
  const message = readableDetail(payload.message) || readableDetail(payload.node);
  const id = `live-${ev.type ?? 'event'}-${ts}-${progress ?? ''}-${message}`;

  if (ev.type === 'status' || ev.type === 'progress') {
    return {
      id,
      ts,
      title: message || '生成进度更新',
      detail: progressNodeDetail(payload),
      progress,
      tone: 'active'
    };
  }
  if (ev.type === 'log') {
    return {
      id,
      ts,
      title: logTitle(payload),
      detail: readableDetail(payload.notes) || readableDetail(payload.source),
      tone: 'done'
    };
  }
  if (ev.type === 'completed') {
    return { id, ts, title: '任务完成', detail: 'MP4 视频已生成', progress: 100, tone: 'done' };
  }
  if (ev.type === 'failed') {
    return { id, ts, title: '任务失败', detail: readableDetail(payload.message), tone: 'error' };
  }
  return null;
}

function appendProgressEntry(prev: ProgressEntry[], entry: ProgressEntry): ProgressEntry[] {
  if (prev.some(item => item.id === entry.id)) return prev;
  return [...prev, entry].slice(-80);
}

function statusTitle(status: string): string {
  if (status === 'planning') return '正在规划视频';
  if (status === 'generating_motion' || status === 'generating_keyframes') return 'ComfyUI 正在生成视频';
  if (status === 'composing_video') return '正在处理视频文件';
  if (status === 'completed') return '任务已完成';
  if (status === 'failed') return '任务失败';
  if (status === 'cancelled') return '任务已取消';
  return '等待开始';
}

function logTitle(payload: Record<string, unknown>): string {
  if (payload.kind === 'plan') return '规划写入任务';
  if (payload.kind === 'compose') return '合成记录';
  return '流程日志';
}

function progressNodeDetail(payload: Record<string, unknown>): string | undefined {
  const parts = [
    readableDetail(payload.node),
    readableDetail(payload.promptId) ? `prompt ${readableDetail(payload.promptId)}` : undefined,
    typeof payload.elapsedMs === 'number' ? `${Math.round(payload.elapsedMs / 1000)}s` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

function readableDetail(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function parseDbTime(value: string): number {
  if (!value) return Date.now();
  const raw = value.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const ts = Date.parse(hasTimezone ? normalized : `${normalized}Z`);
  return Number.isFinite(ts) ? ts : Date.now();
}

// ===== chat helpers =====

function ChatItem({
  role,
  head,
  body
}: {
  role: 'user' | 'system' | 'orchestrator';
  head: string;
  body: React.ReactNode;
}) {
  return (
    <div className="chat-msg">
      <div className="chat-msg-head">
        <strong>{head}</strong>
      </div>
      <div className={`chat-msg-body ${role}`}>{body}</div>
    </div>
  );
}

function ChatItemFromLog({
  msg
}: {
  msg: ChatMsg;
}) {
  const c = msg.content as Record<string, unknown> | string;
  if (msg.kind === 'plan' && typeof c === 'object') {
    const overallPlan = c.overallPlan as Record<string, unknown> | undefined;
    const animationDescription = typeof c.animationDescription === 'string' ? c.animationDescription : '';
    const smoothAnimation = c.smoothAnimation as Record<string, unknown> | undefined;
    const agentSkills = Array.isArray(c.agentSkills) ? c.agentSkills as Array<Record<string, unknown>> : [];
    return (
      <ChatItem
        role="orchestrator"
        head={`Frame Orchestrator · 规划完成 (${(c.source as string) ?? 'fallback'})`}
        body={
          <>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.notes as string}</div>
            {overallPlan && (
              <div className="plan-block">
                <h4>总规划</h4>
                <div><strong>成片概念:</strong> {overallPlan.concept as string}</div>
                <div><strong>视觉风格:</strong> {overallPlan.visualStyle as string}</div>
                <div><strong>镜头语言:</strong> {overallPlan.cameraLanguage as string}</div>
                <div><strong>连续性:</strong> {overallPlan.continuityRules as string}</div>
                {overallPlan.referenceUsage ? <div><strong>参考图:</strong> {overallPlan.referenceUsage as string}</div> : null}
              </div>
            )}
            {smoothAnimation && (
              <div className="plan-block">
                <h4>整段动画描述</h4>
                <div>{animationDescription || smoothAnimation.summary as string}</div>
                <div><strong>运动弧线:</strong> {smoothAnimation.motionArc as string}</div>
                <div><strong>时间节奏:</strong> {smoothAnimation.timing as string}</div>
                <div><strong>过渡逻辑:</strong> {smoothAnimation.transitionLogic as string}</div>
              </div>
            )}
            {agentSkills.length > 0 && (
              <div className="plan-block">
                <h4>Agent 技能调用</h4>
                <div className="agent-skill-list">
                  {agentSkills.map((item, i) => (
                    <div key={`${item.agent ?? 'agent'}-${i}`} className="agent-skill">
                      <strong>{item.agent as string}</strong>
                      <span>{item.skill as string}</span>
                      <p>{item.output as string}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(c.codexThreadId as string | null) && (
              <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                Codex exec thread: <span className="mono">{shortId(c.codexThreadId as string)}</span>
                {(c.model as string | null) ? ` · ${(c.model as string)}` : ''}
              </div>
            )}
          </>
        }
      />
    );
  }
  if (msg.kind === 'frame_generation' && typeof c === 'object') {
    return (
      <ChatItem
        role={msg.role === 'user' ? 'user' : 'orchestrator'}
        head="Frame Orchestrator · 旧版单帧记录"
        body={<div style={{ color: 'var(--muted)' }}>当前已切换为 ComfyUI GGUF 视频模式,不再使用单帧生成。</div>}
      />
    );
  }
  if (msg.kind === 'compose' && typeof c === 'object') {
    return (
      <ChatItem
        role="orchestrator"
        head="Frame Orchestrator · 视频合成"
        body={
          <div>
            {(c.cache_hit as boolean) ? (
              <span className="badge badge-accent">视频缓存命中</span>
            ) : (
                <span>ComfyUI GGUF 视频完成 · {Math.round(((c.duration_ms as number) ?? 0) / 100) / 10}s</span>
            )}
          </div>
        }
      />
    );
  }
  if (msg.kind === 'error') {
    return (
      <ChatItem role="system" head="错误" body={<div style={{ color: 'var(--danger)' }}>{typeof c === 'string' ? c : JSON.stringify(c)}</div>} />
    );
  }
  if (msg.kind === 'note') {
    return (
      <ChatItem role="system" head="提示" body={<div style={{ color: 'var(--muted)' }}>{typeof c === 'string' ? c : JSON.stringify(c)}</div>} />
    );
  }
  return null;
}

function badgeClass(status: string): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed' || status === 'cancelled') return 'badge-danger';
  if (status === 'composing_video') return 'badge-warn';
  return 'badge-violet';
}

function isCancellableStatus(status: string): boolean {
  return !['completed', 'failed', 'cancelled'].includes(status);
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
