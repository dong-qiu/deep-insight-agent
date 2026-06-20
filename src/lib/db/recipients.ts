/** 邮件分发收件人持久化（email_recipient 表）：报告推送邮件渠道的收件名单。
 *  - admin 在设置页增删/启停；email 规范化小写存（normEmail，与 app_user 同口径，天然去重）。
 *  - 取代「改服务器 env REPORT_EMAIL_TO」：notifyEmail 优先取本表启用收件人，库空才回落 env（兜底、零回归）。
 *  Node-only（better-sqlite3）——被 /api/admin/recipients 与 notifyEmail（均 Node 路由/运行时）调用。 */
import type { DB } from "./index.js";
import { normEmail } from "./users.js";

/** 收件人展示行（列表用）。 */
export interface RecipientRow {
  email: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
}

interface RawRow {
  email: string;
  label: string | null;
  enabled: number;
  created_at: string;
}

const toRow = (r: RawRow): RecipientRow => ({
  email: r.email,
  label: r.label,
  enabled: r.enabled === 1,
  created_at: r.created_at,
});

/** 全部收件人（含停用），按加入时间排序——设置页列表用。 */
export function listRecipients(db: DB): RecipientRow[] {
  return (
    db
      .prepare("SELECT email, label, enabled, created_at FROM email_recipient ORDER BY created_at")
      .all() as RawRow[]
  ).map(toRow);
}

/** 仅启用收件人的邮箱（发送路径用）：notifyEmail 取这个拼逗号串给 nodemailer。 */
export function listEnabledRecipientEmails(db: DB): string[] {
  return (
    db
      .prepare("SELECT email FROM email_recipient WHERE enabled = 1 ORDER BY created_at")
      .all() as { email: string }[]
  ).map((r) => r.email);
}

/** 新增/更新收件人（同 email 覆盖 label，保留 enabled 当前值——重复添加不会意外重新启用已停用项）。 */
export function upsertRecipient(db: DB, email: string, label?: string | null): void {
  db.prepare(
    `INSERT INTO email_recipient (email, label) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET label = excluded.label`,
  ).run(normEmail(email), label ?? null);
}

/** 启停某收件人（暂停而不删名单）。返回是否命中。 */
export function setRecipientEnabled(db: DB, email: string, enabled: boolean): boolean {
  return (
    db
      .prepare("UPDATE email_recipient SET enabled = ? WHERE email = ?")
      .run(enabled ? 1 : 0, normEmail(email)).changes > 0
  );
}

export function deleteRecipient(db: DB, email: string): boolean {
  return db.prepare("DELETE FROM email_recipient WHERE email = ?").run(normEmail(email)).changes > 0;
}
