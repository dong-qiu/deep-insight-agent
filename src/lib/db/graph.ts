/** 知识图谱 S1 数据层（ADR-0012 砖②）——按主题/时间窗查 insight、自适应装配共现图 + 溯源查询。 */
import {
  type CooccurrenceGraph,
  deriveCandidateGraph,
  deriveCooccurrenceGraph,
  type GraphEdge,
  type GraphNode,
  pickEdgeWeightForBudget,
} from "../graph/cooccurrence.js";
import { canonKey } from "../graph/entity-normalize.js";
import { insightFingerprint } from "../runtime/statement-fingerprint.js";
import type { Entity, Insight } from "../types.js";
import { auditSupportsStatementBinding, hasSafeReaderMetadata } from "../utils/display-coverage-audit.js";
import { entitiesMentionedInStatement } from "../utils/reader-visible-entities.js";
import { type InsightRow, rowToInsight } from "./analysis.js";
import type { DB } from "./index.js";

/** Reader-visible graph membership is intentionally stricter than raw insight storage.  A graph
 * node/edge and its drill card are reader-facing claims, so they need the same core evidence as
 * a publishable statement: an audited kept candidate, a durable one-citation binding, and a
 * pass/support validation result for that bound citation.  Legacy rows stay in the database for
 * history but cannot silently re-enter a card or graph after this cutover. */
const READER_VISIBLE_INSIGHT_JOINS = `
  JOIN analysis_batch b ON i.batch_id = b.id
  JOIN display_coverage_audit d ON d.batch_id = i.batch_id AND d.insight_id = i.id
    AND d.terminal_reason IN ('kept', 'kept_degraded')
  JOIN citation statement_citation ON statement_citation.insight_id = i.id
    AND statement_citation.citation_index = i.statement_citation_index - 1`;

const READER_VISIBLE_INSIGHT_WHERE = `
  b.status = 'done'
  AND b.display_coverage_state = 'audited'
  AND b.display_projection_version = 'source_quote_v1'
  AND i.statement_citation_index IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM citation_check cc
    WHERE cc.batch_id = i.batch_id AND cc.insight_id = i.id
      AND cc.citation_index = i.statement_citation_index - 1
      AND cc.reachability = 'pass' AND cc.consistency = 'support' AND cc.verdict = 'pass'
  )`;

type ReaderVisibleRow = {
  statement: string;
  statement_quote: string;
  headline: string | null;
  importance_basis: string;
  entities: string | null;
  statement_citation_index: number | null;
  statement_citation_ref: string | null;
  display_coverage_decision: string;
};

function parseReaderVisibleDecision(decision: string): unknown | null {
  try { return JSON.parse(decision); } catch { return null; }
}

function auditMatchesPersistedBinding(row: Pick<ReaderVisibleRow, "statement" | "statement_quote" | "headline" | "importance_basis" | "statement_citation_index" | "statement_citation_ref" | "display_coverage_decision">): boolean {
  return auditSupportsStatementBinding(parseReaderVisibleDecision(row.display_coverage_decision), {
    citation_index: row.statement_citation_index,
    citation_ref: row.statement_citation_ref,
    statement: row.statement,
    quote: row.statement_quote,
  }) && hasSafeReaderMetadata({ headline: row.headline ?? undefined, importance_basis: row.importance_basis, importance_facts: [] });
}

/** 轻量加载：只取 reader-visible 图所需的 entities，不查 citation（图装配热路径，避免 N+1）。 */
function loadTopicEntityRows(db: DB, topicId: string, since?: string): { entities: Entity[] }[] {
  const sql = `SELECT i.statement, i.headline, i.importance_basis, i.entities, i.statement_citation_index, statement_citation.quote AS statement_quote,
      statement_citation.citation_ref AS statement_citation_ref, d.decision AS display_coverage_decision
    FROM insight i ${READER_VISIBLE_INSIGHT_JOINS}
    WHERE i.topic_id = ?${since ? " AND b.created_at >= ?" : ""} AND ${READER_VISIBLE_INSIGHT_WHERE}`;
  const rows = db.prepare(sql).all(...(since ? [topicId, since] : [topicId])) as ReaderVisibleRow[];
  return rows.filter(auditMatchesPersistedBinding)
    .map((r) => ({ entities: entitiesMentionedInStatement(r.statement, JSON.parse(r.entities ?? "[]") as Entity[]) }));
}

/** 加载某主题的洞察（含 citation，溯源用）；since（batch.created_at 下界，ISO）可选限定时间窗。 */
export function loadTopicInsights(db: DB, topicId: string, since?: string): Insight[] {
  const sql = `SELECT i.*, statement_citation.citation_ref AS statement_citation_ref, statement_citation.quote AS statement_quote,
      d.decision AS display_coverage_decision
    FROM insight i ${READER_VISIBLE_INSIGHT_JOINS}
    WHERE i.topic_id = ?${since ? " AND b.created_at >= ?" : ""} AND ${READER_VISIBLE_INSIGHT_WHERE}
    ORDER BY i.rowid`;
  const rows = db.prepare(sql).all(...(since ? [topicId, since] : [topicId])) as Array<InsightRow & Pick<ReaderVisibleRow, "statement_citation_ref" | "statement_quote" | "display_coverage_decision">>;
  const insights: Insight[] = [];
  for (const r of rows) {
    if (!auditMatchesPersistedBinding({
      statement_citation_index: r.statement_citation_index,
      statement_citation_ref: r.statement_citation_ref,
      statement: r.statement,
      statement_quote: r.statement_quote,
      headline: r.headline,
      importance_basis: r.importance_basis,
      display_coverage_decision: r.display_coverage_decision,
    })) continue;
    const insight = rowToInsight(db, r);
    insights.push({ ...insight, entities: entitiesMentionedInStatement(insight.statement, insight.entities) });
  }
  return insights;
}

export interface TopicGraphOptions {
  since?: string;
  /** 显式指定边阈值/支持度下限；不给则：frequency 按边密度自适应、association 固定 2 */
  minEdgeWeight?: number;
  topN?: number;
  targetMaxEdges?: number;
  /** 选边口径：frequency=共现次数（默认）；association=Jaccard 关联强度取 top */
  metric?: "frequency" | "association";
  /** association 模式保留的最大边数（默认 40） */
  maxEdges?: number;
}

export interface TopicGraphResult {
  graph: CooccurrenceGraph;
  /** 该主题（窗口内）总洞察数 */
  insightCount: number;
  /** 其中带实体、真正参与图的洞察数 */
  withEntities: number;
  /** 实际生效的边阈值/支持度下限（自适应或显式） */
  minEdgeWeight: number;
  /** 实际生效的选边口径 */
  metric: "frequency" | "association";
}

/** 装配某主题的共现图：加载洞察 → 按口径定阈值 → 派生图。
 *  frequency：自适应抬计数阈值控密度；association：固定支持度下限 2、靠 maxEdges 按 strength 控规模。 */
export function buildTopicGraph(db: DB, topicId: string, opts: TopicGraphOptions = {}): TopicGraphResult {
  const all = loadTopicEntityRows(db, topicId, opts.since);
  const withEntities = all.filter((i) => i.entities.length > 0);
  const topN = opts.topN ?? 40;
  const metric = opts.metric ?? "frequency";
  const minEdgeWeight =
    opts.minEdgeWeight ??
    (metric === "association"
      ? 2 // 关联模式固定支持度下限（挡 Jaccard=1 噪声），规模由 maxEdges 控
      : pickEdgeWeightForBudget(withEntities, { topN, targetMaxEdges: opts.targetMaxEdges }));
  return {
    graph: deriveCooccurrenceGraph(withEntities, { minEdgeWeight, topN, metric, maxEdges: opts.maxEdges }),
    insightCount: all.length,
    withEntities: withEntities.length,
    minEdgeWeight,
    metric,
  };
}

export interface TopicGraphData {
  /** 候选节点（top-N，未剔孤点）——客户端布局只算一次的节点集 */
  nodes: GraphNode[];
  /** 候选边（weight≥1，带 strength）——客户端按口径/阈值即时重筛 */
  candidateEdges: GraphEdge[];
  insightCount: number;
  withEntities: number;
  /** association 模式 top-K 边数 */
  maxEdges: number;
  /** frequency 模式自适应初始阈值（客户端滑块初值） */
  suggestedMinWeight: number;
  /** 候选边最大 weight（滑块上界） */
  maxWeight: number;
}

/** 装配「候选图」供客户端实时滑块：扫洞察一次出 top-N 节点 + 全部候选边 + 初值/上界。
 *  口径/阈值的最终选边在客户端做（selectGraph），布局只算一次、拖动不重排。 */
export function buildTopicGraphData(
  db: DB,
  topicId: string,
  opts: { since?: string; topN?: number; targetMaxEdges?: number; maxEdges?: number } = {},
): TopicGraphData {
  const all = loadTopicEntityRows(db, topicId, opts.since);
  const withEntities = all.filter((i) => i.entities.length > 0);
  const topN = opts.topN ?? 40;
  const { nodes, candidateEdges } = deriveCandidateGraph(withEntities, { topN });
  return {
    nodes,
    candidateEdges,
    insightCount: all.length,
    withEntities: withEntities.length,
    maxEdges: opts.maxEdges ?? 40,
    suggestedMinWeight: pickEdgeWeightForBudget(withEntities, { topN, targetMaxEdges: opts.targetMaxEdges }),
    maxWeight: candidateEdges.reduce((m, e) => Math.max(m, e.weight), 1),
  };
}

/** 溯源·点节点：该主题（窗口内）提及某实体的洞察（headline=关于该实体的实质信息）。 */
export function insightsMentioningEntity(
  db: DB,
  topicId: string,
  entityName: string,
  since?: string,
): Insight[] {
  // 按 canonKey 匹配——点击的是规范展示名（如 GPT-5.5），变体（GPT 5.5）的洞察也要纳入（S1.6）
  const target = canonKey(entityName);
  if (!target) return []; // 纯标点/空名 key 为空，无法稳定匹配——不归并（与图侧 canon 跳过一致）
  return loadTopicInsights(db, topicId, since).filter((i) =>
    (i.entities ?? []).some((e) => canonKey(e.name) === target),
  );
}

/** 溯源·点边：两实体在同一条洞察里共现的那些洞察（带 citations 锚回原文）。 */
export function insightsCooccurring(
  db: DB,
  topicId: string,
  a: string,
  b: string,
  since?: string,
): Insight[] {
  const ka = canonKey(a);
  const kb = canonKey(b);
  if (!ka || !kb) return []; // 空 key 不稳定匹配
  return loadTopicInsights(db, topicId, since).filter((i) => {
    const keys = new Set((i.entities ?? []).map((e) => canonKey(e.name)));
    return keys.has(ka) && keys.has(kb);
  });
}

export interface InsightReportLink {
  report_id: string;
  date: string;
}

export interface DrillOccurrence {
  id: string;
  headline: string;
  statement: string;
  importance: number;
  quotes: string[];
  report_links: InsightReportLink[];
}

export interface DrillGroup {
  id: string;
  headline: string;
  statement: string;
  importance: number;
  occurrence_count: number;
  occurrences: DrillOccurrence[];
}

/** insight_id → 其所在已发布报告（反查 report.insight_ids）。一洞察可能在多份报告（续报），取最新。
 *  blocked/未入报告的洞察不在任何 insight_ids 里 → 无链接（drill 仍显 headline）。 */
export function reportLinkMap(db: DB, topicId: string): Map<string, InsightReportLink> {
  const all = reportLinksByInsight(db, topicId);
  return new Map([...all].flatMap(([id, links]) => links.length ? [[id, links.at(-1)!] as const] : []));
}

/** Every published report link for an insight, newest last. Drill groups must
 * retain this full provenance rather than collapsing to reportLinkMap's latest. */
export function reportLinksByInsight(db: DB, topicId: string): Map<string, InsightReportLink[]> {
  const rows = db
    .prepare(
      `SELECT r.id AS report_id, ri.date AS date, r.insight_ids AS insight_ids
       FROM report r JOIN report_index ri ON r.id = ri.report_id
       WHERE r.topic_id = ? AND r.status = 'done' ORDER BY ri.date ASC`,
    )
    .all(topicId) as { report_id: string; date: string; insight_ids: string }[];
  const map = new Map<string, InsightReportLink[]>();
  for (const r of rows) {
    for (const iid of JSON.parse(r.insight_ids) as string[]) {
      const links = map.get(iid) ?? [];
      links.push({ report_id: r.report_id, date: r.date });
      map.set(iid, links);
    }
  }
  return map;
}

/** Read-time display folding only. It neither changes raw graph membership nor
 * claims that same wording is the same real-world event. */
export function groupDrillInsights(insights: Insight[], links: Map<string, InsightReportLink[]>): DrillGroup[] {
  const groups = new Map<string, DrillOccurrence[]>();
  for (const insight of insights) {
    const key = insightFingerprint(insight.type, insight.statement);
    const occurrence: DrillOccurrence = {
      id: insight.id, headline: insight.headline || insight.statement, statement: insight.statement,
      importance: insight.importance,
      // The accessor above admits only durable bindings.  Never reintroduce an unrelated first
      // citation into the side panel merely because it happens to be stored on the same insight.
      quotes: [insight.citations[(insight.statement_citation_index ?? 0) - 1]?.quote].filter((quote): quote is string => Boolean(quote)),
      report_links: links.get(insight.id) ?? [],
    };
    const list = groups.get(key) ?? [];
    list.push(occurrence);
    groups.set(key, list);
  }
  const latestDate = (x: DrillOccurrence) => x.report_links.at(-1)?.date ?? "";
  return [...groups.entries()].map(([id, occurrences]) => {
    occurrences.sort((a, b) => latestDate(b).localeCompare(latestDate(a)) || b.importance - a.importance || a.id.localeCompare(b.id));
    // The top-level card and the initially shown quote/link must come from the same occurrence.
    const representative = occurrences[0]!;
    return { id, headline: representative.headline, statement: representative.statement, importance: representative.importance,
      occurrence_count: occurrences.length, occurrences };
  }).sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
}
