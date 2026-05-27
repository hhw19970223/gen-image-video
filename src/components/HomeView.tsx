'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import RecentTaskCard from './RecentTaskCard';
import type { AspectRatio, MotionType, Style } from '@/lib/types';
import type { HomeStats, SerializedTask } from '@/lib/api-types';

const TEMPLATES = [
  { id: 'perfume', vis: 'vis-2', meta: '商品 · 美妆 / 香氛', ratio: '9:16' as AspectRatio, title: '香氛瓶 360° 旋转特写', desc: '8 关键帧、镜头自旋 + 推近,适合电商详情页头图视频。', prompt: '一瓶冷调香水在丝绸背景上缓慢旋转,顶光从左前方打入,镜头由远推近', motion: 'zoom_in' as MotionType, frames: 8, style: 'product_photography' as Style, duration: 6 },
  { id: 'apparel', vis: 'vis-1', meta: '电商 · 服装 / 平铺到上身', ratio: '1:1' as AspectRatio, title: '平铺图 → 上身演绎', desc: '两张关键帧交叉溶解,小红书首图节奏,自动加圆角。', prompt: '一件麂皮米色夹克从平铺转向模特上身,自然光摄影棚,品牌片头质感', motion: 'crossfade' as MotionType, frames: 4, style: 'product_photography' as Style, duration: 5 },
  { id: 'beverage', vis: 'vis-6', meta: '美食 · 流体特写', ratio: '9:16' as AspectRatio, title: '饮品倾倒慢镜头', desc: '6 关键帧 + 插帧,液体下落顺滑,TikTok / 抖音节奏。', prompt: '柚子苏打从透明瓶中缓慢倾倒,晶莹气泡在杯中翻涌,微距特写,清晨柔光', motion: 'zoom_in' as MotionType, frames: 6, style: 'product_photography' as Style, duration: 6 },
  { id: 'gadget', vis: 'vis-4', meta: '科技 / 数码 · 开箱节奏', ratio: '16:9' as AspectRatio, title: '数码产品开箱光影', desc: '深紫调 + 高光扫过,4 关键帧节奏,B 站 / YouTube 头图。', prompt: '黑色无人机从礼盒中缓缓升起,深紫氛围灯,高光扫过金属机身', motion: 'fade' as MotionType, frames: 4, style: 'cinematic' as Style, duration: 5 },
  { id: 'brand', vis: 'vis-3', meta: '品牌 · 微动画 / 主视觉', ratio: '16:9' as AspectRatio, title: '品牌主视觉淡入', desc: '极简渐变 + 平移,适合活动页头图、Hero 视频背景。', prompt: '抽象品牌主视觉,蓝绿渐变从左下平移至右上,极简几何形状缓慢漂移', motion: 'pan_right' as MotionType, frames: 4, style: 'cartoon' as Style, duration: 5 },
  { id: 'snack', vis: 'vis-5', meta: '食品 · 包装即视感', ratio: '9:16' as AspectRatio, title: '包装产品摆拍 → 推近', desc: '6 关键帧、单点光源,适合零食 / 饮料 / 美妆陈列。', prompt: '红色饮料铝罐立于木质台面,逆光柔焦背景,镜头从中景推到极近特写', motion: 'zoom_in' as MotionType, frames: 6, style: 'product_photography' as Style, duration: 6 }
];

const RATIOS: AspectRatio[] = ['9:16', '16:9', '1:1'];
const DURATIONS = [5, 6, 8, 10, 15, 20, 30, 40, 50, 60];
const STYLES: { id: Style; label: string }[] = [
  { id: 'product_photography', label: '产品摄影' },
  { id: 'cinematic', label: '电影感' },
  { id: 'realistic', label: '写实' },
  { id: 'cartoon', label: '卡通' },
  { id: 'anime', label: '日系动画' },
  { id: 'cyberpunk', label: '赛博朋克' }
];
const MOTIONS: { id: MotionType; label: string }[] = [
  { id: 'zoom_in', label: '推近' },
  { id: 'zoom_out', label: '拉远' },
  { id: 'pan_left', label: '左移' },
  { id: 'pan_right', label: '右移' },
  { id: 'fade', label: '淡入淡出' },
  { id: 'crossfade', label: '交叉溶解' }
];

interface Props {
  tasks: SerializedTask[];
  stats: HomeStats;
  env: { wan: { configured: boolean; ready: boolean; python: string; script: string; modelId: string; error?: string }; codex: boolean };
}

interface ReferenceUpload {
  path: string;
  url: string;
  name: string;
  size: number;
}

interface ConfirmedPlan {
  overallPlan: {
    concept: string;
    visualStyle: string;
    cameraLanguage: string;
    continuityRules: string;
    referenceUsage?: string;
  };
  animationDescription?: string;
  smoothAnimation?: {
    durationSeconds: number;
    summary: string;
    motionArc: string;
    timing: string;
    transitionLogic: string;
    continuityStrategy: string;
  };
  storyboard?: Array<{
    frameIndex: number;
    timeSec: number;
    coreFrame: string;
    previousToCurrentChange: string;
    cameraState: string;
    subjectState: string;
    continuityAnchor: string;
    comfyPrompt: string;
  }>;
  frameStills?: Array<{
    frameIndex: number;
    timeSec: number;
    stillDescription: string;
    roleInAnimation: string;
    visualChange: string;
  }>;
  agentSkills: Array<{ agent: string; skill: string; output: string }>;
  framePrompts: string[];
  negativePrompt: string;
  notes: string;
  source?: 'codex' | 'fallback';
  codexThreadId?: string;
  model?: string;
}

export default function HomeView({ tasks, stats, env }: Props) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('一瓶冷调香水在丝绸背景上缓慢旋转,顶光从左前方打入,镜头由远推近');
  const [ratio, setRatio] = useState<AspectRatio>('9:16');
  const [duration, setDuration] = useState(6);
  const [style, setStyle] = useState<Style>('realistic');
  const [motion, setMotion] = useState<MotionType>('zoom_in');
  const [references, setReferences] = useState<ReferenceUpload[]>([]);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [plan, setPlan] = useState<ConfirmedPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const frames = duration;

  const taskPayload = useCallback(() => ({
    prompt: prompt.trim(),
    aspect_ratio: ratio,
    duration,
    style,
    motion_type: motion,
    frame_count: frames,
    fps: 24,
    reference_image_paths: references.map(ref => ref.path)
  }), [duration, frames, motion, prompt, ratio, references, style]);

  const requestPlan = useCallback(async () => {
    setErr(null);
    if (prompt.trim().length < 4) {
      setErr('提示词至少要 4 个字');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/video-plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskPayload())
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '生成规划失败');
      setPlan(data.plan as ConfirmedPlan);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [prompt, taskPayload]);

  const confirmGenerate = useCallback(async () => {
    if (!plan) return;
    setErr(null);
    if (!env.wan.ready) {
      setErr(`Wan 直接生成后端未就绪: ${env.wan.error ?? '请配置 Python / CUDA / diffusers 环境'}`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/video-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...taskPayload(), confirmed_plan: plan })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '创建任务失败');
      router.push(`/workspace/${data.task.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }, [env.wan.error, env.wan.ready, plan, router, taskPayload]);

  const uploadReferences = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setErr(null);
    setUploadingRef(true);
    try {
      const uploaded: ReferenceUpload[] = [];
      for (const file of files.slice(0, Math.max(0, 6 - references.length))) {
        const form = new FormData();
        form.append('file', file);
        const r = await fetch('/api/uploads', {
          method: 'POST',
          body: form
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '参考图上传失败');
        uploaded.push(data as ReferenceUpload);
      }
      setReferences(prev => [...prev, ...uploaded].slice(0, 6));
      setPlan(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploadingRef(false);
    }
  }, [references.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      requestPlan();
    }
  };

  const applyTemplate = (t: typeof TEMPLATES[number]) => {
    setPrompt(t.prompt);
    setRatio(t.ratio);
    setDuration(t.duration);
    setMotion(t.motion);
    setStyle(t.style);
    setPlan(null);
    document.querySelector<HTMLTextAreaElement>('#prompt-input')?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const styleLabel = STYLES.find(s => s.id === style)?.label;
  const motionLabel = MOTIONS.find(m => m.id === motion)?.label;
  const totalSec = duration;
  const estTime = `~${Math.round(totalSec * 6 + frames * 6)}s`;
  const previewFrameStills = plan
    ? plan.frameStills?.length
      ? plan.frameStills
      : plan.storyboard?.length
        ? plan.storyboard.map(item => ({
          frameIndex: item.frameIndex,
          timeSec: item.timeSec,
          stillDescription: item.coreFrame,
          roleInAnimation: item.subjectState,
          visualChange: item.previousToCurrentChange
        }))
        : plan.framePrompts.map((item, index) => ({
          frameIndex: index,
          timeSec: index,
          stillDescription: item,
          roleInAnimation: '',
          visualChange: ''
        }))
    : [];

  return (
    <>
      <section className="hero">
        <div className="hero-head">
          <div>
            <span className="eyebrow">创作台 · {new Date().toISOString().slice(0, 10)}</span>
            <h1 style={{ marginTop: 14 }}>
              把一句话<br />变成一段<em>会动的故事</em>。
            </h1>
            <p className="hero-sub" style={{ marginTop: 14 }}>
              关键帧生成 + 简单动画 + 插帧合成。普通笔记本也能跑的 AI 短视频工作流,
              先生图、再动起来,缓存复用降低 80% 重复成本。
            </p>
          </div>
          <div className="hero-stats">
            <div>
              <div className="stat-num tab-num">{stats.monthCount.toLocaleString()}</div>
              <div className="stat-label">本月已生成视频</div>
            </div>
            <div>
              <div className="stat-num tab-num">{Math.round(stats.cacheHitRate * 100)}%</div>
              <div className="stat-label">缓存命中率</div>
            </div>
            <div>
              <div className="stat-num tab-num">¥{stats.avgCost.toFixed(2)}</div>
              <div className="stat-label">平均单条成本</div>
            </div>
          </div>
        </div>

        <form className="composer" onSubmit={e => { e.preventDefault(); requestPlan(); }}>
          <div className="composer-inner">
            <textarea
              id="prompt-input"
              value={prompt}
              onChange={e => { setPrompt(e.target.value); setPlan(null); }}
              onKeyDown={onKeyDown}
              placeholder="描述一段视频…例如:一瓶冷调香水在丝绸背景上缓慢旋转,顶光从左前方打入,镜头由远推近,9:16 竖版"
            />
            <div className="reference-row">
              <label className="btn btn-sm btn-ghost reference-upload">
                {uploadingRef ? '上传中…' : references.length ? '继续添加参考图' : '上传参考图'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  disabled={uploadingRef || busy}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    uploadReferences(files);
                    e.currentTarget.value = '';
                  }}
                />
              </label>
              {references.length > 0 && (
                <div className="reference-list">
                  {references.map((reference, index) => (
                    <div className="reference-preview" key={reference.path}>
                      <img src={reference.url} alt="" />
                      <span title={reference.name}>{index === 0 ? '主参考 · ' : ''}{reference.name}</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => { setReferences(prev => prev.filter(ref => ref.path !== reference.path)); setPlan(null); }}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="composer-tools">
              <div className="chip-cluster" role="tablist" aria-label="比例">
                {RATIOS.map(r => (
                  <button
                    key={r}
                    type="button"
                    className={ratio === r ? 'is-active' : ''}
                    onClick={() => { setRatio(r); setPlan(null); }}
                  >
                    {r.replace(':', ' : ')}
                  </button>
                ))}
              </div>
              <div className="chip-cluster" role="tablist" aria-label="时长">
                {DURATIONS.map(d => (
                  <button
                    key={d}
                    type="button"
                    className={duration === d ? 'is-active' : ''}
                    onClick={() => { setDuration(d); setPlan(null); }}
                  >
                    {d} s
                  </button>
                ))}
              </div>
              <span className="chip">每秒 1 帧 · {frames} 帧</span>
              <SelectChip
                value={style}
                onChange={v => { setStyle(v as Style); setPlan(null); }}
                options={STYLES}
                label={`风格: ${styleLabel}`}
              />
              <SelectChip
                value={motion}
                onChange={v => { setMotion(v as MotionType); setPlan(null); }}
                options={MOTIONS}
                label={`运动: ${motionLabel}`}
              />
              <span className="grow" />
              <button type="submit" className="btn btn-accent btn-lg" disabled={busy}>
                {busy ? <span className="spinner" /> : null}
                {busy ? '规划中…' : '生成规划'}
                {!busy && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                )}
              </button>
            </div>
            {err && <div className="composer-error">{err}</div>}
            {plan && (
              <div className="plan-preview">
                <div className="plan-preview-head">
                  <div>
                    <strong>请确认 Codex 动画规划</strong>
                    <span>{plan.notes}</span>
                  </div>
                  <button type="button" className="btn btn-sm btn-accent" disabled={busy} onClick={confirmGenerate}>
                    {busy ? <span className="spinner" /> : null}
                    确认并开始生成
                  </button>
                </div>
                <div className="plan-preview-grid">
                  <div>
                    <h4>成片应该是什么样</h4>
                    <p><strong>概念:</strong> {plan.overallPlan.concept}</p>
                    <p><strong>风格:</strong> {plan.overallPlan.visualStyle}</p>
                    <p><strong>镜头:</strong> {plan.overallPlan.cameraLanguage}</p>
                    <p><strong>串联:</strong> {plan.overallPlan.continuityRules}</p>
                    {plan.overallPlan.referenceUsage && <p><strong>参考图:</strong> {plan.overallPlan.referenceUsage}</p>}
                    {plan.animationDescription && (
                      <>
                        <h4 style={{ marginTop: 14 }}>整段动画描述</h4>
                        <p>{plan.animationDescription}</p>
                      </>
                    )}
                    {plan.smoothAnimation && (
                      <>
                        <h4 style={{ marginTop: 14 }}>动画节奏</h4>
                        <p><strong>运动弧线:</strong> {plan.smoothAnimation.motionArc}</p>
                        <p><strong>时间节奏:</strong> {plan.smoothAnimation.timing}</p>
                        <p><strong>过渡逻辑:</strong> {plan.smoothAnimation.transitionLogic}</p>
                      </>
                    )}
                  </div>
                  <div>
                    <h4>每秒定格画面</h4>
                    <ol>
                      {previewFrameStills.map((item, index) => (
                        <li key={index}>
                          <strong>{item.timeSec}s 定格:</strong> {item.stillDescription}
                          {item.roleInAnimation && <p><strong>这一帧的作用:</strong> {item.roleInAnimation}</p>}
                          {item.visualChange && <p><strong>相对上一帧:</strong> {item.visualChange}</p>}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
                <div className="agent-strip">
                  {plan.agentSkills.map((item, index) => (
                    <span key={`${item.agent}-${index}`} title={item.output}>
                      {item.agent}: {item.skill}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="composer-foot">
            <span>
              预计生成 <strong className="tab-num" style={{ color: 'var(--fg)' }}>{frames}</strong> 张关键帧 · 每秒 1 帧 ·
              <span className="tab-num"> 24fps</span> · 720p · 估时 <span className="tab-num">{estTime}</span>
            </span>
            {references.length > 0 && <span>已上传 {references.length} 张参考图,第 1 张作为主锚定图</span>}
            <span className="grow" />
            <span>
              {env.wan.ready
                ? `🟢 Wan 直接生成已就绪 (${env.wan.modelId})`
                : `🟡 Wan 直接生成待配置`}
            </span>
            <span style={{ marginLeft: 12 }}>
              <kbd>⌘</kbd> + <kbd>⏎</kbd> 提交
            </span>
          </div>
        </form>
      </section>

      <section>
        <div className="section-head">
          <div>
            <h2>模板灵感</h2>
            <div className="sub">点击任一模板会预填创作台,并锁定运动 / 比例 / 时长。</div>
          </div>
        </div>
        <div className="templates">
          {TEMPLATES.map(t => (
            <button key={t.id} className="tpl" type="button" onClick={() => applyTemplate(t)}>
              <div className="tpl-thumb"><div className={`thumb-content ${t.vis}`} /></div>
              <div>
                <div className="tpl-meta">
                  <span>{t.meta}</span>
                  <span className="ratio">{t.ratio}</span>
                </div>
                <div className="tpl-title" style={{ marginTop: 6 }}>{t.title}</div>
                <div className="tpl-desc" style={{ marginTop: 6 }}>{t.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-head">
          <div>
            <h2>最近作品</h2>
            <div className="sub">
              本周 <span className="tab-num">{stats.weekCount}</span> 条任务,
              缓存节省 <span className="tab-num" style={{ color: 'var(--success)' }}>¥{stats.weekSaved.toFixed(2)}</span>
            </div>
          </div>
          <div className="actions">
            <Link className="btn btn-sm" href="/history">查看全部</Link>
          </div>
        </div>

        {tasks.length === 0 ? (
          <div className="empty-recents">
            还没有生成过视频。在上面输入提示词,点击「生成视频」开始第一条吧。
          </div>
        ) : (
          <div className="recents">
            {tasks.slice(0, 4).map(t => <RecentTaskCard key={t.id} task={t} />)}
          </div>
        )}
      </section>

      <section className="info-strip">
        <div className="info-cell">
          <div className="label">本月配额</div>
          <div className="value tab-num">{stats.quotaUsed} / {stats.quotaTotal}</div>
          <div className="value-sub">视频任务 · 月度统计</div>
        </div>
        <div className="info-cell">
          <div className="label">关键帧缓存</div>
          <div className="value tab-num">{stats.cacheKeyframes.toLocaleString()}</div>
          <div className="value-sub">命中即跳过生图</div>
        </div>
        <div className="info-cell">
          <div className="label">缓存命中率</div>
          <div className="value tab-num">{Math.round(stats.cacheHitRate * 100)}%</div>
          <div className="value-sub">所有关键帧累计</div>
        </div>
        <div className="info-cell">
          <div className="label">外部服务</div>
          <div className="value" style={{ display: 'flex', gap: 8, fontSize: 14, fontWeight: 500 }}>
            <span className={`badge ${env.wan.ready ? 'badge-success' : 'badge-warn'}`}><span className="badge-dot" />Wan</span>
            <span className={`badge ${env.codex ? 'badge-success' : 'badge-warn'}`}><span className="badge-dot" />Codex</span>
          </div>
          <div className="value-sub">FFmpeg · 本地</div>
        </div>
      </section>
    </>
  );
}

function SelectChip({
  value,
  onChange,
  options,
  label
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  label: string;
}) {
  return (
    <label className="chip" style={{ position: 'relative', cursor: 'pointer' }}>
      <span>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          cursor: 'pointer',
          border: 0,
          background: 'transparent'
        }}
      >
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}
