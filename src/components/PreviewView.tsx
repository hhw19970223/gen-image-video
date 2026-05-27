'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FullTaskPayload } from '@/lib/api-types';

type FullTask = FullTaskPayload;

const SPEEDS = [0.5, 1, 1.25, 1.5, 2];

export default function PreviewView({ initial }: { initial: FullTask }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (snapshot.task.status === 'completed') return;
    const es = new EventSource(`/api/video-tasks/${initial.task.id}/stream`);
    const onSnap = (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        if (data.snapshot) setSnapshot(data.snapshot);
        else setSnapshot(data);
      } catch {/* */}
    };
    es.addEventListener('snapshot', onSnap);
    es.addEventListener('completed', onSnap);
    es.addEventListener('status', onSnap);
    return () => es.close();
  }, [initial.task.id, snapshot.task.status]);

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(time + 0.5);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(Math.max(0, time - 0.5));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration || v.duration || 0, t));
  }, [duration]);

  const cycleSpeed = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const next = (speedIdx + 1) % SPEEDS.length;
    v.playbackRate = SPEEDS[next];
    setSpeedIdx(next);
  }, [speedIdx]);

  const t = snapshot.task;
  const ratioClass = t.aspect_ratio === '9:16' ? 'r-9-16' : t.aspect_ratio === '1:1' ? 'r-1-1' : '';
  const reuse = () => {
    const params = new URLSearchParams({
      prompt: t.prompt,
      ratio: t.aspect_ratio,
      duration: String(t.duration),
      motion: t.motion_type,
    });
    router.push(`/?${params.toString()}`);
  };

  return (
    <main>
      <section className="pv-shell">
        <header className="pv-head">
          <div>
            <h1>{t.prompt}</h1>
            <div className="pv-head-meta">
              <span className="badge badge-success"><span className="badge-dot" />已完成</span>
              <span className="tab-num">{t.aspect_ratio} · {t.width}×{t.height} · {t.duration}s · {t.fps}fps</span>
              <span>运动: {t.motion_type}</span>
              <span>seed: <span className="mono">#{t.seed}</span></span>
              {t.cache_video_hit && <span className="badge badge-accent">视频缓存命中</span>}
            </div>
          </div>
          <div className="pv-head-actions">
            <Link href={`/workspace/${t.id}`} className="btn">返回工作台</Link>
            {t.video_url && (
              <a href={t.video_url} download={`frame-${t.id}.mp4`} className="btn btn-accent">下载 mp4</a>
            )}
          </div>
        </header>

        {/* === Player + controls === */}
        <div>
          <div className={`pv-player-wrap ${ratioClass}`}>
            {t.video_url ? (
              <video
                ref={videoRef}
                src={t.video_url}
                preload="auto"
                onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration)}
                onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={toggle}
                poster={t.cover_url ?? undefined}
              />
            ) : (
              <div style={{ aspectRatio: '16/9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', flexDirection: 'column', gap: 8 }}>
                <span className="spinner" style={{ borderTopColor: 'white' }} />
                <span style={{ fontSize: 13 }}>{t.stage_message ?? '等待视频生成…'}</span>
              </div>
            )}
          </div>

          <div className="pv-controls">
            <button className="btn btn-icon btn-sm" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>
              {playing ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              )}
            </button>
            <button className="btn btn-icon btn-sm" onClick={() => seek(time - 0.5)} title="←/-0.5s">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <button className="btn btn-icon btn-sm" onClick={() => seek(time + 0.5)} title="→/+0.5s">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="m9 18 6-6-6-6"/></svg>
            </button>

            <div
              className="scrub"
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const r = (e.clientX - rect.left) / rect.width;
                seek(r * (duration || t.duration));
              }}
            >
              <div className="scrub-bar" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
            </div>

            <span className="time">{fmt(time)} / {fmt(duration || t.duration)}</span>
            <button className="btn btn-sm" onClick={cycleSpeed} title="播放速度">
              {SPEEDS[speedIdx].toFixed(2).replace(/\.?0+$/, '')}×
            </button>
          </div>

        </div>

        {/* === Side panels === */}
        <aside className="pv-side">
          <div className="pv-card">
            <h4>提示词</h4>
            <p style={{ fontSize: 13, lineHeight: 1.6 }}>{t.prompt}</p>
            {t.style && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>风格: {t.style}</div>}
          </div>

          <div className="pv-card">
            <h4>生成参数</h4>
            <div className="kv">
              <div className="k">比例</div><div className="v">{t.aspect_ratio}</div>
              <div className="k">尺寸</div><div className="v">{t.width} × {t.height}</div>
              <div className="k">时长</div><div className="v">{t.duration}s</div>
              <div className="k">fps</div><div className="v">{t.fps}</div>
              <div className="k">运动</div><div className="v">{t.motion_type}</div>
              <div className="k">seed</div><div className="v">#{t.seed}</div>
            </div>
          </div>

          <div className="pv-card">
            <h4>缓存命中</h4>
            <div className="kv">
              <div className="k">视频</div>
              <div className="v">{t.cache_video_hit ? '命中' : '未命中'}</div>
              <div className="k">估算成本</div>
              <div className="v">¥{t.cost_estimate.toFixed(2)}</div>
              <div className="k">实际节省</div>
              <div className="v" style={{ color: 'var(--success)' }}>¥{t.cost_saved.toFixed(2)}</div>
            </div>
          </div>

          <div className="pv-card">
            <h4>动作</h4>
            <div className="pv-cta-row">
              <button className="btn btn-accent" onClick={reuse}>复用参数 → 创作台</button>
              <Link className="btn" href={`/workspace/${t.id}`}>查看任务</Link>
              {t.video_url && (
                <a className="btn" href={t.video_url} download={`frame-${t.id}.mp4`}>下载 mp4</a>
              )}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function fmt(s: number): string {
  if (!Number.isFinite(s)) return '0:00.0';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
