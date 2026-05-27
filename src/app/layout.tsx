import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Frame · AI 帧动画视频生成平台',
  description: '关键帧生成 + 简单动画 + FFmpeg 合成 — 普通笔记本也能跑的低成本 AI 短视频工作流'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
