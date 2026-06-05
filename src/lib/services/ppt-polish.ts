/** PPT LLM 润色（B 阶段）：基于已 validated insight 数据生成
 *   §1 brief_summary（≤30 字凝练）+ §3 implications（2-3 条可操作启示）+ Executive Summary（整批 takeaways）。
 *
 *  **安全契约**：
 *  - 不引入新事实：LLM 只能基于输入的 statement / importance_basis / topic 上下文，**不得**编造
 *    数字、具名实体、源；
 *  - 不绕过可溯源闸门：调用 polishForPpt 时传入的 insights 已经过 selectInsights 白名单，
 *    quote 仍由 ppt-gen 直接显示原始 verbatim 文本；
 *  - 失败优雅降级：任一 LLM 调用失败 → 该项 polish 返 null，ppt-gen 用 A 阶段确定性 fallback。
 *
 *  **成本**：复用 ANALYZER_MODEL（默认 Opus tier）。典型 5-10 条重点 + 1 Executive ≈ \$0.05–0.15，
 *  低于单 PPT \$0.20 上限。并发跑（Promise.all），中转站不稳时自动走重试链路。 */
import { z } from "zod/v4";
import { callStructured } from "../runtime/llm.js";
import type { Cost, Insight, Topic } from "../types.js";
import type { IncludedInsightLite } from "./ppt-gen.js";

const InsightPolishSchema = z.object({
  brief_summary: z.string().min(4).max(120),
  implications: z.array(z.string().min(8).max(160)).min(1).max(4),
});
const ExecutivePolishSchema = z.object({
  takeaways: z.array(z.string().min(10).max(180)).min(2).max(6),
});

export type InsightPolish = z.infer<typeof InsightPolishSchema>;
export type ExecutivePolish = z.infer<typeof ExecutivePolishSchema>;

export interface PolishResult {
  /** insight.id → polish；缺失键表示该条 polish 失败 / 未调，ppt-gen 走 A fallback */
  perInsight: Map<string, InsightPolish>;
  executive: ExecutivePolish | null;
  /** 本次累计 Cost（多次 callStructured 求和） */
  cost: Cost;
}

/** 针对单条洞察凝练 §1 + 生成 §3 启示。失败返 null（caller 走 fallback）。
 *  signal 透传 callStructured；abort 后抛 AbortError、由本函数 catch 走 null 路径。 */
async function polishInsight(
  ins: Insight,
  topic: Topic,
  onCost?: (c: Cost) => void,
  signal?: AbortSignal,
): Promise<InsightPolish | null> {
  try {
    const { data } = await callStructured({
      role: "analyzer",
      system: SYSTEM_INSIGHT,
      user: `主题：${topic.name}（受众：内部工程团队，关注 ${topic.industry}）

洞察 statement：
${ins.statement}

analyzer 标注的重要性依据（参考、不必直接引用）：
${ins.importance_basis}

请输出 JSON，含 brief_summary（≤30 字一句话凝练）+ implications（2-3 条对"我们"具体可操作的启示）。`,
      schema: InsightPolishSchema,
      maxTokens: 1500,
      onCost,
      signal,
    });
    return data;
  } catch (e) {
    // 我方主动 abort：任何错误都按"取消"语义处理（SDK 实际抛 APIUserAbortError 而非 AbortError）
    if (signal?.aborted) return null;
    const err = e as Error;
    console.warn(`  ⚠️ ppt-polish 失败（insight=${ins.id}）：${err.message.slice(0, 80)} → A fallback`);
    return null;
  }
}

/** 整批生成 Executive Summary。输入是所有重点 statement。失败返 null。 */
async function polishExecutive(
  keyInsights: IncludedInsightLite[],
  topic: Topic,
  onCost?: (c: Cost) => void,
  signal?: AbortSignal,
): Promise<ExecutivePolish | null> {
  if (keyInsights.length === 0) return null;
  try {
    const numbered = keyInsights
      .map((x, i) => `${i + 1}. ${x.insight.statement}`)
      .join("\n");
    const { data } = await callStructured({
      role: "analyzer",
      system: SYSTEM_EXECUTIVE,
      user: `主题：${topic.name}（受众：内部工程团队，关注 ${topic.industry}）

本期 ${keyInsights.length} 条重点洞察：
${numbered}

请输出 JSON，含 takeaways（3-5 条整体性 takeaway bullet；每条具体到信号本身、避免空话；不引入新事实）。`,
      schema: ExecutivePolishSchema,
      maxTokens: 2000,
      onCost,
      signal,
    });
    return data;
  } catch (e) {
    if (signal?.aborted) return null;
    const err = e as Error;
    console.warn(`  ⚠️ ppt-polish 执行摘要失败：${err.message.slice(0, 80)} → 跳过 Executive 页`);
    return null;
  }
}

/** 并发上限：中转站对高并发 tool_use 流式不稳——实测 14 路并发约 36% 单条解析失败
 *  （input_json_delta 累积截断 → JSON.parse 报 "Expected ',' or ']'"）。
 *  限制 ≤4 路并发后实测稳定（fallback 仍是兜底，但失败率应趋近 0）。
 *  通过 PPT_POLISH_CONCURRENCY 环境变量可调；缺省 4。 */
const POLISH_CONCURRENCY_DEFAULT = 4;

/** 简易并发 map：批量切片，每批内并发跑 worker，串行推进。保留输入顺序的结果数组。
 *  signal 在每次拉新任务前 check：abort 后 pending 项不再启动，已 in-flight 由 worker 自身处理。
 *  跳过的位置返 undefined，调用方需对 sparse 数组容错。 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) break;
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export interface PolishOptions {
  /** 透传到所有底层 callStructured；上层（orchestrator）按累计成本 abort */
  signal?: AbortSignal;
  /** 每次成功 LLM 调用回调（含重试累计 cost）——上层监听以决定何时 abort */
  onCost?: (c: Cost) => void;
}

/** PPT LLM 润色入口：仅对重点条（importance≥4）做单条 polish + 整批 Executive。
 *  非重点条不做 polish（ppt-gen 走 A 简表渲染）。
 *  signal/onCost 由 orchestrator 注入以实现"累计成本上限到达 → 取消未启动 + in-flight"硬停。 */
export async function polishForPpt(
  keyInsights: IncludedInsightLite[],
  topic: Topic,
  opts: PolishOptions = {},
): Promise<PolishResult> {
  let cost: Cost = { tokens: 0, amount: 0 };
  const accumulate = (c: Cost): void => {
    cost = { tokens: cost.tokens + c.tokens, amount: cost.amount + c.amount };
    opts.onCost?.(c);
  };

  const concurrency =
    Number(process.env.PPT_POLISH_CONCURRENCY) > 0
      ? Number(process.env.PPT_POLISH_CONCURRENCY)
      : POLISH_CONCURRENCY_DEFAULT;

  // 单条 polish 池化并发 + executive 单独并行（与池子同时跑、不占池子配额——独立独占一席）
  const [perResults, executive] = await Promise.all([
    mapWithLimit(
      keyInsights,
      concurrency,
      (x) =>
        polishInsight(x.insight, topic, accumulate, opts.signal).then(
          (p) => [x.insight.id, p] as const,
        ),
      opts.signal,
    ),
    polishExecutive(keyInsights, topic, accumulate, opts.signal),
  ]);

  const perInsight = new Map<string, InsightPolish>();
  for (const tup of perResults) {
    if (!tup) continue; // abort 后未启动的 slot 是 undefined
    const [id, p] = tup;
    if (p) perInsight.set(id, p);
  }
  return { perInsight, executive, cost };
}

// ── System prompts ──

const NEUTRAL_CONTEXT = `本工具为内部行业情报分析与防御性研究的中性写作支持，**输入来自已通过校验器的洞察 statement**——
不是原始外部内容；不存在拒答必要。安全/AI 主题只是分析对象，输出始终中性、信息性、可操作。`;

const SYSTEM_INSIGHT = `你是 PPT 写作助手，把已校验的洞察 statement 改写成幻灯片的两个段落。

${NEUTRAL_CONTEXT}

输出严格 JSON，含两字段：

1. **brief_summary**：把 statement 凝练为 ≤30 字的一句话，保留核心论断 + 关键限定词（数字、机构名照搬）；不加修饰、不变换语气。

2. **implications**：2-3 条对"我们"（内部工程团队，开发洞察聚合产品、关注 AI 软件工程/安全趋势）具体可操作的启示。每条要：
   - 直接由 statement 推导，**不引入新事实**（不编造数字、不补具名实体、不假设没出现的趋势）；
   - 具体到"我们应该 / 可以 / 需警惕 …"等可识别动作或观察视角；
   - 每条 ≤80 字。

绝不输出："这表明 AI 很重要"、"值得我们关注" 这类空话。`;

const SYSTEM_EXECUTIVE = `你是 PPT Executive Summary 写作助手，基于一批已校验的洞察 statement，撰写整页总览。

${NEUTRAL_CONTEXT}

输出严格 JSON，含一字段 **takeaways**：3-5 条整体性 takeaway bullet。要求：
- 每条聚焦一个跨多条 statement 出现的**模式 / 信号 / 张力**，不是单条复述；
- 不引入新事实（不编造数字、不补具名实体）；
- 每条 ≤80 字、信息密集；
- 避免空话（"AI 进展迅速""值得关注"等不要出现）；
- 整体读完 30 秒内能传达本期核心。`;
