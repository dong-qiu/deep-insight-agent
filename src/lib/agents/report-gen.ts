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
  blockedCount: number; // 被 validator 屏蔽的引用数（不在 citationIndices 内）
  blockedReasonCounts: Record<string, number>; // 屏蔽理由直方图（如 exaggeration→2、out_of_context→1）
}

/** verdict=blocked 时取真实理由：reachability=fail → reachability_reason；
 *  否则（reachability=pass 但 consistency=not_support）→ consistency_reason。
 *  "ok" 视为无信息（理论不应作为 blocked 理由出现，防御性跳过）。 */
function blockedReason(c: import("../types.js").CitationCheck): string | null {
  if (c.verdict !== "blocked") return null;
  const r = c.reachability === "fail" ? c.reachability_reason : c.consistency_reason;
  return r && r !== "ok" ? r : null;
}

/** 洞察级纳入判定（architecture「校验结果·洞察级纳入判定」）：
 *  剔除 verdict=blocked 的引用；剩余 ≥1 则纳入（含 flagged 标待核实），全 blocked 则排除。
 *  同时汇总被屏蔽数与理由直方图——供渲染端外露 validator 把关力度（透明信任信号）。 */
export function selectInsights(batch: AnalysisBatch, validation: ValidationResult): IncludedInsight[] {
  const checksByInsight = new Map<string, Map<number, import("../types.js").CitationCheck>>();
  for (const c of validation.checks) {
    if (!checksByInsight.has(c.insight_id)) checksByInsight.set(c.insight_id, new Map());
    checksByInsight.get(c.insight_id)!.set(c.citation_index, c);
  }
  const out: IncludedInsight[] = [];
  for (const ins of batch.insights) {
    const cs = checksByInsight.get(ins.id);
    const kept: number[] = [];
    let flagged = false;
    let blockedCount = 0;
    const blockedReasonCounts: Record<string, number> = {};
    ins.citations.forEach((_, i) => {
      const c = cs?.get(i);
      const v = c?.verdict;
      // 白名单:只有明确 pass/flagged 才纳入;blocked 与「无 check(未校验)」一律剔除
      if (v === "pass" || v === "flagged") {
        kept.push(i);
        if (v === "flagged") flagged = true;
      } else if (v === "blocked") {
        blockedCount += 1;
        const r = c ? blockedReason(c) : null;
        if (r) blockedReasonCounts[r] = (blockedReasonCounts[r] ?? 0) + 1;
      }
    });
    if (kept.length >= 1) out.push({ insight: ins, citationIndices: kept, flagged, blockedCount, blockedReasonCounts });
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
    body_md: renderMarkdown(title, input.topic, included, date, input.type !== "brief"),
    body_html: renderHtml(title, input.topic, included, date, input.type !== "brief"),
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

/** 屏蔽理由分布渲染（如 "exaggeration ×2 · out_of_context ×1"）。空理由不展示括号。 */
function blockedReasonStr(counts: Record<string, number>): string {
  const items = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return items.length ? `（理由：${items.map(([r, n]) => `${r} ×${n}`).join(" · ")}）` : "";
}

/** 单条洞察的 Markdown 块。deep_dive（detailed）多展示来源数 / 多源印证。 */
function insightBlockMd(x: IncludedInsight, heading: string, detailed: boolean): string[] {
  const ins = x.insight;
  const L = [`${heading} ${ins.statement}${x.flagged ? " 〔待核实〕" : ""}`, ""];
  L.push(`- 重要性：${ins.importance}/5 · 依据：${ins.importance_basis}`);
  if (detailed) L.push(`- 来源：${ins.source_count} 个 · ${ins.multi_source ? "多源印证" : "单源"}`);
  if (ins.type === "trend" && ins.confidence) L.push(`- 置信度：${ins.confidence}`);
  L.push(`- 引用（${x.citationIndices.length}）：`);
  for (const i of x.citationIndices) {
    const c = ins.citations[i];
    L.push(`  - 「${c.quote}」— \`${c.content_item_id}\``);
  }
  // 透明信任信号：validator 屏蔽计数 + 理由（仅在有屏蔽时展示，避免常态杂讯）
  if (x.blockedCount > 0) L.push(`- 校验阻断：${x.blockedCount} 条${blockedReasonStr(x.blockedReasonCounts)}`);
  L.push("");
  return L;
}

const KEY = (x: IncludedInsight): boolean => x.insight.importance >= 4;

function renderMarkdown(
  title: string,
  topic: Topic,
  included: IncludedInsight[],
  date: string,
  deep: boolean,
): string {
  const keyN = included.filter(KEY).length;
  const summary = `> 主题：${topic.name}（${topic.industry}）· 生成于 ${date} · 共 ${included.length} 条洞察${
    deep ? `（重点 ${keyN} 条）` : ""
  }`;
  const L: string[] = [`# ${title}`, "", summary, ""];
  if (!included.length) {
    L.push("_本期无重要事件。_");
    return L.join("\n");
  }
  if (!deep) {
    included.forEach((x, n) => L.push(...insightBlockMd(x, `## ${n + 1}.`, false)));
    return L.join("\n");
  }
  // deep_dive：按重要性分节（重点 / 其他），节内详版块
  const tiers = [
    { label: "重点关注", items: included.filter(KEY) },
    { label: "其他动态", items: included.filter((x) => !KEY(x)) },
  ];
  let n = 0;
  for (const t of tiers) {
    if (!t.items.length) continue;
    L.push(`## ${t.label}（${t.items.length}）`, "");
    for (const x of t.items) L.push(...insightBlockMd(x, `### ${(n += 1)}.`, true));
  }
  return L.join("\n");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 单条洞察的 HTML（tag = h2 brief / h3 deep_dive 节内）。detailed 多展示来源。 */
function insightHtml(x: IncludedInsight, n: number, tag: "h2" | "h3", detailed: boolean): string {
  const ins = x.insight;
  const cites = x.citationIndices
    .map((i) => {
      const c = ins.citations[i];
      return `<li><q>${esc(c.quote)}</q> <code>${esc(c.content_item_id)}</code></li>`;
    })
    .join("");
  const conf = ins.type === "trend" && ins.confidence ? ` · 置信度 ${ins.confidence}` : "";
  const src = detailed ? ` · 来源 ${ins.source_count}（${ins.multi_source ? "多源" : "单源"}）` : "";
  // 透明信任信号：validator 屏蔽计数 + 理由（仅在有屏蔽时展示）
  const blocked = x.blockedCount > 0
    ? `<p class="meta blocked">校验阻断：${x.blockedCount} 条${esc(blockedReasonStr(x.blockedReasonCounts))}</p>`
    : "";
  return `<section><${tag}>${n}. ${esc(ins.statement)}${
    x.flagged ? ' <span class="flag">待核实</span>' : ""
  }</${tag}><p class="meta">重要性 ${ins.importance}/5 · ${esc(ins.importance_basis)}${conf}${src}</p><ul>${cites}</ul>${blocked}</section>`;
}

function renderHtml(
  title: string,
  topic: Topic,
  included: IncludedInsight[],
  date: string,
  deep: boolean,
): string {
  let body: string;
  if (!included.length) {
    body = "<p><em>本期无重要事件。</em></p>";
  } else if (!deep) {
    body = included.map((x, n) => insightHtml(x, n + 1, "h2", false)).join("\n");
  } else {
    const tiers = [
      { label: "重点关注", items: included.filter(KEY) },
      { label: "其他动态", items: included.filter((x) => !KEY(x)) },
    ];
    let n = 0;
    body = tiers
      .filter((t) => t.items.length)
      .map(
        (t) =>
          `<h2>${esc(t.label)}（${t.items.length}）</h2>` +
          t.items.map((x) => insightHtml(x, (n += 1), "h3", true)).join("\n"),
      )
      .join("\n");
  }
  return `<!doctype html><html lang="${topic.language}"><head><meta charset="utf-8"><title>${esc(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.5rem}h3{font-size:1rem;margin-top:1rem}.meta{color:#666;font-size:.9rem}.meta.blocked{color:#6b7280;font-size:.8rem;margin-top:.25rem}.flag{color:#b45309;font-size:.75rem;border:1px solid #b45309;border-radius:4px;padding:0 .3rem}q{color:#1f2937}code{color:#6b7280;font-size:.85rem}</style></head><body><h1>${esc(
    title,
  )}</h1><p class="meta">${esc(topic.name)}（${topic.industry}）· ${date} · 共 ${included.length} 条洞察</p>${body}</body></html>`;
}
