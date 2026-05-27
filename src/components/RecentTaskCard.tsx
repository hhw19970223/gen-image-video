'use client';

import Link from 'next/link';
import type { SerializedTask } from '@/lib/api-types';

type T = SerializedTask;

const STATUS_BADGE: Record<string, { className: string; text: string }> = {
  pending: { className: 'badge-warn', text: '排队中' },
  planning: { className: 'badge-violet', text: '规划中' },
  generating_keyframes: { className: 'badge-violet', text: '生成关键帧' },
  generating_motion: { className: 'badge-violet', text: '生成动画帧' },
  composing_video: { className: 'badge-warn', text: '合成视频中' },
  completed: { className: 'badge-success', text: '已完成' },
  failed: { className: 'badge-danger', text: '失败' },
  cancelled: { className: 'badge-danger', text: '已取消' }
};

function relTime(iso: string): string {
  const t = new Date(iso + 'Z').getTime();
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return `${Math.floor(sec)} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

export default function RecentTaskCard({ task: t }: { task: T }) {
  const isInProgress = ['pending', 'planning', 'generating_keyframes', 'generating_motion', 'composing_video'].includes(t.status);
  const isFailed = t.status === 'failed';
  const isCompleted = t.status === 'completed';
  const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.pending;
  const href = isCompleted ? `/preview/${t.id}` : `/workspace/${t.id}`;

  return (
    <Link className="recent" href={href}>
      <div className={`recent-thumb${isFailed ? ' is-failed' : ''}${isInProgress && !t.cover_url ? ' is-generating' : ''}`}>
        {t.cover_url ? (
          <img src={t.cover_url} alt={t.prompt.slice(0, 40)} loading="lazy" />
        ) : null}
        <span className={`badge ${badge.className} recent-status`}>
          <span className="badge-dot" />{badge.text}
        </span>
        {isCompleted && (
          <span className="recent-duration tab-num">
            {`0:${String(Math.round(t.duration)).padStart(2, '0')}`}
          </span>
        )}
        {isInProgress && (
          <div className="recent-thumb-overlay">
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${t.progress}%` }} />
            </div>
            <div className="meta">
              <span>{t.progress}%</span>
              <span style={{ marginLeft: 'auto' }}>{t.stage_message ?? '处理中…'}</span>
            </div>
          </div>
        )}
        {isFailed && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'oklch(40% 0.12 25)' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="M12 9v4" /><path d="M12 17h.01" />
              <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
        )}
      </div>
      <div className="recent-info">
        <div className="recent-title">{t.prompt.slice(0, 60)}</div>
        <div className="recent-meta">
          <span>{relTime(t.created_at)}</span>
          <span>·</span>
          <span className="tab-num">{t.aspect_ratio} · {t.duration}s · {t.fps}fps</span>
          <span className="grow" />
          {t.cache_keyframe_hits > 0 && (
            <span className="badge badge-accent" style={{ height: 18, fontSize: 10.5, padding: '0 6px' }}>
              缓存 {t.cache_keyframe_hits}/{t.frame_count}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
