/** AnalysisBatch / ValidationResult 持久化（事务写）。增量4。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AnalysisBatch, Insight, ValidationResult } from "../types.js";
import type { DB } from "./index.js";

const j = (v: unknown): string => JSON.stringify(v);
const b = (v: boolean): number => (v ? 1 : 0);

/** insight 表行（SELECT * 形状）——给 rowToInsight 用，替代 `as any` 裸行。 */
export interface InsightRow {
  id: string;
  topic_id: string;
  type: Insight["type"];
  event_id: string | null;
  statement: string;
  headline: string | null;
  importance: number;
  importance_basis: string;
  source_count: number;
  multi_source: number; // 0/1
  time_window: string; // JSON
  confidence: string | null;
  language: Insight["language"];
  is_followup: number | null; // 0/1
  entities: string | null; // JSON
  tags: string | null; // JSON
}
interface CitationRow {
  content_item_id: string;
  quote: string;
  locator: string; // JSON
}

/** insight 行 + 其 citation → Insight 对象（单一来源；原 analysis/graph/ppt-export 四处拷贝收敛于此）。
 *  17 字段装配 + JSON.parse + 0/1→bool 都在这一处，加字段只改这里、不会漏改某处静默丢字段。 */
export function rowToInsight(db: DB, r: InsightRow): Insight {
  const cits = db
    .prepare("SELECT * FROM citation WHERE insight_id = ? ORDER BY citation_index")
    .all(r.id) as CitationRow[];
  return {
    id: r.id,
    topic_id: r.topic_id,
    type: r.type,
    event_id: r.event_id ?? null,
    statement: r.statement,
    headline: r.headline ?? "",
    importance: r.importance,
    importance_basis: r.importance_basis,
    citations: cits.map((c) => ({ content_item_id: c.content_item_id, quote: c.quote, locator: JSON.parse(c.locator) })),
    source_count: r.source_count,
    multi_source: r.multi_source === 1,
    time_window: JSON.parse(r.time_window),
    confidence: (r.confidence ?? null) as Insight["confidence"],
    language: r.language,
    is_followup: r.is_followup === 1,
    entities: JSON.parse(r.entities ?? "[]"),
    tags: JSON.parse(r.tags ?? "[]"),
  };
}

export function saveAnalysisBatch(db: DB, batch: AnalysisBatch): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO analysis_batch (id,topic_id,time_window,status,no_significant_event)
       VALUES (@id,@topic_id,@time_window,@status,@nse)`,
    ).run({
      id: batch.id, topic_id: batch.topic_id, time_window: j(batch.time_window),
      status: batch.status, nse: b(batch.no_significant_event),
    });
    const insStmt = db.prepare(
      `INSERT INTO insight
         (id,batch_id,topic_id,type,event_id,statement,headline,importance,importance_basis,source_count,multi_source,time_window,confidence,language,is_followup,entities,tags)
       VALUES (@id,@batch_id,@topic_id,@type,@event_id,@statement,@headline,@importance,@importance_basis,@source_count,@multi_source,@time_window,@confidence,@language,@is_followup,@entities,@tags)`,
    );
    const citStmt = db.prepare(
      `INSERT INTO citation (insight_id,citation_index,content_item_id,quote,locator)
       VALUES (@insight_id,@citation_index,@content_item_id,@quote,@locator)`,
    );
    for (const ins of batch.insights) {
      insStmt.run({
        id: ins.id, batch_id: batch.id, topic_id: ins.topic_id, type: ins.type, event_id: ins.event_id,
        statement: ins.statement, headline: ins.headline ?? "", importance: ins.importance, importance_basis: ins.importance_basis,
        source_count: ins.source_count, multi_source: b(ins.multi_source),
        time_window: j(ins.time_window), confidence: ins.confidence, language: ins.language,
        is_followup: b(ins.is_followup ?? false), entities: j(ins.entities ?? []), tags: j(ins.tags ?? []),
      });
      ins.citations.forEach((c, i) =>
        citStmt.run({
          insight_id: ins.id, citation_index: i, content_item_id: c.content_item_id,
          quote: c.quote, locator: j(c.locator),
        }),
      );
    }
  })();
}

export function getAnalysisBatch(db: DB, id: string): AnalysisBatch | null {
  const br = db.prepare("SELECT * FROM analysis_batch WHERE id = ?").get(id) as any;
  if (!br) return null;
  const insRows = db.prepare("SELECT * FROM insight WHERE batch_id = ? ORDER BY rowid").all(id) as InsightRow[];
  const insights: Insight[] = insRows.map((r) => rowToInsight(db, r));
  return {
    id: br.id, topic_id: br.topic_id, time_window: JSON.parse(br.time_window), status: br.status,
    no_significant_event: br.no_significant_event === 1, insights,
  };
}

/** 按 id 列表取洞察及其引用（追问按 report.insight_ids 取引用池用）。
 *  报告只存 insight_ids、不存 batch_id，故按 id 直取 insight 表 + 联 citation。
 *  返回顺序与传入 ids 一致（保留报告内洞察顺序）；缺失的 id 跳过。 */
export function getInsightsByIds(db: DB, ids: string[]): Insight[] {
  const out: Insight[] = [];
  const insStmt = db.prepare("SELECT * FROM insight WHERE id = ?");
  for (const id of ids) {
    const r = insStmt.get(id) as InsightRow | undefined;
    if (!r) continue;
    out.push(rowToInsight(db, r));
  }
  return out;
}

export function saveValidationResult(db: DB, batchId: string, vr: ValidationResult): void {
  db.transaction(() => {
    const r = vr.report;
    db.prepare(
      `INSERT INTO validation_result
         (batch_id,total,pass,blocked,flagged,errored,consistency_failure_rate,flagged_rate,insights_total,insights_includable,releasable)
       VALUES (@batch_id,@total,@pass,@blocked,@flagged,@errored,@cfr,@fr,@it,@ii,@releasable)`,
    ).run({
      batch_id: batchId, total: r.total, pass: r.pass, blocked: r.blocked, flagged: r.flagged,
      errored: r.errored, cfr: r.consistency_failure_rate, fr: r.flagged_rate,
      it: r.insights_total, ii: r.insights_includable, releasable: b(r.releasable),
    });
    const ck = db.prepare(
      `INSERT INTO citation_check
         (batch_id,insight_id,citation_index,reachability,reachability_reason,consistency,consistency_reason,verdict)
       VALUES (@batch_id,@insight_id,@citation_index,@reachability,@reachability_reason,@consistency,@consistency_reason,@verdict)`,
    );
    for (const c of vr.checks) ck.run({ batch_id: batchId, ...c });
  })();
}

export function getValidationResult(db: DB, batchId: string): ValidationResult | null {
  const rr = db.prepare("SELECT * FROM validation_result WHERE batch_id = ?").get(batchId) as any;
  if (!rr) return null;
  const checks = db
    .prepare("SELECT * FROM citation_check WHERE batch_id = ? ORDER BY rowid")
    .all(batchId) as any[];
  return {
    checks: checks.map((c) => ({
      insight_id: c.insight_id, citation_index: c.citation_index, reachability: c.reachability,
      reachability_reason: c.reachability_reason, consistency: c.consistency,
      consistency_reason: c.consistency_reason, verdict: c.verdict,
    })),
    // 全部护栏字段同源自 validation_result 行（写时由 summarize 一次性算定）：内部自洽、可 SQL 查、审计保真
    report: {
      total: rr.total, pass: rr.pass, blocked: rr.blocked, flagged: rr.flagged,
      errored: rr.errored ?? 0, consistency_failure_rate: rr.consistency_failure_rate, flagged_rate: rr.flagged_rate,
      insights_total: rr.insights_total, insights_includable: rr.insights_includable,
      releasable: rr.releasable === 1,
    },
  };
}
