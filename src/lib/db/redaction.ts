/** 本地 tombstone 读写原语。写入口只供已验证外部 registry 的恢复/删除事务调用；本身不做外部 I/O。 */
import type { DB } from "./index.js";

export interface RedactionTombstone {
  record_id: string;
  entity_key: string;
  scope: string;
  reason_code: string;
  effective_at: string;
  expiry_at: string;
  registry_ref: string;
}

/** 恢复 runner 与删除工作流的第二步；UNIQUE 让同一 registry record 重放幂等。 */
export function applyRedactionTombstone(db: DB, tombstone: RedactionTombstone): void {
  const inserted = db.prepare(`INSERT INTO provenance_redaction
    (record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_ref,created_at)
    VALUES (@record_id,@entity_key,@scope,@reason_code,@effective_at,@expiry_at,@registry_ref,@created_at)
    ON CONFLICT(record_id) DO NOTHING`).run({ ...tombstone, created_at: new Date().toISOString() });
  // 旧 SQLite 快照会带回已发布 Report 的正文/index/FTS；registry replay 不仅要记录
  // tombstone，还必须在同一事务撤下所有本地 reader 的派生读模型。
  if (inserted.changes === 1 && tombstone.scope === "report" && /^report:[A-Za-z0-9_-]+$/.test(tombstone.entity_key)) {
    const reportId = tombstone.entity_key.slice("report:".length);
    db.prepare("UPDATE report SET status='deleted', body_path=NULL WHERE id=? AND status <> 'deleted'").run(reportId);
    db.prepare("DELETE FROM report_fts WHERE report_id=?").run(reportId);
    db.prepare("DELETE FROM report_index WHERE report_id=?").run(reportId);
    db.prepare("DELETE FROM ppt_polish_cache WHERE report_id=?").run(reportId);
  }
}

/** Resolver 的唯一 redaction 判定：记录生效且未过期即返回 tombstone，调用方不得再读取业务正文。 */
export function activeRedaction(
  db: DB,
  entityKey: string,
  now = new Date().toISOString(),
): Pick<RedactionTombstone, "scope" | "reason_code" | "effective_at"> | null {
  const row = db.prepare(`SELECT scope,reason_code,effective_at FROM provenance_redaction
    WHERE entity_key=? AND effective_at <= ? AND expiry_at > ? ORDER BY effective_at DESC LIMIT 1`)
    .get(entityKey, now, now) as Pick<RedactionTombstone, "scope" | "reason_code" | "effective_at"> | undefined;
  return row ?? null;
}
