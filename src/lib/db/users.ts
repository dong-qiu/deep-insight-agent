/** 应用用户（多账号 · 受邀只读账号）持久化 + 凭据校验。**Node-only**（scrypt + better-sqlite3）——
 *  只被 auth.ts 的 Credentials authorize（Node 路由）与 /api/admin/users（Node）调用，绝不进 Edge middleware。
 *
 *  账号两源：
 *   - **bootstrap admin**：ADMIN_EMAIL / ADMIN_PASSWORD（env、明文、不可删、不入库）——永远第一、不会被锁死。
 *   - **后加用户**：app_user 表（密码 scrypt 哈希存储），admin 在设置页增删，缺省 role=viewer。
 *  密码哈希格式 `scrypt$<salt>$<hash>`，verify 用 timingSafeEqual 防时序侧信。 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AppUser, Role } from "../../auth.config.js";
import type { DB } from "./index.js";

const KEYLEN = 64;

/** 邮箱规范化（去空白 + 小写）：email 是 PK、也是 admin 保留判定的依据，必须各处口径一致——
 *  否则 `Admin@x.com` 能绕过"内置 admin 邮箱保留"、或造出大小写不同的影子账号（S1）。 */
export function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 生成 `scrypt$<salt>$<hash>`（每次随机盐）。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, KEYLEN).toString("hex")}`;
}

/** 常量时间校验密码（防时序侧信）；格式不符 / 长度不符一律 false。 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hex] = parts;
  let known: Buffer;
  try {
    known = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  if (known.length !== KEYLEN) return false;
  const test = scryptSync(password, salt, KEYLEN);
  return timingSafeEqual(known, test);
}

/** 用户公开信息（列表/展示，不含哈希）。 */
export interface UserRow {
  email: string;
  role: Role;
  name: string | null;
  created_at: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function listUsers(db: DB): UserRow[] {
  return db
    .prepare("SELECT email, role, name, created_at FROM app_user ORDER BY created_at")
    .all() as UserRow[];
}

/** 新增/更新用户（同 email 覆盖）。role 非 admin/viewer 一律落 viewer（最小权限）。 */
export function upsertUser(db: DB, email: string, password: string, role: Role, name?: string | null): void {
  const r: Role = role === "admin" ? "admin" : "viewer";
  db.prepare(
    `INSERT INTO app_user (email, password_hash, role, name) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role, name = excluded.name`,
  ).run(normEmail(email), hashPassword(password), r, name ?? null);
}

export function deleteUser(db: DB, email: string): boolean {
  return db.prepare("DELETE FROM app_user WHERE email = ?").run(normEmail(email)).changes > 0;
}

interface AccountRow {
  email: string;
  password_hash: string;
  role: Role;
  name: string | null;
}

/** 凭据校验（auth.ts 的 Credentials authorize 调用）：env admin（bootstrap、明文、不可删）优先，
 *  再查 app_user（scrypt verify）。命中返回公开 AppUser（无密码），否则 null。 */
export function authenticateUser(db: DB, email: string | undefined, password: string | undefined): AppUser | null {
  if (!email || !password) return null;
  const e = normEmail(email);
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  // 内置 admin 邮箱被**保留**（大小写不敏感）：仅 env 密码可登 admin，绝不回落到库内同名记录——
  // root 账号既不可被锁死，也不会被同邮箱的影子库记录冒用/降级（即便库里存了同名 viewer）。
  if (ADMIN_EMAIL && e === normEmail(ADMIN_EMAIL)) {
    return ADMIN_PASSWORD && password === ADMIN_PASSWORD
      ? { id: "admin", email: ADMIN_EMAIL, name: "Admin", role: "admin" }
      : null;
  }
  const row = db.prepare("SELECT email, password_hash, role, name FROM app_user WHERE email = ?").get(e) as
    | AccountRow
    | undefined;
  if (row && verifyPassword(password, row.password_hash)) {
    return { id: `user:${row.email}`, email: row.email, name: row.name ?? row.email, role: row.role };
  }
  return null;
}
