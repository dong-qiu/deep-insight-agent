/** NextAuth (Auth.js v5) —— **Node 侧**完整实例（API 路由 `/api/auth/*` + 服务端组件 `auth()` 用）。
 *  在 runtime-safe authConfig 基础上注入真正的 Credentials provider：authorize 查 app_user 表 + scrypt
 *  验密码（Node-only）。middleware 共用 auth.node-config 的只读会话核对，不导入 getDb 的 writer 初始化。
 *  账号两源 + 分权口径见 lib/db/users.ts，撤销契约见 ADR-0037。 */
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authNodeConfig } from "./auth.node-config.js";
import { getDb } from "./lib/db/index.js";
import { authenticateSessionUser } from "./lib/db/users.js";
import { createLoginAuthorizer, LoginRateLimited } from "./lib/runtime/login-authorize.js";

const authorize = createLoginAuthorizer((email, password) => authenticateSessionUser(getDb(), email, password));
class RateLimitedCredentials extends CredentialsSignin {
  code = "rate_limited";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authNodeConfig,
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      authorize: (credentials) => {
        try { return authorize(credentials); } catch (error) {
          if (error instanceof LoginRateLimited) throw new RateLimitedCredentials();
          throw error;
        }
      },
    }),
  ],
});
