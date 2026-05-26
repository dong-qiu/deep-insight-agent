/** 审计日志（append-only）。architecture 安全设计「审计与日志」：登录/配置变更/源接入/报告生成/推送/删除。
 *  detail 由调用方脱敏后再传入（logger 的脱敏只管日志输出，库里也不该存明文密钥）。 */
import type { DB } from "./index.js";

export interface AuditEntry {
  actor?: string | null;
  action: string;
  target?: string | null;
  detail?: unknown;
}
export interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string | null;
  detail: unknown;
}

export function appendAudit(db: DB, e: AuditEntry): void {
  db.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)").run(
    e.actor ?? null,
    e.action,
    e.target ?? null,
    e.detail !== undefined ? JSON.stringify(e.detail) : null,
  );
}

export function listAudit(db: DB, opts: { limit?: number } = {}): AuditRow[] {
  const rows = db
    .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(opts.limit ?? 100) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    at: r.at as string,
    actor: (r.actor as string) ?? null,
    action: r.action as string,
    target: (r.target as string) ?? null,
    detail: r.detail ? JSON.parse(r.detail as string) : null,
  }));
}
