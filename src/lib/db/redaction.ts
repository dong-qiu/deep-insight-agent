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

/** Validate without rewriting the immutable signed timestamp. */
export function redactionUtc(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error("redaction_time_invalid");
  const time = Date.parse(value);
  const canonical = value.length === 20 ? value.slice(0, -1) + ".000Z" : value;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) throw new Error("redaction_time_invalid");
  return time;
}

/** Local reader protection only, not proof of external registry coverage. */
export function reportRedactionVisibilitySql(db: DB, reportIdColumn: string): string {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provenance_redaction'").get()) return "1=1";
  return `NOT EXISTS (SELECT 1 FROM provenance_redaction pr WHERE pr.scope='report'
    AND pr.entity_key='report:' || ${reportIdColumn}
    AND (julianday(pr.effective_at) IS NULL OR julianday(pr.effective_at)<=julianday('now'))) `;
}

export function assertReportNotRedacted(db: DB, reportId: string): void {
  const row = db.prepare(`SELECT ${reportRedactionVisibilitySql(db, "candidate.report_id")} AS visible FROM (SELECT ? AS report_id) candidate`).get(reportId) as { visible: number };
  if (!row.visible) throw new Error("report_redacted");
}

/** Registry fact and projection repair form one transaction, including valid retries. */
export function applyRedactionTombstone(db: DB, tombstone: RedactionTombstone): void {
  const effective = redactionUtc(tombstone.effective_at);
  if (redactionUtc(tombstone.expiry_at) <= effective) throw new Error("redaction_time_invalid");
  if (tombstone.scope === "report" && !/^report:[A-Za-z0-9_-]+$/.test(tombstone.entity_key)) throw new Error("redaction_report_key_invalid");
  db.transaction(() => {
    const existing = db.prepare("SELECT record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_ref FROM provenance_redaction WHERE record_id=? OR (entity_key=? AND scope=?)")
      .all(tombstone.record_id, tombstone.entity_key, tombstone.scope) as RedactionTombstone[];
    const fields: (keyof RedactionTombstone)[] = ["record_id", "entity_key", "scope", "reason_code", "effective_at", "expiry_at", "registry_ref"];
    if (existing.some((row) => fields.some((key) => row[key] !== tombstone[key]))) throw new Error("redaction_record_conflict");
    if (existing.length === 0) db.prepare(`INSERT INTO provenance_redaction
      (record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_ref,created_at)
      VALUES (@record_id,@entity_key,@scope,@reason_code,@effective_at,@expiry_at,@registry_ref,@created_at)
      ON CONFLICT(record_id) DO NOTHING`).run({ ...tombstone, created_at: new Date().toISOString() });
    // 旧 SQLite 快照会带回已发布 Report 的正文/index/FTS；registry replay 不仅要记录
    // tombstone，还必须在同一事务撤下所有本地 reader 的派生读模型。
    if (tombstone.scope === "report" && (db.prepare("SELECT julianday(?)<=julianday('now') AS due").get(tombstone.effective_at) as { due: number }).due) {
      const reportId = tombstone.entity_key.slice("report:".length);
      db.prepare("UPDATE report SET status='deleted', body_path=NULL WHERE id=?").run(reportId);
      db.prepare("DELETE FROM report_fts WHERE report_id=?").run(reportId);
      db.prepare("DELETE FROM report_index WHERE report_id=?").run(reportId);
      db.prepare("DELETE FROM report_review_snapshot WHERE report_id=?").run(reportId);
      db.prepare("DELETE FROM report_selection_decision WHERE report_id=?").run(reportId);
      db.prepare("DELETE FROM ppt_polish_cache WHERE report_id=?").run(reportId);
    }
  }).immediate();
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
