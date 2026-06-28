import type { Metadata } from "next";
import type { ReactNode } from "react";
import { auth, signOut } from "../auth.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deep Insight",
  description: "行业深度洞察系统 —— 多源采集、可溯源、低幻觉",
};

/** 登出（server action）：清 session 后回登录页。App Router 惯用法，无需客户端 SessionProvider。 */
async function doSignOut(): Promise<void> {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = (await auth())?.user;
  // 管理入口只对 admin 显示（viewer 受邀只读账号看不到管理看板/设置；服务端 middleware 才是真闸门）。
  const isAdmin = user?.role === "admin";
  return (
    <html lang="zh">
      <body>
        <header>
          <div className="header-top">
            <h1>Deep Insight</h1>
            {user ? (
              <span className="user-menu muted">
                <span className="user-id">
                  {user.email}
                  {user.role === "viewer" ? " · 只读" : ""}
                </span>
                <form action={doSignOut}>
                  <button type="submit" className="ppt-btn-link signout-btn">退出</button>
                </form>
              </span>
            ) : null}
          </div>
          <nav className="muted">
            <a href="/">今日 Brief</a>
            <a href="/topics">主题</a>
            <a href="/reports">报告库</a>
            <a href="/graph">关系图</a>
            {isAdmin ? <a href="/admin">管理看板</a> : null}
            {isAdmin ? <a href="/settings">设置</a> : null}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
