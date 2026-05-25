/** report-gen —— 报告生成 agent（architecture 数据流第 4 步）。
 *  洞察级纳入判定 → 组织 Report（Markdown + 自包含 HTML）→ 派生 ReportIndexEntry。
 *  MVP 为确定性模板（无 LLM，可无 key 全测）；LLM 叙述润色留后续迭代。 */
import { randomUUID } from "node:crypto";
import type {
  AnalysisBatch, ContentItem, Insight, Report, ReportIndexEntry, Topic, ValidationResult,
} from "../types.js";

export interface IncludedInsight {
  insight: Insight;
  citationIndices: number[]; // 剔除 blocked 后保留的引用下标
  flagged: boolean; // 含 uncertain（待核实）引用
}

/** 洞察级纳入判定（architecture「校验结果·洞察级纳入判定」）：
 *  剔除 verdict=blocked 的引用；剩余 ≥1 则纳入（含 flagged 标待核实），全 blocked 则排除。 */
export function selectInsights(batch: AnalysisBatch, validation: ValidationResult): IncludedInsight[] {
  const verdictOf = new Map<string, Map<number, string>>();
  for (const c of validation.checks) {
    if (!verdictOf.has(c.insight_id)) verdictOf.set(c.insight_id, new Map());
    verdictOf.get(c.insight_id)!.set(c.citation_index, c.verdict);
  }
  const out: IncludedInsight[] = [];
  for (const ins of batch.insights) {
    const vs = verdictOf.get(ins.id);
    const kept: number[] = [];
    let flagged = false;
    ins.citations.forEach((_, i) => {
      const v = vs?.get(i);
      // 白名单:只有明确 pass/flagged 才纳入;blocked 与「无 check(未校验)」一律剔除
      if (v !== "pass" && v !== "flagged") return;
      kept.push(i);
      if (v === "flagged") flagged = true;
    });
    if (kept.length >= 1) out.push({ insight: ins, citationIndices: kept, flagged });
  }
  return out;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const TYPE_LABEL: Record<Report["type"], string> = {
  brief: "今日 Brief",
  deep_dive: "深度报告",
  initial_digest: "首版综述",
};

export interface BuildReportInput {
  topic: Topic;
  batch: AnalysisBatch;
  validation: ValidationResult;
  type: Report["type"];
  /** content_item_id → {source_id, tags}，用于派生 source_ids / tags */
  contentLookup: Map<string, Pick<ContentItem, "source_id" | "tags">>;
  prevReportId?: string | null;
  now?: string; // 注入时间便于测试
}

export function buildReport(input: BuildReportInput): { report: Report; index: ReportIndexEntry } {
  const included = selectInsights(input.batch, input.validation);
  const id = `rep_${randomUUID().slice(0, 8)}`;
  const now = input.now ?? new Date().toISOString();
  const date = now.slice(0, 10);
  const title = `${input.topic.name} · ${TYPE_LABEL[input.type]} · ${date}`;

  const citedItemIds = included.flatMap((x) =>
    x.citationIndices.map((i) => x.insight.citations[i].content_item_id),
  );
  const sourceIds = uniq(
    citedItemIds.map((cid) => input.contentLookup.get(cid)?.source_id).filter((s): s is string => !!s),
  );
  const tags = uniq(citedItemIds.flatMap((cid) => input.contentLookup.get(cid)?.tags ?? []));
  const eventIds = uniq(included.map((x) => x.insight.event_id).filter((e): e is string => !!e));
  const importance = included.length ? Math.max(...included.map((x) => x.insight.importance)) : 0;
  const summary = included.slice(0, 3).map((x) => x.insight.statement).join(" ");

  const report: Report = {
    id, type: input.type, topic_id: input.topic.id, status: "done", generated_at: now, title,
    body_md: renderMarkdown(title, input.topic, included, date),
    body_html: renderHtml(title, input.topic, included, date),
    insight_ids: included.map((x) => x.insight.id),
    event_ids: eventIds,
    prev_report_id: input.prevReportId ?? null,
    citation_count: included.reduce((s, x) => s + x.citationIndices.length, 0),
    cost: { tokens: 0, amount: 0 },
  };
  const index: ReportIndexEntry = {
    report_id: id, type: input.type, topic_id: input.topic.id, industry: input.topic.industry, date,
    source_ids: sourceIds, title, summary, tags, entity_names: [], importance, event_ids: eventIds,
  };
  return { report, index };
}

function renderMarkdown(title: string, topic: Topic, included: IncludedInsight[], date: string): string {
  const L: string[] = [
    `# ${title}`,
    "",
    `> 主题：${topic.name}（${topic.industry}）· 生成于 ${date} · 共 ${included.length} 条洞察`,
    "",
  ];
  if (!included.length) {
    L.push("_本期无重要事件。_");
    return L.join("\n");
  }
  included.forEach((x, n) => {
    const ins = x.insight;
    L.push(`## ${n + 1}. ${ins.statement}${x.flagged ? " 〔待核实〕" : ""}`, "");
    L.push(`- 重要性：${ins.importance}/5 · 依据：${ins.importance_basis}`);
    if (ins.type === "trend" && ins.confidence) L.push(`- 置信度：${ins.confidence}`);
    L.push(`- 引用（${x.citationIndices.length}）：`);
    for (const i of x.citationIndices) {
      const c = ins.citations[i];
      L.push(`  - 「${c.quote}」— \`${c.content_item_id}\``);
    }
    L.push("");
  });
  return L.join("\n");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderHtml(title: string, topic: Topic, included: IncludedInsight[], date: string): string {
  const body = included.length
    ? included
        .map((x, n) => {
          const ins = x.insight;
          const cites = x.citationIndices
            .map((i) => {
              const c = ins.citations[i];
              return `<li><q>${esc(c.quote)}</q> <code>${esc(c.content_item_id)}</code></li>`;
            })
            .join("");
          const conf = ins.type === "trend" && ins.confidence ? ` · 置信度 ${ins.confidence}` : "";
          return `<section><h2>${n + 1}. ${esc(ins.statement)}${
            x.flagged ? ' <span class="flag">待核实</span>' : ""
          }</h2><p class="meta">重要性 ${ins.importance}/5 · ${esc(ins.importance_basis)}${conf}</p><ul>${cites}</ul></section>`;
        })
        .join("\n")
    : "<p><em>本期无重要事件。</em></p>";
  return `<!doctype html><html lang="${topic.language}"><head><meta charset="utf-8"><title>${esc(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.5rem}.meta{color:#666;font-size:.9rem}.flag{color:#b45309;font-size:.75rem;border:1px solid #b45309;border-radius:4px;padding:0 .3rem}q{color:#1f2937}code{color:#6b7280;font-size:.85rem}</style></head><body><h1>${esc(
    title,
  )}</h1><p class="meta">${esc(topic.name)}（${topic.industry}）· ${date} · 共 ${included.length} 条洞察</p>${body}</body></html>`;
}
