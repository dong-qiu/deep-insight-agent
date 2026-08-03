/** 管理员报告脱敏：registry 成功后才在同一 SQLite 事务撤下发布读模型与写入审计。 */
import { appendAudit } from "../db/audit.js";
import type { DB } from "../db/index.js";
import {
  registerRedaction,
  type RedactionRegistryClients,
  type RedactionRegistryConfig,
} from "../db/redaction-registry-writer.js";

export type ReportRedactionResult =
  | { kind: "not_found" }
  | { kind: "redacted"; record_id: string; already_redacted: boolean };

export async function redactReport(
  db: DB,
  input: {
    report_id: string;
    deletion_request_id: string;
    reason_code: string;
    expiry_at: string;
    actor_id: string;
  },
  config: RedactionRegistryConfig,
  clients: RedactionRegistryClients,
): Promise<ReportRedactionResult> {
  const report = db.prepare("SELECT id,status FROM report WHERE id=?").get(input.report_id) as { id: string; status: string } | undefined;
  if (!report) return { kind: "not_found" };
  const registered = await registerRedaction(db, {
    deletion_request_id: input.deletion_request_id,
    entity_key: `report:${input.report_id}`,
    scope: "report",
    reason_code: input.reason_code,
    expiry_at: input.expiry_at,
  }, config, clients, (context) => {
    // applyRedactionTombstone 同一事务撤下 Report/index/FTS；这样在线删除与旧快照 replay
    // 走同一个 fail-closed reader 收口点，不能出现“登记已回放但正文重新公开”。
    appendAudit(db, {
      actor: input.actor_id,
      action: "report_redacted",
      target: input.report_id,
      detail: { reason_code: input.reason_code, record_id: context.record_id, deletion_request_id: input.deletion_request_id },
    });
  });
  return { kind: "redacted", record_id: registered.record_id, already_redacted: registered.already_registered || report.status === "deleted" };
}
