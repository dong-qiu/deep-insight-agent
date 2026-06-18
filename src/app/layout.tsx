import type { Metadata } from "next";
import type { ReactNode } from "react";
import { auth } from "../auth.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deep Insight",
  description: "行业深度洞察系统 —— 多源采集、可溯源、低幻觉",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // 管理入口只对 admin 显示（viewer 受邀只读账号看不到管理看板/设置；服务端 middleware 才是真闸门）。
  const isAdmin = (await auth())?.user?.role === "admin";
  return (
    <html lang="zh">
      <body>
        <header>
          <h1>Deep Insight</h1>
          <nav className="muted">
            <a href="/">今日 Brief</a>
            <a href="/topics">主题</a>
            <a href="/reports">报告库</a>
            {isAdmin ? <a href="/admin">管理看板</a> : null}
            {isAdmin ? <a href="/settings">设置</a> : null}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
