/** report-gen —— 报告生成 agent（architecture 数据流第 4 步）。
 *  洞察级纳入判定 → 组织 Report（Markdown + 自包含 HTML）→ 派生 ReportIndexEntry。
 *  MVP 为确定性模板（无 LLM，可无 key 全测）；LLM 叙述润色留后续迭代。 */
import { randomUUID } from "node:crypto";
import type {
  AnalysisBatch, ContentItem, Insight, Report, ReportIndexEntry, Topic, ValidationResult,
} from "../types.js";
import { facetLabel } from "../topics/facets.js";
import { flagLabel, isIncludableCheck, isValidationError } from "../utils/citation-verdict.js";
import { coverageGaps, specificClaims } from "./analyzer.js";

/** 覆盖度外露（诚实兜底）：结论里未被**已渲染引用**（剔除 blocked 后）直接覆盖的具体数字/实体。
 *  只按真正进报告的 quote 算——被屏蔽的引用不在报告里，其覆盖不作数。返回缺口 token（空=全覆盖）。
 *  不自动补引（错补同形不同义会被 validator 放行、制造"点开看错"，见 analyzer.coverageGaps）。 */
function coverageGapTokens(x: IncludedInsight): string[] {
  const ins = x.insight;
  const ents = (ins.entities ?? []).map((e) => e.name);
  const quotes = x.citationIndices.map((i) => ins.citations[i].quote);
  return coverageGaps(ins.statement, ents, quotes);
}

export interface IncludedInsight {
  insight: Insight;
  citationIndices: number[]; // 剔除 blocked 后保留的引用下标（含校验失败引用，带标签展示）
  flaggedUncertain: boolean; // 含 genuine uncertain 引用（判官判原文信息不足）→「待核实」
  flaggedError: boolean; // 含一致性「校验失败」引用（调用出错，可重跑）→「校验失败·待重试」
  blockedCount: number; // 被 validator 屏蔽的引用数（不在 citationIndices 内）
  blockedReasonCounts: Record<string, number>; // 屏蔽理由直方图（如 exaggeration→2、out_of_context→1）
}

/** 里程碑判定的重要性下限（ADR-0006）：可调常量——6/23 看真实里程碑数量再校准（太严=永远没有、太松=稀释）。 */
export const MILESTONE_MIN_IMPORTANCE = 5;

/** 列表卡片要点上限（headline 方案）：卡片只展示前 N 条 headline 供扫读，其余留详情页。
 *  5 条够覆盖一期 brief 的重点又不至于把卡片撑回一面墙。 */
export const HIGHLIGHTS_MAX = 5;

/** 重点关注阈值（importance ≥ 此值）：详版/概览置顶（orderInsights）与推送 ⭐重点 分级**共用单一口径**，
 *  改一处两处同步、不漂移。 */
export const KEY_MIN_IMPORTANCE = 4;

/** 里程碑洞察判定（ADR-0006）：最高重要性 + 新事件（非追加）+ 具体事件聚合（非趋势）。
 *  纯函数、确定性——里程碑 =「主题里发生的重大新事件节点」；趋势变化已由焦点演化（ADR-0005）承载，故排除 trend。
 *  is_followup 仅在 brief 路径精准（analyzer 喂历史 event 池），deep_dive/initial_digest 默认 false，符合「首报即新事件」语义。 */
export function isMilestoneInsight(insight: Insight): boolean {
  return (
    insight.importance >= MILESTONE_MIN_IMPORTANCE &&
    !insight.is_followup &&
    insight.type === "aggregation"
  );
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
    let flaggedUncertain = false;
    let flaggedError = false;
    let includable = false; // ≥1 条「已成功校验」引用（pass / genuine uncertain）才纳入
    let blockedCount = 0;
    const blockedReasonCounts: Record<string, number> = {};
    ins.citations.forEach((_, i) => {
      const c = cs?.get(i);
      const v = c?.verdict;
      // 白名单:pass/flagged 进展示;blocked 与「无 check(未校验)」一律剔除
      if (v === "pass" || v === "flagged") {
        kept.push(i);
        // flagged 两类（验证器约定）：校验失败（isValidationError）vs genuine uncertain
        if (v === "flagged") {
          if (isValidationError(c!)) flaggedError = true;
          else flaggedUncertain = true;
        }
        if (isIncludableCheck(c!)) includable = true; // 校验失败不计入纳入闸门
      } else if (v === "blocked") {
        blockedCount += 1;
        const r = c ? blockedReason(c) : null;
        if (r) blockedReasonCounts[r] = (blockedReasonCounts[r] ?? 0) + 1;
      }
    });
    // 纳入需 ≥1 成功校验引用：唯一引用校验失败的洞察整条剔除（不发零成功校验内容，等重校验恢复）
    if (includable)
      out.push({ insight: ins, citationIndices: kept, flaggedUncertain, flaggedError, blockedCount, blockedReasonCounts });
  }
  return out;
}

/** 要点选取（详版 headlines 与推送要点**共用**）：纳入洞察按 importance 降序取前 HIGHLIGHTS_MAX。
 *  单点定义保证 report_index.highlights 与推送要点同源同序，不各写一套。 */
function pickHighlightInsights(included: IncludedInsight[]): IncludedInsight[] {
  return [...included].sort((a, b) => b.insight.importance - a.insight.importance).slice(0, HIGHLIGHTS_MAX);
}

/** 报告推送要点（供邮件/webhook 富渲染）：一条洞察 → 一句话要点。
 *  - `text`：headline（≤40 字扫读版，analyzer 产）缺失回退 statement——与 index.highlights 同口径；
 *  - `key`：是否重点关注（importance ≥ KEY_MIN_IMPORTANCE），供邮件 ⭐重点/动态 分级。 */
export interface ReportHighlight {
  text: string;
  importance: number;
  key: boolean;
}

/** 纯函数：批次 + 校验 → 排序后的推送要点清单（复用报告选取/排序，与 index.highlights 同源同序）。
 *  确定性、无 LLM——推送渠道据此把「一坨 summary」换成可扫读的分级要点。 */
export function reportHighlights(batch: AnalysisBatch, validation: ValidationResult): ReportHighlight[] {
  return pickHighlightInsights(selectInsights(batch, validation)).map((x) => ({
    text: x.insight.headline?.trim() || x.insight.statement,
    importance: x.insight.importance,
    key: x.insight.importance >= KEY_MIN_IMPORTANCE,
  }));
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const TYPE_LABEL: Record<Report["type"], string> = {
  brief: "今日 Brief",
  deep_dive: "深度报告",
  initial_digest: "首版综述",
};

/** 引用渲染所需信息（dogfood feedback：原 ci_xxx 给用户看太唐突，quote 应可点）。
 *  source_name 来自 Source 表的人可读名（"Hacker News" / "arXiv cs.AI 最新"…）；
 *  url 是 content_item 抓回时的源 URL，用作 quote 链接目标；
 *  published_at 用于显示日期，缺失时省略。 */
export interface CitationDisplay {
  source_id: string;
  source_name: string;
  tags: string[];
  url: string;
  published_at: string | null;
}

export interface BuildReportInput {
  topic: Topic;
  batch: AnalysisBatch;
  validation: ValidationResult;
  type: Report["type"];
  /** content_item_id → 展示元数据，用于派生 source_ids / tags + 渲染引用链接 */
  contentLookup: Map<string, CitationDisplay>;
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
  // 标签：以 analyzer 抽取的洞察主题标签为主（content_item.tags 多为空——RSS 少给 category），
  // 二者并集去重，供报告库「标签」维度筛选。
  const tags = uniq(
    [
      ...included.flatMap((x) => x.insight.tags ?? []),
      ...citedItemIds.flatMap((cid) => input.contentLookup.get(cid)?.tags ?? []),
    ]
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const eventIds = uniq(included.map((x) => x.insight.event_id).filter((e): e is string => !!e));
  const importance = included.length ? Math.max(...included.map((x) => x.insight.importance)) : 0;
  // 里程碑计数（ADR-0006）：纳入洞察中符合里程碑判定的条数，派生进 report_index 供主题页徽标/时间线。
  const milestoneCount = included.filter((x) => isMilestoneInsight(x.insight)).length;
  const summary = included.slice(0, 3).map((x) => x.insight.statement).join(" ");
  // 卡片要点列表（headline 方案）：按重要性降序取前 N 条洞察的一句话 headline，供列表卡片分点扫读，
  // 取代把多条长 statement 拼成一坨的 summary。headline 缺失（旧批次/未产出）则回退该条 statement。
  const highlights = pickHighlightInsights(included).map((x) => x.insight.headline?.trim() || x.insight.statement);
  // 实体追踪：跨纳入洞察聚合关键实体名（去重保序），供主题页「关键实体」按报告频次再聚合。
  const entityNames = uniq(included.flatMap((x) => (x.insight.entities ?? []).map((e) => e.name.trim()).filter(Boolean)));

  const report: Report = {
    id, type: input.type, topic_id: input.topic.id, status: "done", generated_at: now, title,
    body_md: renderMarkdown(title, input.topic, included, date, input.type !== "brief", input.contentLookup, input.batch.time_window),
    body_html: renderHtml(title, input.topic, included, date, input.type !== "brief", input.contentLookup),
    insight_ids: included.map((x) => x.insight.id),
    event_ids: eventIds,
    prev_report_id: input.prevReportId ?? null,
    citation_count: included.reduce((s, x) => s + x.citationIndices.length, 0),
    cost: { tokens: 0, amount: 0 },
  };
  const index: ReportIndexEntry = {
    report_id: id, type: input.type, topic_id: input.topic.id,
    // ADR-0010：报告分类维度取 topic.facets（rowToTopic 保证非空；Step2c 砍 industry 后这是唯一来源）。
    facets: input.topic.facets ?? [],
    date, source_ids: sourceIds, title, summary, highlights, tags, entity_names: entityNames, importance, event_ids: eventIds,
    milestone_count: milestoneCount,
  };
  return { report, index };
}

/** 屏蔽理由分布渲染（如 "exaggeration ×2 · out_of_context ×1"）。空理由不展示括号。 */
function blockedReasonStr(counts: Record<string, number>): string {
  const items = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return items.length ? `（理由：${items.map(([r, n]) => `${r} ×${n}`).join(" · ")}）` : "";
}

/** 把保留的引用按被引文档（content_item_id）分组、保留首次出现顺序。
 *  同一网页/论文的多条「覆盖度」逐字 quote 归一组，渲染时源名/日期只出现一次——
 *  避免「一条洞察挂 N 条引用、实则只来自 1 篇」被误读成 N 个独立来源（dogfood 反馈）。 */
function groupCitationsBySource(x: IncludedInsight): { itemId: string; indices: number[] }[] {
  const order: string[] = [];
  const byItem = new Map<string, number[]>();
  for (const i of x.citationIndices) {
    const id = x.insight.citations[i].content_item_id;
    if (!byItem.has(id)) {
      byItem.set(id, []);
      order.push(id);
    }
    byItem.get(id)!.push(i);
  }
  return order.map((id) => ({ itemId: id, indices: byItem.get(id)! }));
}

/** 启发式行内引用锚定（方案 A）：把每条引用的 [n] 放到它所覆盖的"具体声明 token"（数字/实体）
 *  在 statement 中的位置之后——复用与 coverageGaps 同口径的数字/实体覆盖判定。匹配不到 token 的引用
 *  （纯文字声明 / 中英表述对不上 / 同形 token 已被占用）回退到句末。纯函数、确定性、不改 analyzer 输出。
 *  cites 按渲染顺序，每项含全局显示编号 num；返回带行内 [n] 标记的 statement（末尾追加回退标记）。 */
export function inlineCitedStatement(
  statement: string,
  cites: { num: number; quote: string }[],
  entityNames: string[],
): string {
  if (!cites.length) return statement;
  const tokens = specificClaims(statement, entityNames); // statement 里需被覆盖的数字/实体 token
  const anchors: { end: number; num: number }[] = [];
  const trailing: number[] = [];
  const usedPos = new Set<number>();
  for (const c of cites) {
    const nq = c.quote.replace(/\s+/g, "");
    let bestPos = -1;
    let bestEnd = -1;
    for (const t of tokens) {
      if (!nq.includes(t.replace(/\s+/g, ""))) continue; // 此 quote 不覆盖该 token
      const pos = statement.indexOf(t);
      if (pos < 0 || usedPos.has(pos)) continue; // statement 里定位不到 / 该位置已被别的引用占用
      if (pos > bestPos) {
        // 取最靠后的可用 token——贴近最具体的值（如"得分 1507"的 1507 而非句首实体）
        bestPos = pos;
        bestEnd = pos + t.length;
      }
    }
    if (bestPos >= 0) {
      usedPos.add(bestPos);
      anchors.push({ end: bestEnd, num: c.num });
    } else {
      trailing.push(c.num); // 锚不到 → 回退句末
    }
  }
  anchors.sort((a, b) => a.end - b.end || a.num - b.num);
  let out = "";
  let cursor = 0;
  for (const a of anchors) {
    out += statement.slice(cursor, a.end) + `[${a.num}]`;
    cursor = a.end;
  }
  out += statement.slice(cursor);
  if (trailing.length) out += " " + trailing.map((n) => `[${n}]`).join("");
  return out;
}

/** 单条洞察的 Markdown 块。deep_dive（detailed）多展示来源数 / 多源印证。
 *  citeStart：全局连续引用编号起点（C-2 引用 [n] 行内 + 列表锚）；返回 next 让 caller 串联。 */
function insightBlockMd(
  x: IncludedInsight,
  heading: string,
  detailed: boolean,
  citeStart: number,
  lookup: Map<string, CitationDisplay>,
): { lines: string[]; next: number } {
  const ins = x.insight;
  // 引用按文档分组 + 渲染顺序（grouped-flat）；全局编号 numOf 供行内 [n] 与列表 [n] 共用、保持一致。
  const groups = groupCitationsBySource(x);
  const orderedCites = groups.flatMap((g) => g.indices);
  const numOf = new Map<number, number>();
  orderedCites.forEach((i, p) => numOf.set(i, citeStart + p));
  // 方案 A：行内引用锚定——[n] 放到对应声明 token 后，匹配不到回退句末（见 inlineCitedStatement）。
  const statementWithRefs = orderedCites.length
    ? inlineCitedStatement(
        ins.statement,
        orderedCites.map((i) => ({ num: numOf.get(i)!, quote: ins.citations[i].quote })),
        (ins.entities ?? []).map((e) => e.name),
      )
    : ins.statement;
  // P1 不复报：is_followup=true 标 〔更新〕——读者一眼看出"本条是已报告事件的新进展"。
  // analyzer 已在 prompt 层约束"无新进展则不出"，此标记仅作展示提示；与 flagLabel（待核实
  // / 校验失败·待重试）相互正交、可同时出现："〔更新〕 〔待核实〕"。
  const followupTag = ins.is_followup ? " 〔更新〕" : "";
  const label = flagLabel(x);
  const flaggedTag = label ? ` 〔${label}〕` : "";
  // 覆盖度外露：结论里有具体数字/实体未被已渲染引用覆盖 → 标 〔待补引：…〕（与 〔更新〕/〔待核实〕正交可叠加）
  const gaps = coverageGapTokens(x);
  const coverageTag = gaps.length ? ` 〔待补引：${gaps.join("、")}〕` : "";
  const L = [`${heading} ${statementWithRefs}${followupTag}${flaggedTag}${coverageTag}`, ""];
  L.push(`- 重要性：${ins.importance}/5 · 依据：${ins.importance_basis}`);
  if (detailed) L.push(`- 来源：${ins.source_count} 个 · ${ins.multi_source ? "多源印证" : "单源"}`);
  if (ins.type === "trend" && ins.confidence) L.push(`- 置信度：${ins.confidence}`);
  if (orderedCites.length > 0) {
    // 诚实信号：N 句引用来自 K 篇文档——把"同篇多句覆盖引用"与"多个独立来源"分清，
    // 避免一条洞察挂多条引用、实则只来自 1 篇被误读为多源（dogfood 反馈）。
    L.push(`- 引用：${x.citationIndices.length} 句 · 来自 ${groups.length} 篇${groups.length >= 2 ? "（多篇印证）" : ""}`);
    for (const g of groups) {
      const info = lookup.get(g.itemId);
      // 每篇一行表头：源名一次、可点跳源 + 日期（替代原先每条 quote 都重复源名/日期）。
      const sourceLabel = info?.source_name ?? g.itemId;
      const dateIso = info?.published_at && /^\d{4}-\d{2}-\d{2}T/.test(info.published_at)
        ? info.published_at.slice(0, 10)
        : null;
      const datePart = dateIso ? ` · ${dateIso}` : "";
      L.push(`  - ${info?.url ? `[${sourceLabel}](${info.url})` : sourceLabel}${datePart}`);
      // 该篇下挂各条逐字 quote（[n] 与行内锚同号；markdown.tsx 按 [n] 建锚，与缩进无关）。
      for (const i of g.indices) {
        L.push(`    - [${numOf.get(i)}] 「${ins.citations[i].quote}」`);
      }
    }
  }
  if (x.blockedCount > 0) L.push(`- 校验阻断：${x.blockedCount} 条${blockedReasonStr(x.blockedReasonCounts)}`);
  L.push("");
  return { lines: L, next: citeStart + x.citationIndices.length };
}

const KEY = (x: IncludedInsight): boolean => x.insight.importance >= KEY_MIN_IMPORTANCE;

// ── deep_dive 结构化版式（#19）共用工具：TL;DR / 概览对比 / 趋势 / 时间线 ──
const TYPE_CN: Record<Insight["type"], string> = { aggregation: "聚合", trend: "趋势" };
const CONF_CN: Record<string, string> = { high: "高", medium: "中", low: "低" };
const confLabel = (x: IncludedInsight): string => (x.insight.confidence ? CONF_CN[x.insight.confidence] : "—");
const sourceLabel = (x: IncludedInsight): string => `${x.insight.source_count}·${x.insight.multi_source ? "多源" : "单源"}`;
const TLDR_MAX = 5;

/** 详版与各概览段共用的洞察顺序：重点关注（importance≥4）在前、其他动态在后。
 *  概览/时间线引用的序号 = 此序中的位次，与详版 `### N.` 标题号一致（便于交叉对照）。 */
const orderInsights = (included: IncludedInsight[]): IncludedInsight[] => [
  ...included.filter(KEY),
  ...included.filter((x) => !KEY(x)),
];

/** TL;DR 选取：按重要性降序取前 N（稳定，同分保留原序）。 */
const tldrPick = (included: IncludedInsight[]): IncludedInsight[] =>
  [...included].sort((a, b) => b.insight.importance - a.insight.importance).slice(0, TLDR_MAX);

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Markdown 表格单元转义：管道字符转义、换行折叠为空格（防破坏行结构）。 */
const cellEsc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** 时间线日期：取该洞察被引来源中最新发布日；无可解析日期则回退洞察证据窗口末。 */
function insightDate(x: IncludedInsight, lookup: Map<string, CitationDisplay>): string {
  const dates = x.citationIndices
    .map((i) => lookup.get(x.insight.citations[i].content_item_id)?.published_at)
    .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}T/.test(d))
    .map((d) => d.slice(0, 10));
  if (dates.length) return dates.sort().at(-1)!;
  return x.insight.time_window.end.slice(0, 10);
}

/** 时间线条目：按日期倒序（最新在前，与产品「时间倒序默认」一致）。 */
const timelineRows = (
  ordered: IncludedInsight[],
  lookup: Map<string, CitationDisplay>,
): { date: string; statement: string }[] =>
  ordered
    .map((x) => ({ date: insightDate(x, lookup), statement: x.insight.statement }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

function renderMarkdown(
  title: string,
  topic: Topic,
  included: IncludedInsight[],
  date: string,
  deep: boolean,
  lookup: Map<string, CitationDisplay>,
  timeWindow: { start: string; end: string },
): string {
  const keyN = included.filter(KEY).length;
  // dogfood feedback：hero 元数据条加"内容窗口"，让读者知道这是哪段时间发布的内容
  const windowLabel = `${timeWindow.start.slice(0, 10)} ~ ${timeWindow.end.slice(0, 10)}`;
  const summary = `> 主题：${topic.name}（${(topic.facets ?? []).map(facetLabel).join("·")}）· 内容窗口：${windowLabel} · 共 ${included.length} 条洞察${
    deep ? `（重点 ${keyN} 条）` : ""
  } · 生成于 ${date}`;
  const L: string[] = [`# ${title}`, "", summary, ""];
  if (!included.length) {
    L.push("_本期无重要事件。_");
    return L.join("\n");
  }
  let cite = 1; // C-2：全局连续引用编号，跨多条洞察累计
  if (!deep) {
    included.forEach((x, n) => {
      const r = insightBlockMd(x, `## ${n + 1}.`, false, cite, lookup);
      L.push(...r.lines);
      cite = r.next;
    });
    return L.join("\n");
  }
  // deep_dive：结构化六段（spec report-generation.md:31 + product-definition.md:72；#19）。
  // 上浮可扫读段（TL;DR / 概览 / 趋势 / 时间线）→ 再到详版（关键发现+其他动态，含行内引用清单）。
  const ordered = orderInsights(included);

  // ① TL;DR —— 可读性优先，结论上浮（product-definition「TL;DR 第一优先」）
  L.push("## TL;DR", "");
  for (const x of tldrPick(included)) L.push(`- ${x.insight.statement}`);
  L.push("");

  // ② 概览（对比表）—— 一行一洞察，类型/重要性/来源/置信度可横向扫读；行号 = 详版 ### 号
  L.push("## 概览", "", "| # | 洞察 | 类型 | 重要性 | 来源 | 置信度 |", "| --- | --- | --- | --- | --- | --- |");
  ordered.forEach((x, i) => {
    const ins = x.insight;
    L.push(`| ${i + 1} | ${cellEsc(truncate(ins.statement, 40))} | ${TYPE_CN[ins.type]} | ${ins.importance}/5 | ${sourceLabel(x)} | ${confLabel(x)} |`);
  });
  L.push("");

  // ③ 趋势分析 —— 仅 trend 型洞察（含置信度）；无则诚实标注「无显著趋势信号」
  const trends = ordered.filter((x) => x.insight.type === "trend");
  L.push("## 趋势分析", "");
  if (trends.length) for (const x of trends) L.push(`- ${x.insight.statement}（置信度 ${confLabel(x)}）`);
  else L.push("_本期无显著趋势信号。_");
  L.push("");

  // ④ 时间线 —— 按事件日期倒序
  L.push("## 时间线", "");
  for (const t of timelineRows(ordered, lookup)) L.push(`- \`${t.date}\` — ${t.statement}`);
  L.push("");

  // ⑤+⑥ 关键发现（重点关注）/ 其他动态 —— 详版块（含完整行内引用 = 引用清单）
  const tiers = [
    { label: "重点关注", items: ordered.filter(KEY) },
    { label: "其他动态", items: ordered.filter((x) => !KEY(x)) },
  ];
  let n = 0;
  for (const t of tiers) {
    if (!t.items.length) continue;
    L.push(`## ${t.label}（${t.items.length}）`, "");
    for (const x of t.items) {
      const r = insightBlockMd(x, `### ${(n += 1)}.`, true, cite, lookup);
      L.push(...r.lines);
      cite = r.next;
    }
  }
  return L.join("\n");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** 属性上下文转义：在 esc 基础上再转义双引号（href/src 等属性值用）。 */
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

/** 单条洞察的 HTML（tag = h2 brief / h3 deep_dive 节内）。detailed 多展示来源。
 *  引用项与 Markdown 版（insightBlockMd）对齐：quote 可点跳源 + 人可读源名 + 发布日，
 *  替代原先生硬的 ci_xxx（lookup 缺该 content_item 时回退 content_item_id）。 */
function insightHtml(
  x: IncludedInsight,
  n: number,
  tag: "h2" | "h3",
  detailed: boolean,
  lookup: Map<string, CitationDisplay>,
): string {
  const ins = x.insight;
  // 按被引文档分组：源名/日期每篇一次（可点跳源），其下挂该篇各条逐字 quote——
  // 避免"同篇多句覆盖引用"被渲染成多个来源（dogfood 反馈）。
  const groups = groupCitationsBySource(x);
  const cites = groups
    .map((g) => {
      const info = lookup.get(g.itemId);
      // 自包含 HTML 直接在浏览器打开：仅 http(s) 源 URL 可点（挡 javascript:/data: 等危险 scheme，
      // 呼应 product-definition「引用 URL 安全检查」）；非 http(s) 退化为纯源名。
      const safeUrl = info?.url && /^https?:\/\//i.test(info.url) ? info.url : null;
      const srcName = esc(info?.source_name ?? g.itemId);
      const nameEl = safeUrl
        ? `<a href="${escAttr(safeUrl)}" target="_blank" rel="noopener noreferrer"><span class="src">${srcName}</span></a>`
        : `<span class="src">${srcName}</span>`;
      const dateIso = info?.published_at && /^\d{4}-\d{2}-\d{2}T/.test(info.published_at)
        ? info.published_at.slice(0, 10)
        : null;
      const datePart = dateIso ? ` · ${dateIso}` : "";
      const quotes = g.indices
        .map((i) => `<li class="cite-quote"><q>「${esc(ins.citations[i].quote)}」</q></li>`)
        .join("");
      return `<li class="cite-src">${nameEl}${datePart}</li>${quotes}`;
    })
    .join("");
  const conf = ins.type === "trend" && ins.confidence ? ` · 置信度 ${ins.confidence}` : "";
  const src = detailed ? ` · 来源 ${ins.source_count}（${ins.multi_source ? "多源" : "单源"}）` : "";
  // 诚实信号：N 句引用来自 K 篇文档（区分"同篇多句"与"多篇印证"，brief/deep 都显）
  const citeSummary = x.citationIndices.length
    ? ` · 引用 ${x.citationIndices.length} 句/${groups.length} 篇`
    : "";
  // 透明信任信号：validator 屏蔽计数 + 理由（仅在有屏蔽时展示）
  const blocked = x.blockedCount > 0
    ? `<p class="meta blocked">校验阻断：${x.blockedCount} 条${esc(blockedReasonStr(x.blockedReasonCounts))}</p>`
    : "";
  const followupBadge = ins.is_followup ? ' <span class="followup">更新</span>' : "";
  const label = flagLabel(x);
  const flaggedBadge = label ? ` <span class="flag">${label}</span>` : "";
  const gaps = coverageGapTokens(x);
  const coverageBadge = gaps.length ? ` <span class="coverage-gap">待补引：${esc(gaps.join("、"))}</span>` : "";
  return `<section><${tag}>${n}. ${esc(ins.statement)}${followupBadge}${flaggedBadge}${coverageBadge}</${tag}><p class="meta">重要性 ${ins.importance}/5 · ${esc(ins.importance_basis)}${conf}${src}${citeSummary}</p><ul>${cites}</ul>${blocked}</section>`;
}

function renderHtml(
  title: string,
  topic: Topic,
  included: IncludedInsight[],
  date: string,
  deep: boolean,
  lookup: Map<string, CitationDisplay>,
): string {
  let body: string;
  if (!included.length) {
    body = "<p><em>本期无重要事件。</em></p>";
  } else if (!deep) {
    body = included.map((x, n) => insightHtml(x, n + 1, "h2", false, lookup)).join("\n");
  } else {
    // deep_dive 结构化六段，与 Markdown 版式对齐（#19）
    const ordered = orderInsights(included);
    const tldr = `<section class="tldr"><h2>TL;DR</h2><ul>${tldrPick(included)
      .map((x) => `<li>${esc(x.insight.statement)}</li>`)
      .join("")}</ul></section>`;
    const rows = ordered
      .map((x, i) => {
        const ins = x.insight;
        return `<tr><td>${i + 1}</td><td>${esc(truncate(ins.statement, 40))}</td><td>${TYPE_CN[ins.type]}</td><td>${ins.importance}/5</td><td>${esc(sourceLabel(x))}</td><td>${confLabel(x)}</td></tr>`;
      })
      .join("");
    const overview = `<section class="overview"><h2>概览</h2><table><thead><tr><th>#</th><th>洞察</th><th>类型</th><th>重要性</th><th>来源</th><th>置信度</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    const trendItems = ordered.filter((x) => x.insight.type === "trend");
    const trend = `<section class="trend"><h2>趋势分析</h2>${
      trendItems.length
        ? `<ul>${trendItems.map((x) => `<li>${esc(x.insight.statement)}（置信度 ${confLabel(x)}）</li>`).join("")}</ul>`
        : "<p><em>本期无显著趋势信号。</em></p>"
    }</section>`;
    const timeline = `<section class="timeline"><h2>时间线</h2><ul>${timelineRows(ordered, lookup)
      .map((t) => `<li><code>${t.date}</code> — ${esc(t.statement)}</li>`)
      .join("")}</ul></section>`;
    const tiers = [
      { label: "重点关注", items: ordered.filter(KEY) },
      { label: "其他动态", items: ordered.filter((x) => !KEY(x)) },
    ];
    let n = 0;
    const detail = tiers
      .filter((t) => t.items.length)
      .map(
        (t) =>
          `<h2>${esc(t.label)}（${t.items.length}）</h2>` +
          t.items.map((x) => insightHtml(x, (n += 1), "h3", true, lookup)).join("\n"),
      )
      .join("\n");
    body = tldr + overview + trend + timeline + detail;
  }
  return `<!doctype html><html lang="${topic.language}"><head><meta charset="utf-8"><title>${esc(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.5rem}h3{font-size:1rem;margin-top:1rem}.meta{color:#666;font-size:.9rem}.meta.blocked{color:#6b7280;font-size:.8rem;margin-top:.25rem}.flag{color:#b45309;font-size:.75rem;border:1px solid #b45309;border-radius:4px;padding:0 .3rem}.coverage-gap{color:#6b7280;font-size:.75rem;border:1px dashed #9ca3af;border-radius:4px;padding:0 .3rem}q{color:#1f2937}code{color:#6b7280;font-size:.85rem}.src{color:#6b7280;font-size:.85rem}.cite-src{list-style:none;margin-top:.35rem;font-weight:500}.cite-quote{margin-left:1.1rem}li a q{cursor:pointer}table{border-collapse:collapse;width:100%;font-size:.85rem;margin:.5rem 0}th,td{border:1px solid #e5e7eb;padding:.3rem .5rem;text-align:left}th{background:#f9fafb}.tldr ul{padding-left:1.2rem}.tldr li{margin:.2rem 0}</style></head><body><h1>${esc(
    title,
  )}</h1><p class="meta">${esc(topic.name)}（${esc((topic.facets ?? []).map(facetLabel).join("·"))}）· ${date} · 共 ${included.length} 条洞察</p>${body}</body></html>`;
}
