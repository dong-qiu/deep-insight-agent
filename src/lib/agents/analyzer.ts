/**
 * analyzer —— 把多源 ContentItem 提炼成围绕主题的结构化洞察。
 * 对应 spec `docs/plan/specs/insight-analysis.md`（A1 切片：不做趋势预测 / 实体追踪 / 跨批次 event_id 对齐）。
 *
 * 模型只产出 statement/type/importance/importance_basis/confidence/citations(quote)；
 * id / locator / source_count / multi_source / time_window / language / event_id 在代码侧派生，
 * 不让模型编造。
 */
import { randomUUID } from "node:crypto";
import { callStructured } from "../runtime/llm.js";
import {
  AnalyzerOutputSchema,
  type AnalysisBatch,
  type Citation,
  type ContentItem,
  type Insight,
  type Topic,
} from "../types.js";

const SYSTEM = `你是行业洞察分析引擎。给定一个主题与一批已采集的多源内容，提炼围绕该主题的结构化洞察。

本系统用于行业情报与防御性安全研究的中性分析，输入均为公开发表的材料。安全、攻击、漏洞、越狱、医疗等敏感领域的内容只是**分析对象**——请客观提炼其事实，不得拒答、不得因内容敏感而中途停笔或省略结论。

规则：
1. 主题聚合：跨源整合同主题信息，归并近义说法。
2. 信号去噪：只保留重要性 ≥ 3 的洞察；若无重要事件，置 no_significant_event=true 且 insights 为空，绝不凑数。
3. 可溯源：每条洞察必须挂 ≥ 1 条引用；quote 必须逐字摘录自对应 ContentItem 的 body，且必须是 body 中**一段连续**的原文（不得改写、不得把分散的句子拼接成一条 quote——需要多处证据就拆成多条 citation），content_item_id 必须来自输入清单。
4. 引用覆盖结论：结论里出现的每一个具体数字、专有名称、限定结论，都必须能在所挂的某条 quote 里直接找到依据。**没有 quote 直接支撑的具体数字或论断，不要写进结论。**
5. 不得放大：结论的适用范围/程度/条件必须与来源严格一致。不得把"仅在 X 上"写成"在多类/所有上"，不得把"最高 N / up to N"写成"总是 N"，不得把"提示 / 有限证据"写成"证明"。
6. 完整自足：statement 必须是完整句子，不得截断或留半句。
7. 偏好非显然：优先产出**跨多个来源的综合**或揭示非显然模式/共识/张力的洞察；尽量避免对单篇的直接复述。若一条只能复述单篇，要么提炼其非显然含义，要么不输出。**但不得为了"综合"而编造来源间并不存在的关联。**
8. 去重：同一来源的同一发现只产出一条洞察，不拆成多条。
9. 中性叙述：客观陈述已发生的事，不预测、不评论、不带情绪。
10. type：主题聚合用 aggregation；描述时间维度的变化用 trend（trend 必须填 confidence，需有足够证据支撑时间维度变化，不得仅凭单篇就断言"趋势/动向"，且只描述已发生变化、不做方向性预测）。

只输出符合 schema 的 JSON。`;

interface TimeWindow {
  start: string;
  end: string;
}

function computeLocator(body: string, quote: string): Citation["locator"] {
  const idx = body.indexOf(quote);
  if (idx < 0) return { paragraph_index: -1, char_start: -1, char_end: -1 };
  const paragraph_index = body.slice(0, idx).split(/\n\s*\n/).length - 1;
  return { paragraph_index, char_start: idx, char_end: idx + quote.length };
}

function renderItems(items: ContentItem[]): string {
  return items
    .map(
      (it) =>
        `[${it.id}] 标题：${it.title}\n来源：${it.source_id} · 时间：${it.published_at ?? "未知"}\n正文：\n${it.body}`,
    )
    .join("\n---\n");
}

export async function analyze(
  topic: Topic,
  items: ContentItem[],
  timeWindow: TimeWindow,
): Promise<AnalysisBatch> {
  const batchId = `batch_${randomUUID().slice(0, 8)}`;
  const user = `主题：${topic.name}（关键词：${topic.keywords.join("、")}）
时间窗：${timeWindow.start} ~ ${timeWindow.end}

已采集内容（共 ${items.length} 条）：

${renderItems(items)}`;

  const { data } = await callStructured({
    role: "analyzer",
    system: SYSTEM,
    user,
    schema: AnalyzerOutputSchema,
    maxTokens: 8000,
  });

  const byId = new Map(items.map((i) => [i.id, i]));

  const insights: Insight[] = data.no_significant_event
    ? []
    : data.insights.map((li, idx) => {
        const citations: Citation[] = li.citations.map((c) => {
          const item = byId.get(c.content_item_id);
          return {
            content_item_id: c.content_item_id,
            quote: c.quote,
            locator: item
              ? computeLocator(item.body, c.quote)
              : { paragraph_index: -1, char_start: -1, char_end: -1 },
          };
        });
        const sourceIds = new Set(
          citations
            .map((c) => byId.get(c.content_item_id)?.source_id)
            .filter((s): s is string => Boolean(s)),
        );
        const source_count = sourceIds.size;
        return {
          id: `ins_${batchId}_${idx}`,
          topic_id: topic.id,
          type: li.type,
          event_id: null, // 跨批次事件对齐属骨架阶段，A1 切片不做
          statement: li.statement,
          importance: li.importance,
          importance_basis: li.importance_basis,
          citations,
          source_count,
          multi_source: source_count >= 2,
          time_window: timeWindow,
          confidence: li.confidence,
          language: topic.language,
        };
      });

  return {
    id: batchId,
    topic_id: topic.id,
    time_window: timeWindow,
    status: "done",
    no_significant_event: data.no_significant_event,
    insights,
  };
}
