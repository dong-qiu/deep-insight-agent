/** Auth.js runtime-safe 基础配置/公开类型。两处实际认证实例必须使用 auth.node-config：
 * 它添加只读凭据版本检查；本文件本身不含 DB 或 Credentials，不可单独用作认证实例。 */
import type { DefaultSession, NextAuthConfig } from "next-auth";

export type Role = "admin" | "viewer";

/** 登录后挂在 session 上的公开用户信息（不含密码）。 */
export interface AppUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export const authConfig = {
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [], // 真正的 Credentials provider 在 auth.ts 注入（Node 侧、带 DB authorize）
  callbacks: {
    // Base-only authentication must fail closed if a future caller forgets Node verification.
    jwt() { return null; },
    session({ session, token }) {
      if (session.user) session.user.role = (token.role as Role) ?? "viewer"; // 缺省最小权限
      return session;
    },
  },
} satisfies NextAuthConfig;

// ── 类型增强：把 role 挂到 User / Session.user（JWT 自带索引签名，token.role 直接可读写）──
declare module "next-auth" {
  interface User {
    role?: Role;
  }
  interface Session {
    user: { role: Role } & DefaultSession["user"];
  }
}
