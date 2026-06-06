/** 报告持久化：正文（.md/.html）落 FS，元数据 + 索引 + FTS5 落 SQLite。增量5。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report, ReportIndexEntry } from "../types.js";
import type { DB } from "./index.js";

const j = (v: unknown): string => JSON.stringify(v);

function defaultBodyDir(): string {
  return join(process.env.DATA_DIR ?? ".data", "reports");
}

/** 写正文到 FS + 落 report / report_index / report_fts。dir 可注入（测试用临时目录）。 */
export function saveReport(
  db: DB,
  report: Report,
  index: ReportIndexEntry,
  opts: { dir?: string } = {},
): void {
  const dir = opts.dir ?? defaultBodyDir();
  mkdirSync(dir, { recursive: true });
  const prefix = join(dir, report.id);
  writeFileSync(`${prefix}.md`, report.body_md);
  writeFileSync(`${prefix}.html`, report.body_html);

  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost)
         VALUES (@id,@type,@topic_id,@status,@generated_at,@title,@body_path,@insight_ids,@event_ids,@prev_report_id,@citation_count,@cost)`,
      ).run({
        id: report.id, type: report.type, topic_id: report.topic_id, status: report.status,
        generated_at: report.generated_at, title: report.title, body_path: prefix,
        insight_ids: j(report.insight_ids), event_ids: j(report.event_ids),
        prev_report_id: report.prev_report_id, citation_count: report.citation_count, cost: j(report.cost),
      });
      db.prepare(
        `INSERT INTO report_index (report_id,type,topic_id,industry,date,source_ids,title,summary,tags,entity_names,importance,event_ids)
         VALUES (@report_id,@type,@topic_id,@industry,@date,@source_ids,@title,@summary,@tags,@entity_names,@importance,@event_ids)`,
      ).run({
        report_id: index.report_id, type: index.type, topic_id: index.topic_id, industry: index.industry,
        date: index.date, source_ids: j(index.source_ids), title: index.title, summary: index.summary,
        tags: j(index.tags), entity_names: j(index.entity_names), importance: index.importance,
        event_ids: j(index.event_ids),
      });
      db.prepare(`INSERT INTO report_fts (report_id,title,summary,body) VALUES (?,?,?,?)`).run(
        report.id, index.title, index.summary, report.body_md,
      );
    })();
  } catch (e) {
    // 落库失败：清理已写出的 FS 正文，避免 DB 无行但磁盘有孤儿文件
    for (const ext of [".md", ".html"]) rmSync(`${prefix}${ext}`, { force: true });
    throw e;
  }
}

export function getReport(db: DB, id: string): Report | null {
  const r = db.prepare("SELECT * FROM report WHERE id = ?").get(id) as any;
  if (!r) return null;
  // FS 正文兜底：DB 有行但磁盘正文缺失（写盘中断 / 卷未挂 / 手动删除）时不抛、不让阅读页崩，
  // 返回占位正文并告警，由看板/重生流程兜底。
  let body_md: string;
  let body_html: string;
  try {
    body_md = readFileSync(`${r.body_path}.md`, "utf8");
    body_html = readFileSync(`${r.body_path}.html`, "utf8");
  } catch (e) {
    console.warn(`getReport: 报告 ${id} 正文文件缺失（${r.body_path}.*）：${(e as Error).message}`);
    body_md = `# ${r.title}\n\n_正文文件缺失，请重新生成本报告。_`;
    body_html = `<h1>${r.title}</h1><p><em>正文文件缺失，请重新生成本报告。</em></p>`;
  }
  return {
    id: r.id, type: r.type, topic_id: r.topic_id, status: r.status, generated_at: r.generated_at,
    title: r.title,
    body_md,
    body_html,
    insight_ids: JSON.parse(r.insight_ids), event_ids: JSON.parse(r.event_ids),
    prev_report_id: r.prev_report_id ?? null, citation_count: r.citation_count, cost: JSON.parse(r.cost),
  };
}

/** 该主题是否已有任意报告——冷启动检测（无 → 首版综述 initial_digest）。 */
export function topicHasReport(db: DB, topicId: string): boolean {
  return !!db.prepare("SELECT 1 FROM report WHERE topic_id = ? LIMIT 1").get(topicId);
}

/** 校验下钻条目：本报告涉及洞察的所有被 validator 屏蔽的引用（含理由与 quote 全文）。
 *  - 经 report.insight_ids → insight.batch_id 关联到 citation_check；
 *  - 联表 citation 拿原始 quote 与 content_item_id；
 *  - 评审用：让"不可见的把关"可下钻，外露 validator 真实抓到的具体案例。 */
export interface BlockedCheck {
  insight_id: string;
  statement: string; // 洞察 statement（截断由 UI 决定）
  citation_index: number;
  quote: string;
  content_item_id: string;
  reachability: "pass" | "fail";
  reachability_reason: string;
  consistency: "support" | "not_support" | "uncertain" | "not_evaluated";
  consistency_reason: string;
  reason: string; // 选定的真实理由（reachability fail → reachability_reason；否则 → consistency_reason）
}

export function listBlockedChecksForReport(db: DB, reportId: string): BlockedCheck[] {
  const rows = db.prepare(`
    SELECT
      cc.insight_id AS insight_id,
      i.statement AS statement,
      cc.citation_index AS citation_index,
      c.quote AS quote,
      c.content_item_id AS content_item_id,
      cc.reachability AS reachability,
      cc.reachability_reason AS reachability_reason,
      cc.consistency AS consistency,
      cc.consistency_reason AS consistency_reason
    FROM report r
    JOIN insight i ON instr(r.insight_ids, '"' || i.id || '"') > 0
    JOIN citation_check cc ON cc.insight_id = i.id
    JOIN citation c ON c.insight_id = cc.insight_id AND c.citation_index = cc.citation_index
    WHERE r.id = ? AND cc.verdict = 'blocked'
    ORDER BY i.id, cc.citation_index
  `).all(reportId) as Omit<BlockedCheck, "reason">[];
  return rows.map((r) => ({
    ...r,
    reason: r.reachability === "fail" ? r.reachability_reason : r.consistency_reason,
  }));
}

/** FTS5 全文检索，按相关度返回 report_id。 */
export function searchReports(db: DB, query: string): string[] {
  const rows = db
    .prepare("SELECT report_id FROM report_fts WHERE report_fts MATCH ? ORDER BY rank")
    .all(query) as any[];
  return rows.map((x) => x.report_id as string);
}

/** 报告索引列表（报告库列表/筛选用），按日期倒序。 */
export function listReportIndex(db: DB, opts: { limit?: number } = {}): ReportIndexEntry[] {
  const rows = db
    .prepare("SELECT * FROM report_index ORDER BY date DESC LIMIT ?")
    .all(opts.limit ?? 100) as any[];
  return rows.map(rowToIndex);
}

function rowToIndex(r: any): ReportIndexEntry {
  return {
    report_id: r.report_id, type: r.type, topic_id: r.topic_id, industry: r.industry, date: r.date,
    source_ids: JSON.parse(r.source_ids), title: r.title, summary: r.summary,
    tags: JSON.parse(r.tags), entity_names: JSON.parse(r.entity_names), importance: r.importance,
    event_ids: JSON.parse(r.event_ids),
  };
}

/** 报告库查询：FTS5 + 筛选 + 排序。
 *  - q: 走 FTS5 → 取 report_id 集合再过滤；
 *  - type / industry / from / to (yyyy-mm-dd inclusive)：白名单 + 参数化 SQL；
 *  - sort: "date"|"importance"，dir: "asc"|"desc"，默认 date desc。
 *  - 无效字段静默忽略走默认（UI 不应被 400 打断）。 */
export interface ReportQuery {
  q?: string;
  type?: string;
  industry?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  limit?: number;
}
export function queryReportIndex(db: DB, opts: ReportQuery = {}): ReportIndexEntry[] {
  const where: string[] = [];
  const args: unknown[] = [];

  if (opts.type && ["brief", "deep_dive", "initial_digest"].includes(opts.type)) {
    where.push("type = ?"); args.push(opts.type);
  }
  if (opts.industry) {
    where.push("industry = ?"); args.push(opts.industry);
  }
  if (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) {
    where.push("date >= ?"); args.push(opts.from);
  }
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
    where.push("date <= ?"); args.push(opts.to);
  }

  // FTS5 子查询：q 命中走 report_fts，取 report_id 集合后 IN 过滤
  if (opts.q && opts.q.trim()) {
    where.push("report_id IN (SELECT report_id FROM report_fts WHERE report_fts MATCH ?)");
    args.push(opts.q.trim());
  }

  const sortCol = opts.sort === "importance" ? "importance" : "date";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const tiebreak = sortCol === "importance" ? ", date DESC" : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const sql = `SELECT * FROM report_index ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY ${sortCol} ${dir}${tiebreak} LIMIT ${limit}`;
  return (db.prepare(sql).all(...args) as any[]).map(rowToIndex);
}
