/**
 * Immutable P0c reader snapshot used only by the relative reader-performance
 * gate.  It is the `getReport` reader from commit
 * e1ca9d0526f6635b0b8c9da13958bafc45a898d1 (the P0c bounded-views merge).
 *
 * Do not modify this implementation: introduce a new fixture/version when a
 * new approved baseline is needed.  Keeping the reader here makes CI compare
 * both implementations in one process, on one dataset and filesystem cache.
 */
import { readFileSync } from "node:fs";
import type { Report } from "../types.js";
import type { DB } from "./index.js";

export const P0C_READER_BASELINE_COMMIT = "e1ca9d0526f6635b0b8c9da13958bafc45a898d1";

export function getP0cBaselineReport(db: DB, id: string): Report | null {
  const r = db.prepare("SELECT * FROM report WHERE id = ? AND status = 'done'").get(id) as any;
  if (!r) return null;
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
    title: r.title, body_md, body_html,
    insight_ids: JSON.parse(r.insight_ids), event_ids: JSON.parse(r.event_ids),
    prev_report_id: r.prev_report_id ?? null, citation_count: r.citation_count, cost: JSON.parse(r.cost),
  };
}
