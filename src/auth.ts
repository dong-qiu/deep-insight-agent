/** NextAuth (Auth.js v5) —— 鉴权配置（architecture：身份与隔离 / 管理员独立鉴权）。
 *  Credentials + JWT session（无 SMTP / DB 适配器；Edge 安全：本文件被 middleware 引入，
 *  绝不 import DB / pino 等 Node-only 模块——账号来源纯 env、纯字符串比较）。
 *
 *  账号与角色（多账号「几个可信的人」对外分享支持）：
 *   - 管理员：ADMIN_EMAIL / ADMIN_PASSWORD → role=admin（向后兼容，唯一全权账号来源）。
 *   - 其他人：APP_USERS = JSON 数组 [{email,password,role?,name?}]，role 缺省 "viewer"。
 *  role 经 jwt/session callback 落到 session.user.role；middleware（isAdminOnlyPath）+ 页面据此分权——
 *  viewer 只读 Brief/报告/主题，管理/配置/烧钱端点（深挖·追问·PPT polish）一律 admin。 */
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authenticate, type AppUser, type Role } from "./lib/runtime/accounts.js";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      authorize: (creds) =>
        authenticate(creds?.email as string | undefined, creds?.password as string | undefined),
    }),
  ],
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
});

// ── 类型增强：把 role 挂到 User / Session.user（JWT 自带索引签名，token.role 直接可读写，无需增强）──
declare module "next-auth" {
  interface User {
    role?: Role;
  }
  interface Session {
    user: { role: Role } & DefaultSession["user"];
  }
}
