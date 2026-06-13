import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deep Insight",
  description: "行业深度洞察系统 —— 多源采集、可溯源、低幻觉",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <header>
          <h1>Deep Insight</h1>
          <nav className="muted">
            <a href="/">今日 Brief</a>
            <a href="/topics">主题</a>
            <a href="/reports">报告库</a>
            <a href="/admin">管理看板</a>
            <a href="/settings">设置</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
