'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FullTaskPayload, SerializedKeyframe, SerializedChat, SerializedTask } from '@/lib/api-types';

type FullTask = FullTaskPayload;
type Snapshot = FullTaskPayload;
type Keyframe = SerializedKeyframe;
type ChatMsg = SerializedChat;
type FrameRuntimeMap = Record<string, {
  startedAt?: number;
  elapsedMs?: number;
  step?: number;
  maxSteps?: number;
  attempt?: number;
  maxAttempts?: number;
  updatedAt: number;
}>;

const STAGE_LABEL: Record<string, string> = {
  pending: '排队中',
  planning: '规划中',
  generating_keyframes: '生成关键帧',
  generating_motion: '生成动画帧',
  composing_video: '合成视频',
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
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(
    initial.keyframes[0]?.id ?? null
  );
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null);
  const [frameRuntime, setFrameRuntime] = useState<FrameRuntimeMap>({});
  const [framePreviewOpen, setFramePreviewOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // SSE 订阅
  useEffect(() => {
    const es = new EventSource(`/api/video-tasks/${initial.task.id}/stream`);
    const onMsg = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.snapshot) setSnapshot(data.snapshot);
        const payload = data.payload as Record<string, unknown> | undefined;
        if (data.type === 'frame' && typeof payload?.frameId === 'string') {
          setFrameRuntime(prev => ({
            ...prev,
            [payload.frameId as string]: {
              startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : prev[payload.frameId as string]?.startedAt,
              elapsedMs: typeof payload.elapsedMs === 'number' ? payload.elapsedMs : prev[payload.frameId as string]?.elapsedMs,
              step: typeof payload.step === 'number' ? payload.step : prev[payload.frameId as string]?.step,
              maxSteps: typeof payload.maxSteps === 'number' ? payload.maxSteps : prev[payload.frameId as string]?.maxSteps,
              attempt: typeof payload.attempt === 'number' ? payload.attempt : prev[payload.frameId as string]?.attempt,
              maxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : prev[payload.frameId as string]?.maxAttempts,
              updatedAt: Date.now()
            }
          }));
        }
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
  const keyframes = snapshot.keyframes;
  const selectedFrame = useMemo(
    () => keyframes.find((k) => k.id === selectedFrameId) ?? keyframes[0] ?? null,
    [keyframes, selectedFrameId]
  );
  const selectedFrameProgress = selectedFrame ? frameProgress(selectedFrame, frameRuntime, now) : null;

  useEffect(() => {
    if (!selectedFrame) return;
    if (selectedFrame.status === 'generating' || selectedFrame.image_url || selectedFrame.thumbnail_url) {
      setFramePreviewOpen(true);
    }
  }, [selectedFrame?.id, selectedFrame?.status, selectedFrame?.image_url, selectedFrame?.thumbnail_url]);

  const onRegenerate = useCallback(
    async (frameId: string, prompt?: string) => {
      const r = await fetch(`/api/video-tasks/${task.id}/keyframes/${frameId}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(prompt ? { prompt } : {})
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert((j as { error?: string }).error || '重生成失败');
        return;
      }
    },
    [task.id]
  );

  const onToggleLock = useCallback(
    async (frameId: string, lock: boolean) => {
      const r = await fetch(`/api/video-tasks/${task.id}/keyframes/${frameId}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lock })
      });
      if (!r.ok) {
        alert('操作失败');
        return;
      }
      const j = (await r.json()) as Snapshot;
      setSnapshot(j);
    },
    [task.id]
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

  const onCompose = useCallback(async () => {
    const r = await fetch(`/api/video-tasks/${task.id}/compose`, { method: 'POST' });
    if (r.ok) setSnapshot((await r.json()) as Snapshot);
    else alert((await r.json().catch(() => ({}))).error || '合成失败');
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
                  <span>{t.aspect_ratio} · {t.duration}s · {t.frame_count} 帧</span>
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
            head={`你 · ${task.aspect_ratio} · ${task.duration}s · ${task.frame_count} 帧`}
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
              keyframes={keyframes}
              motionType={task.motion_type}
              onSelect={setSelectedFrameId}
              selectedId={selectedFrame?.id ?? null}
            />
          ))}

          {/* Frame grid summary card */}
          {keyframes.length > 0 && (
            <ChatItem
              role="orchestrator"
              head={`Frame Orchestrator · ${keyframes.length} 帧 · ${keyframes.filter(k => k.cache_hit).length} 命中缓存`}
              body={
                <FrameGrid
                  keyframes={keyframes}
                  runtime={frameRuntime}
                  now={now}
                  selectedId={selectedFrame?.id ?? null}
                  onSelect={(id) => setSelectedFrameId(id)}
                />
              }
            />
          )}

          {task.status === 'completed' && task.video_url && (
            <ChatItem
              role="orchestrator"
              head="Frame Orchestrator · 视频已合成"
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
              <button className="btn" onClick={onCompose}>重新合成</button>
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
                可以选中右侧关键帧,等任务完成后点「重新生成此帧」
              </span>
            </>
          )}
        </div>

        {keyframes.length > 1 && (
          <div className="timeline">
            {keyframes.map((k) => (
              <button
                key={k.id}
                className={`timeline-cell${k.id === selectedFrame?.id ? ' is-selected' : ''}`}
                onClick={() => setSelectedFrameId(k.id)}
                title={`第 ${k.frame_index + 1} 帧`}
              >
                {k.thumbnail_url ? <img src={k.thumbnail_url} alt="" /> : null}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* === Right: frame inspector === */}
      <aside className="ws-right">
        <div className="ws-right-head">
          <h3>关键帧画板</h3>
        </div>
        {selectedFrame ? (
          <>
            <div className="ws-right-section">
              <div className="ws-section-title-row">
                <h4>第 {selectedFrame.frame_index + 1}/{keyframes.length} 帧</h4>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFramePreviewOpen(open => !open)}>
                  {framePreviewOpen ? '折叠图片' : '展开图片'}
                </button>
              </div>
              {framePreviewOpen ? (
                <div className="ws-frame-detail-thumb">
                  {selectedFrame.thumbnail_url || selectedFrame.image_url ? (
                    <img src={selectedFrame.image_url ?? selectedFrame.thumbnail_url ?? ''} alt="" />
                  ) : (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>
                      {selectedFrame.status === 'generating' ? '生成中…' : selectedFrame.status === 'failed' ? '生成失败' : '等待生成'}
                    </div>
                  )}
                </div>
              ) : (
                <button type="button" className="ws-frame-collapsed" onClick={() => setFramePreviewOpen(true)}>
                  <span className={`badge ${frameStatusBadge(selectedFrame.status, selectedFrame.cache_hit, !!selectedFrame.locked)}`}>
                    <span className="badge-dot" />{frameStatusLabel(selectedFrame.status, selectedFrame.cache_hit, !!selectedFrame.locked)}
                  </span>
                  <span>{selectedFrame.thumbnail_url || selectedFrame.image_url ? '图片已生成,点击展开查看' : '图片区域已折叠'}</span>
                </button>
              )}
              <div className="kv">
                <div className="k">状态</div>
                <div className="v text">
                  <span className={`badge ${frameStatusBadge(selectedFrame.status, selectedFrame.cache_hit, !!selectedFrame.locked)}`}>
                    <span className="badge-dot" />
                    {frameStatusLabel(selectedFrame.status, selectedFrame.cache_hit, !!selectedFrame.locked)}
                  </span>
                </div>
                <div className="k">seed</div>
                <div className="v">#{selectedFrame.seed}</div>
                <div className="k">缓存 key</div>
                <div className="v" style={{ fontSize: 10.5 }}>{selectedFrame.cache_key.slice(0, 16)}…</div>
                <div className="k">耗时</div>
                <div className="v">{selectedFrameProgress ? formatElapsed(selectedFrameProgress.elapsedMs) : '—'}</div>
                <div className="k">当前步骤</div>
                <div className="v">{selectedFrameProgress?.stepText ?? '—'}</div>
              </div>
              <div className="frame-actions">
                <button
                  className="btn btn-sm"
                  disabled={!!selectedFrame.locked || task.status !== 'completed'}
                  onClick={() => setEditingFrameId(selectedFrame.id)}
                >
                  改提示词
                </button>
                <button
                  className="btn btn-sm"
                  disabled={!!selectedFrame.locked || task.status === 'pending' || task.status === 'planning'}
                  onClick={() => onRegenerate(selectedFrame.id)}
                >
                  随机种子重生成
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => onToggleLock(selectedFrame.id, !selectedFrame.locked)}
                >
                  {selectedFrame.locked ? '解锁' : '锁定'}
                </button>
              </div>
            </div>

            <div className="ws-right-section">
              <h4>单帧提示词</h4>
              <p style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-soft)' }}>
                {selectedFrame.prompt}
              </p>
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
                <div className="k">缓存</div>
                <div className="v">{task.cache_keyframe_hits} / {task.frame_count} 帧</div>
                <div className="k">视频缓存</div>
                <div className="v">{task.cache_video_hit ? '命中' : '未命中'}</div>
                <div className="k">节省成本</div>
                <div className="v">¥{task.cost_saved.toFixed(2)}</div>
              </div>
            </div>
          </>
        ) : (
          <div className="ws-right-section">
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>等待第一帧生成…</p>
          </div>
        )}
      </aside>

      {editingFrameId && selectedFrame && (
        <FramePromptModal
          frame={selectedFrame}
          onCancel={() => setEditingFrameId(null)}
          onSubmit={async (newPrompt) => {
            setEditingFrameId(null);
            await onRegenerate(selectedFrame.id, newPrompt);
          }}
        />
      )}
    </div>
  );
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
  msg,
  keyframes,
  motionType,
  onSelect,
  selectedId
}: {
  msg: ChatMsg;
  keyframes: Keyframe[];
  motionType: string;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const c = msg.content as Record<string, unknown> | string;
  if (msg.kind === 'plan' && typeof c === 'object') {
    const list = (c.framePrompts as string[]) || [];
    const overallPlan = c.overallPlan as Record<string, unknown> | undefined;
    const animationDescription = typeof c.animationDescription === 'string' ? c.animationDescription : '';
    const smoothAnimation = c.smoothAnimation as Record<string, unknown> | undefined;
    const storyboard = Array.isArray(c.storyboard) ? c.storyboard as Array<Record<string, unknown>> : [];
    const frameStills = Array.isArray(c.frameStills) ? c.frameStills as Array<Record<string, unknown>> : [];
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
            <div className="storyboard-list">
              {(storyboard.length ? storyboard : list.map((p, i) => ({ comfyPrompt: p, coreFrame: p, frameIndex: i, timeSec: i }))).map((item, i) => {
                const p = String(item.comfyPrompt ?? list[i] ?? item.coreFrame ?? '');
                const still = frameStills[i];
                return (
                <StoryboardCard
                  key={`${i}-${p.slice(0, 16)}`}
                  prompt={p}
                  detail={item}
                  still={still}
                  index={i}
                  frame={keyframes[i]}
                  motionType={motionType}
                  selected={keyframes[i]?.id === selectedId}
                  onClick={() => {
                    if (keyframes[i]) onSelect(keyframes[i].id);
                  }}
                />
                );
              })}
            </div>
          </>
        }
      />
    );
  }
  if (msg.kind === 'frame_generation' && typeof c === 'object') {
    const idx = c.frame_index as number;
    const isHit = c.cache_hit as boolean;
    return (
      <ChatItem
        role={msg.role === 'user' ? 'user' : 'orchestrator'}
        head={msg.role === 'user' ? '你 · 单帧操作' : 'Frame Orchestrator · 关键帧'}
        body={
          <>
            <div>
              第 <strong>{idx + 1}</strong> 帧
              {' '}
              {(c.action as string) === 'regenerate' ? (
                <span className="badge badge-violet">重生成</span>
              ) : isHit ? (
                <span className="badge badge-accent">缓存命中</span>
              ) : (
                <span className="badge badge-success">新生成</span>
              )}
              {c.backend ? ` · backend: ${c.backend as string}` : ''}
              {c.duration_ms ? ` · ${Math.round((c.duration_ms as number) / 100) / 10}s` : ''}
            </div>
            {(c.new_prompt as string) && (
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-soft)' }}>
                新提示词: {c.new_prompt as string}
              </div>
            )}
          </>
        }
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
              <span>FFmpeg 合成完成 · {(c.segments as number) ?? 0} 段 · {Math.round(((c.duration_ms as number) ?? 0) / 100) / 10}s</span>
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

function StoryboardCard({
  prompt,
  detail,
  still,
  index,
  frame,
  motionType,
  selected,
  onClick
}: {
  prompt: string;
  detail?: Record<string, unknown>;
  still?: Record<string, unknown>;
  index: number;
  frame?: Keyframe;
  motionType: string;
  selected: boolean;
  onClick: () => void;
}) {
  const [open, setOpen] = useState(frame?.status === 'generating');
  const prevStatus = useRef(frame?.status);

  useEffect(() => {
    if (frame?.status === 'generating' && prevStatus.current !== 'generating') {
      setOpen(true);
    }
    if (selected) {
      setOpen(true);
    }
    prevStatus.current = frame?.status;
  }, [frame?.status, selected]);

  const stillDescription = still?.stillDescription ? String(still.stillDescription) : detail?.coreFrame ? String(detail.coreFrame) : '';
  const roleInAnimation = still?.roleInAnimation ? String(still.roleInAnimation) : detail?.subjectState ? String(detail.subjectState) : '';
  const visualChange = still?.visualChange ? String(still.visualChange) : detail?.previousToCurrentChange ? String(detail.previousToCurrentChange) : '';
  const cameraState = detail?.cameraState ? String(detail.cameraState) : '';
  const timeSec = Number.isFinite(Number(detail?.timeSec)) ? Number(detail?.timeSec) : index;
  const summaryText = stillDescription || prompt;
  const collapsedText = summaryText.length > 72 ? `${summaryText.slice(0, 72)}…` : summaryText;

  return (
    <div className={`storyboard-card${selected ? ' is-selected' : ''}${open ? ' is-open' : ''}`}>
      <button type="button" className="storyboard-toggle" onClick={onClick}>
        <div className="storyboard-head">
          <span className="badge badge-accent">分镜 {String(index + 1).padStart(2, '0')}</span>
          <span className="badge">T+{timeSec}s</span>
          <span className={`badge ${motionBadgeClass(motionType)}`}>{motionLabel(motionType)}</span>
          {frame ? (
            <span className={`badge ${frameStatusBadge(frame.status, frame.cache_hit, !!frame.locked)}`}>
              <span className="badge-dot" />{frameStatusLabel(frame.status, frame.cache_hit, !!frame.locked)}
            </span>
          ) : null}
        </div>
        <div className="storyboard-copy">
          {open ? (
            <>
              {stillDescription && <p><strong>定格画面:</strong> {stillDescription}</p>}
              {roleInAnimation && <p><strong>这一帧的作用:</strong> {roleInAnimation}</p>}
              {visualChange && <p><strong>相对上一帧:</strong> {visualChange}</p>}
              {cameraState && <p><strong>镜头状态:</strong> {cameraState}</p>}
            </>
          ) : collapsedText}
        </div>
      </button>
      <button
        type="button"
        className="storyboard-fold"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(value => !value);
        }}
      >
        {open ? '折叠' : '展开'}
      </button>
    </div>
  );
}

function FrameGrid({
  keyframes,
  runtime,
  now,
  selectedId,
  onSelect
}: {
  keyframes: Keyframe[];
  runtime: FrameRuntimeMap;
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="frame-grid">
      {keyframes.map((k) => {
        const progress = frameProgress(k, runtime, now);
        return (
          <button
            key={k.id}
            type="button"
            className={`frame-cell${k.id === selectedId ? ' is-selected' : ''}${k.status === 'generating' ? ' is-generating' : ''}${k.status === 'failed' ? ' is-failed' : ''}`}
            onClick={() => onSelect(k.id)}
            title={k.prompt}
          >
            <span className="frame-num">#{k.frame_index + 1}</span>
            {k.cache_hit ? <span className="frame-tag badge badge-accent" style={{ height: 16, fontSize: 9.5, padding: '0 4px' }}>缓存</span> : null}
            {k.locked ? <span className="frame-tag badge badge-warn" style={{ height: 16, fontSize: 9.5, padding: '0 4px' }}>锁</span> : null}
            {k.thumbnail_url ? <img src={k.thumbnail_url} alt="" /> : null}
            {progress ? (
              <span className="frame-progress">
                <span>{formatElapsed(progress.elapsedMs)}</span>
                <span>{progress.stepText}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function FramePromptModal({
  frame,
  onCancel,
  onSubmit
}: {
  frame: Keyframe;
  onCancel: () => void;
  onSubmit: (newPrompt: string) => void;
}) {
  const [text, setText] = useState(frame.prompt);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>修改第 {frame.frame_index + 1} 帧提示词</h3>
        <p className="modal-sub">提交后会用新的提示词 + 新随机种子重新生成此帧,不会影响其他帧。</p>
        <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button
            className="btn btn-accent"
            disabled={text.trim().length < 4}
            onClick={() => onSubmit(text.trim())}
          >
            重新生成此帧
          </button>
        </div>
      </div>
    </div>
  );
}

function frameProgress(
  frame: Keyframe,
  runtime: FrameRuntimeMap,
  now: number
): { elapsedMs: number; stepText: string } | null {
  if (frame.status === 'completed') {
    return frame.duration_ms ? { elapsedMs: frame.duration_ms, stepText: '已完成' } : null;
  }
  if (frame.status !== 'generating') return null;

  const live = runtime[frame.id];
  const startedAt = live?.startedAt ?? parseDbUtc(frame.updated_at);
  const elapsedMs = Math.max(0, live?.startedAt ? now - live.startedAt : now - startedAt);
  const stepText =
    live?.step && live.maxSteps
      ? `第 ${live.step}/${live.maxSteps} 步`
      : '等待步骤';
  return { elapsedMs, stepText };
}

function parseDbUtc(value: string): number {
  const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
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

function frameStatusLabel(status: string, cacheHit: boolean, locked: boolean): string {
  if (locked) return '已锁定';
  if (status === 'completed') return cacheHit ? '缓存命中' : '已生成';
  if (status === 'generating') return '生成中';
  if (status === 'failed') return '失败';
  if (status === 'pending') return '等待';
  return status;
}

function frameStatusBadge(status: string, cacheHit: boolean, locked: boolean): string {
  if (locked) return 'badge-warn';
  if (status === 'completed') return cacheHit ? 'badge-accent' : 'badge-success';
  if (status === 'generating') return 'badge-violet';
  if (status === 'failed') return 'badge-danger';
  return '';
}

function motionLabel(motion: string): string {
  const labels: Record<string, string> = {
    zoom_in: '运镜: 推近',
    zoom_out: '运镜: 拉远',
    pan_left: '运镜: 左移',
    pan_right: '运镜: 右移',
    fade: '运镜: 淡入淡出',
    crossfade: '运镜: 交叉溶解'
  };
  return labels[motion] ?? `运镜: ${motion}`;
}

function motionBadgeClass(motion: string): string {
  if (motion === 'fade' || motion === 'crossfade') return 'badge-warn';
  if (motion === 'pan_left' || motion === 'pan_right') return 'badge-violet';
  return 'badge-success';
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
