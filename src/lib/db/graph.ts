/** 知识图谱 S1 数据层（ADR-0012 砖②）——按主题/时间窗查 insight、自适应装配共现图 + 溯源查询。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  type CooccurrenceGraph,
  deriveCooccurrenceGraph,
  pickEdgeWeightForBudget,
} from "../graph/cooccurrence.js";
import type { Entity, Insight } from "../types.js";
import type { DB } from "./index.js";

function rowToInsight(db: DB, r: any): Insight {
  const cits = db
    .prepare("SELECT * FROM citation WHERE insight_id = ? ORDER BY citation_index")
    .all(r.id) as any[];
  return {
    id: r.id,
    topic_id: r.topic_id,
    type: r.type,
    event_id: r.event_id ?? null,
    statement: r.statement,
    headline: r.headline ?? "",
    importance: r.importance,
    importance_basis: r.importance_basis,
    citations: cits.map((c) => ({
      content_item_id: c.content_item_id,
      quote: c.quote,
      locator: JSON.parse(c.locator),
    })),
    source_count: r.source_count,
    multi_source: r.multi_source === 1,
    time_window: JSON.parse(r.time_window),
    confidence: r.confidence ?? null,
    language: r.language,
    is_followup: r.is_followup === 1,
    entities: JSON.parse(r.entities ?? "[]"),
    tags: JSON.parse(r.tags ?? "[]"),
  };
}

/** 轻量加载：只取派生共现图所需的 entities，不查 citation（图装配热路径，避免 N+1）。
 *  注：读 `insight` 全表——刻意展示「原始分析判断」（含未过 validator 校验的洞察）。
 *  S1 单用户 dogfood 阶段可接受；多用户/公开前需按 citation_check verdict 过滤（见 ADR-0012 风险）。 */
function loadTopicEntityRows(db: DB, topicId: string, since?: string): { entities: Entity[] }[] {
  const rows = (
    since
      ? db
          .prepare(
            `SELECT i.entities FROM insight i JOIN analysis_batch b ON i.batch_id = b.id
             WHERE i.topic_id = ? AND b.created_at >= ?`,
          )
          .all(topicId, since)
      : db.prepare("SELECT entities FROM insight WHERE topic_id = ?").all(topicId)
  ) as { entities: string | null }[];
  return rows.map((r) => ({ entities: JSON.parse(r.entities ?? "[]") as Entity[] }));
}

/** 加载某主题的洞察（含 citation，溯源用）；since（batch.created_at 下界，ISO）可选限定时间窗。 */
export function loadTopicInsights(db: DB, topicId: string, since?: string): Insight[] {
  const rows = (
    since
      ? db
          .prepare(
            `SELECT i.* FROM insight i JOIN analysis_batch b ON i.batch_id = b.id
             WHERE i.topic_id = ? AND b.created_at >= ? ORDER BY i.rowid`,
          )
          .all(topicId, since)
      : db.prepare("SELECT * FROM insight WHERE topic_id = ? ORDER BY rowid").all(topicId)
  ) as any[];
  return rows.map((r) => rowToInsight(db, r));
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

/** 溯源·点节点：该主题（窗口内）提及某实体的洞察（headline=关于该实体的实质信息）。 */
export function insightsMentioningEntity(
  db: DB,
  topicId: string,
  entityName: string,
  since?: string,
): Insight[] {
  const name = entityName.trim();
  return loadTopicInsights(db, topicId, since).filter((i) =>
    (i.entities ?? []).some((e) => e.name.trim() === name),
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
  const na = a.trim();
  const nb = b.trim();
  return loadTopicInsights(db, topicId, since).filter((i) => {
    const names = new Set((i.entities ?? []).map((e) => e.name.trim()));
    return names.has(na) && names.has(nb);
  });
}

export interface InsightReportLink {
  report_id: string;
  date: string;
}

/** insight_id → 其所在已发布报告（反查 report.insight_ids）。一洞察可能在多份报告（续报），取最新。
 *  blocked/未入报告的洞察不在任何 insight_ids 里 → 无链接（drill 仍显 headline）。 */
export function reportLinkMap(db: DB, topicId: string): Map<string, InsightReportLink> {
  const rows = db
    .prepare(
      `SELECT r.id AS report_id, ri.date AS date, r.insight_ids AS insight_ids
       FROM report r JOIN report_index ri ON r.id = ri.report_id
       WHERE r.topic_id = ? AND r.status = 'done' ORDER BY ri.date ASC`,
    )
    .all(topicId) as { report_id: string; date: string; insight_ids: string }[];
  const map = new Map<string, InsightReportLink>();
  // date 升序遍历 + 覆盖写 → 每洞察落到最新一份包含它的报告
  for (const r of rows) {
    for (const iid of JSON.parse(r.insight_ids) as string[]) {
      map.set(iid, { report_id: r.report_id, date: r.date });
    }
  }
  return map;
}
