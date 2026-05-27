import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Frame · AI 视频生成平台',
  description: 'Codex 规划 + ComfyUI GGUF Wan 视频生成的本地 AI 短视频工作流'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
