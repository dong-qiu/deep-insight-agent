/** 报告持久化：正文（.md/.html）落 FS，元数据 + 索引 + FTS5 落 SQLite。增量5。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
}

export function getReport(db: DB, id: string): Report | null {
  const r = db.prepare("SELECT * FROM report WHERE id = ?").get(id) as any;
  if (!r) return null;
  return {
    id: r.id, type: r.type, topic_id: r.topic_id, status: r.status, generated_at: r.generated_at,
    title: r.title,
    body_md: readFileSync(`${r.body_path}.md`, "utf8"),
    body_html: readFileSync(`${r.body_path}.html`, "utf8"),
    insight_ids: JSON.parse(r.insight_ids), event_ids: JSON.parse(r.event_ids),
    prev_report_id: r.prev_report_id ?? null, citation_count: r.citation_count, cost: JSON.parse(r.cost),
  };
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
  return rows.map((r) => ({
    report_id: r.report_id, type: r.type, topic_id: r.topic_id, industry: r.industry, date: r.date,
    source_ids: JSON.parse(r.source_ids), title: r.title, summary: r.summary,
    tags: JSON.parse(r.tags), entity_names: JSON.parse(r.entity_names), importance: r.importance,
    event_ids: JSON.parse(r.event_ids),
  }));
}
