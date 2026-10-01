/** 应用用户（多账号 · 受邀只读账号）持久化 + 凭据校验。**Node-only**（scrypt + better-sqlite3）——
 *  auth.ts、用户 API 与 Node middleware 的只读会话核对共用；绝不进 Edge runtime。
 *
 *  账号两源：
 *   - **bootstrap admin**：ADMIN_EMAIL / ADMIN_PASSWORD（env、明文、不可删、不入库）——优先于同名 DB 账号；登录仍受短时限速。
 *   - **后加用户**：app_user 表（密码 scrypt 哈希存储），admin 在设置页增删，缺省 role=viewer。
 *  密码哈希格式 `scrypt$<salt>$<hash>`，verify 用 timingSafeEqual 防时序侧信。 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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

interface AccountSnapshot {
  user: AppUser;
  kind: "env" | "db";
  credential: string;
}

function readAccount(db: DB, email: string): AccountSnapshot | null {
  const e = normEmail(email);
  // Even bootstrap sessions require a readable account store; corrupt/missing schema fails closed.
  const row = db.prepare("SELECT email, password_hash, role, name FROM app_user WHERE email = ?").get(e) as
    | AccountRow | undefined;
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  // 内置 admin 邮箱被**保留**（大小写不敏感）：仅 env 密码可登 admin，绝不回落到库内同名记录——
  // 同邮箱的影子库记录不能覆盖/冒用/降级 env admin（即便库里存了同名 viewer）；登录限速仍适用。
  if (ADMIN_EMAIL && e === normEmail(ADMIN_EMAIL)) {
    return ADMIN_PASSWORD
      ? { user: { id: "admin", email: ADMIN_EMAIL, name: "Admin", role: "admin" }, kind: "env", credential: ADMIN_PASSWORD }
      : null;
  }
  if (row && (row.role === "admin" || row.role === "viewer")) {
    return { user: { id: `user:${row.email}`, email: row.email, name: row.name ?? row.email, role: row.role },
      kind: "db", credential: row.password_hash };
  }
  return null;
}

function authenticateSnapshot(db: DB, email: string | undefined, password: string | undefined): AccountSnapshot | null {
  if (!email || !password) return null;
  const account = readAccount(db, email);
  if (!account) return null;
  const valid = account.kind === "env" ? password === account.credential : verifyPassword(password, account.credential);
  return valid ? account : null;
}

/** Public account shape remains unchanged; no session fingerprint or password material. */
export function authenticateUser(db: DB, email: string | undefined, password: string | undefined): AppUser | null {
  return authenticateSnapshot(db, email, password)?.user ?? null;
}

/** Server-only identity passed from authorize to jwt; never spread into public session. */
export interface SessionUser extends AppUser { sessionVersion: string }

function withSessionVersion(account: AccountSnapshot): SessionUser {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("session version secret unavailable");
  const version = createHmac("sha256", secret).update(JSON.stringify([
    "insight-session-v1", account.kind, account.user.id, normEmail(account.user.email), account.user.role, account.credential,
  ])).digest("hex");
  return { ...account.user, sessionVersion: version };
}

/** Derive the version from exactly the snapshot whose password was checked, not a later re-read. */
export function authenticateSessionUser(db: DB, email: string, password: string): SessionUser | null {
  const account = authenticateSnapshot(db, email, password);
  return account ? withSessionVersion(account) : null;
}

export function readSessionUser(db: DB, email: string): SessionUser | null {
  const account = readAccount(db, email);
  return account ? withSessionVersion(account) : null;
}
