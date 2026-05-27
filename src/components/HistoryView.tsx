'use client';

import { useMemo, useState } from 'react';
import RecentTaskCard from './RecentTaskCard';
import type { SerializedTask } from '@/lib/api-types';

type T = SerializedTask;

const TABS: { id: string; label: string; predicate: (t: T) => boolean }[] = [
  { id: 'all', label: '全部', predicate: () => true },
  { id: 'completed', label: '已完成', predicate: t => t.status === 'completed' },
  { id: 'in_progress', label: '进行中', predicate: t => ['pending', 'planning', 'generating_keyframes', 'generating_motion', 'composing_video'].includes(t.status) },
  { id: 'failed', label: '失败', predicate: t => t.status === 'failed' || t.status === 'cancelled' }
];

export default function HistoryView({ tasks, initialTab }: { tasks: T[]; initialTab: string }) {
  const [tab, setTab] = useState(initialTab);
  const filtered = useMemo(() => {
    const t = TABS.find(x => x.id === tab) ?? TABS[0];
    return tasks.filter(t.predicate);
  }, [tab, tasks]);

  return (
    <>
      <section style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', margin: '20px 0 24px', gap: 16 }}>
        <div>
          <span className="eyebrow">所有任务</span>
          <h1 style={{ marginTop: 8, fontSize: 32, letterSpacing: '-0.02em' }}>历史任务</h1>
          <div style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 6 }}>
            共 {tasks.length} 条任务,可按状态筛选并直接跳到工作台/预览。
          </div>
        </div>
        <div className="chip-cluster">
          {TABS.map(t => (
            <button
              key={t.id}
              className={tab === t.id ? 'is-active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      {filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--border-strong)', borderRadius: 14, background: 'var(--surface-2)' }}>
          没有匹配的任务。
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
          {filtered.map(t => <RecentTaskCard key={t.id} task={t} />)}
        </div>
      )}
    </>
  );
}
