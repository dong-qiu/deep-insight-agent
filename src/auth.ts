/** NextAuth (Auth.js v5) —— 鉴权配置（architecture：身份与隔离 / 管理员独立鉴权）。
 *  MVP 用 Credentials + JWT session（无需 SMTP / DB 适配器，且 Edge 安全：本文件被 middleware 引入，
 *  绝不 import DB / pino 等 Node-only 模块）。magic-link（Email provider）+ DB session + 多 role 留后续。
 *  凭据来自环境变量 ADMIN_EMAIL / ADMIN_PASSWORD；AUTH_SECRET 必配。 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      authorize: (creds) => {
        const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
        if (
          ADMIN_EMAIL &&
          ADMIN_PASSWORD &&
          creds?.email === ADMIN_EMAIL &&
          creds?.password === ADMIN_PASSWORD
        ) {
          return { id: "admin", email: ADMIN_EMAIL, name: "Admin" };
        }
        return null; // 凭据不符 / 未配置 → 拒绝
      },
    }),
  ],
});
