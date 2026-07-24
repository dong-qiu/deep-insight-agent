/** NextAuth (Auth.js v5) —— **Node 侧**完整实例（API 路由 `/api/auth/*` + 服务端组件 `auth()` 用）。
 *  在 runtime-safe authConfig 基础上注入真正的 Credentials provider：authorize 查 app_user 表 + scrypt
 *  验密码（Node-only）。middleware 故意改用 auth.config 自建轻实例（见 middleware.ts），不在请求前置路径
 *  引入 DB/密码校验，同时保留未来迁回 Edge 的兼容性。账号两源 + 分权口径见 lib/db/users.ts。 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config.js";
import { getDb } from "./lib/db/index.js";
import { authenticateUser } from "./lib/db/users.js";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      authorize: (creds) =>
        authenticateUser(getDb(), creds?.email as string | undefined, creds?.password as string | undefined),
    }),
  ],
});
