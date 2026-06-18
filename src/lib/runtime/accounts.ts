/** 账号表与凭据校验（纯函数、Edge 安全、零依赖——与 NextAuth 接线分离，便于单测）。
 *  账号来源（纯 env，不碰 DB）：
 *   - 管理员：ADMIN_EMAIL / ADMIN_PASSWORD → role=admin（向后兼容，永远第一、不可被 APP_USERS 覆盖）。
 *   - 其他人：APP_USERS = JSON 数组 [{email,password,role?,name?}]，role 缺省/未知一律 "viewer"（最小权限）。
 *  role 经 auth.ts 的 jwt/session callback 落到 session.user.role，middleware（isAdminOnlyPath）据此分权。 */

export type Role = "admin" | "viewer";

/** 登录后挂在 session 上的公开用户信息（不含密码）。 */
export interface AppUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}
interface Account extends AppUser {
  password: string;
}

/** 解析配置中的账号表（容错：APP_USERS 非法 JSON / 缺字段则忽略该项，绝不影响 admin 登录）。 */
export function loadAccounts(env: Record<string, string | undefined> = process.env): Account[] {
  const out: Account[] = [];
  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    out.push({ id: "admin", email: env.ADMIN_EMAIL, name: "Admin", role: "admin", password: env.ADMIN_PASSWORD });
  }
  if (env.APP_USERS) {
    try {
      const arr = JSON.parse(env.APP_USERS);
      if (Array.isArray(arr)) {
        arr.forEach((u: unknown, i: number) => {
          if (u && typeof u === "object") {
            const r = u as Record<string, unknown>;
            if (typeof r.email === "string" && typeof r.password === "string" && r.email && r.password) {
              const role: Role = r.role === "admin" ? "admin" : "viewer";
              const name = typeof r.name === "string" && r.name ? r.name : r.email;
              out.push({ id: `user_${i}`, email: r.email, name, role, password: r.password });
            }
          }
        });
      }
    } catch {
      // APP_USERS 非法 JSON：忽略附加账号（admin 仍可登录），不让一处配置错误锁死全员。
    }
  }
  return out;
}

/** 凭据校验：按 email+password 精确匹配账号表，命中返回公开 AppUser（剥掉 password）、否则 null。 */
export function authenticate(
  email: string | undefined,
  password: string | undefined,
  env: Record<string, string | undefined> = process.env,
): AppUser | null {
  if (!email || !password) return null;
  const acct = loadAccounts(env).find((a) => a.email === email && a.password === password);
  return acct ? { id: acct.id, email: acct.email, name: acct.name, role: acct.role } : null;
}
