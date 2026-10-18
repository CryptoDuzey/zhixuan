import type { Metadata, Viewport } from 'next';
import './globals.css';
import './canvas.css';

export const metadata: Metadata = { title: '知选 · 创作与选购助手', description: '基于已下载的指定知识库，让创作与选购建议有据可查' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#F7F8FA' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
