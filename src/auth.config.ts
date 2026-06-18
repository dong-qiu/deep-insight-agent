/** Auth.js v5 共享配置 —— **Edge 安全**（middleware 与完整 auth.ts 都基于它）。
 *  这里不含 DB、不含 Credentials 的 authorize 实现：middleware 跑在 Edge，只读 JWT 里的 role
 *  （由 jwt/session callback 搬运），无需 DB。真正查库验密码的 Credentials provider（Node-only、
 *  scrypt + better-sqlite3）在 auth.ts 里注入。这是 Auth.js「split your config」的标准拆法，
 *  让数据库后端的鉴权与 Edge middleware 共存。 */
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
    // role 随登录写入 JWT，再由 session 暴露给服务端组件 / middleware（分权唯一事实来源）。
    jwt({ token, user }) {
      if (user) token.role = (user as AppUser).role;
      return token;
    },
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
