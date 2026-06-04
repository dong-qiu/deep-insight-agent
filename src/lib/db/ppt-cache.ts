/** PPT polish 缓存：以 (report_id, inputs_hash) 为复用键，避免同一报告 LLM 重写每次 ~\$0.21。
 *
 *  inputs_hash 来源：topic.name + sorted([insight.id, statement, importance_basis])。
 *  任一字段变化（topic 改名 / 洞察改写 / 纳入条变动）→ 哈希变 → 强制重新跑 LLM；
 *  pptxgenjs 渲染层（A 阶段确定性骨架）不进缓存——开销 ~30ms，每次现算更省状态。
 *
 *  契约：getPolishCacheEntry 返 null 视为 miss；hash 不一致也按 miss 处理（不抛、调用方覆写）。 */
import { createHash } from "node:crypto";
import type { Cost, Insight, Topic } from "../types.js";
import type { ExecutivePolish, InsightPolish } from "../services/ppt-polish.js";
import type { DB } from "./index.js";

export interface CachedPolish {
  perInsight: Map<string, InsightPolish>;
  executive: ExecutivePolish | null;
}

export interface PolishCacheHit {
  inputsHash: string;
  polish: CachedPolish;
  /** 上次写入时的累计 Cost（信息性——本次响应 polishCost 仍按 0 计） */
  originalCost: Cost;
  createdAt: string;
}

/** 计算输入指纹：稳定 JSON（key 顺序固定）+ SHA-256（hex）。
 *  只取会影响 polish prompt 的字段——topic 工业领域不入（prompt 未引用）。 */
export function computePolishInputsHash(
  topic: Pick<Topic, "id" | "name">,
  keyInsights: Array<Pick<Insight, "id" | "statement" | "importance_basis">>,
): string {
  // 按 id 字典序排——同一组 insight 不论传入顺序如何，hash 相同
  const sorted = [...keyInsights].sort((a, b) => a.id.localeCompare(b.id));
  const canonical = JSON.stringify({
    topic_id: topic.id,
    topic_name: topic.name,
    insights: sorted.map((x) => ({ id: x.id, statement: x.statement, basis: x.importance_basis })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** 读缓存条目（不比对 hash——调用方拿到后自行决定 hit/miss）。 */
export function getPolishCacheEntry(db: DB, reportId: string): PolishCacheHit | null {
  const r = db
    .prepare("SELECT inputs_hash, polish_json, tokens, amount, created_at FROM ppt_polish_cache WHERE report_id = ?")
    .get(reportId) as
    | { inputs_hash: string; polish_json: string; tokens: number; amount: number; created_at: string }
    | undefined;
  if (!r) return null;
  let parsed: { perInsight: Record<string, InsightPolish>; executive: ExecutivePolish | null };
  try {
    parsed = JSON.parse(r.polish_json);
  } catch (e) {
    // 损坏：返 null 当 miss，调用方会写入新条覆盖
    console.warn(`ppt-polish-cache: report=${reportId} polish_json 解析失败：${(e as Error).message}`);
    return null;
  }
  return {
    inputsHash: r.inputs_hash,
    polish: {
      perInsight: new Map(Object.entries(parsed.perInsight ?? {})),
      executive: parsed.executive,
    },
    originalCost: { tokens: r.tokens, amount: r.amount },
    createdAt: r.created_at,
  };
}

/** 覆盖写入（同 report_id 替换旧条目）。
 *  调用前需判定 polish 完整（perInsight 全填 + executive 非 null）——partial 不入库，
 *  保证下次还会重试到攒齐一份完整 polish。 */
export function upsertPolishCacheEntry(
  db: DB,
  reportId: string,
  inputsHash: string,
  polish: CachedPolish,
  cost: Cost,
): void {
  const polishJson = JSON.stringify({
    perInsight: Object.fromEntries(polish.perInsight),
    executive: polish.executive,
  });
  db.prepare(
    `INSERT INTO ppt_polish_cache (report_id, inputs_hash, polish_json, tokens, amount, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(report_id) DO UPDATE SET
       inputs_hash = excluded.inputs_hash,
       polish_json = excluded.polish_json,
       tokens      = excluded.tokens,
       amount      = excluded.amount,
       created_at  = excluded.created_at`,
  ).run(reportId, inputsHash, polishJson, cost.tokens, cost.amount);
}

/** 删除条目（手动失效；admin 维护用，本期暂不接 UI）。 */
export function deletePolishCacheEntry(db: DB, reportId: string): void {
  db.prepare("DELETE FROM ppt_polish_cache WHERE report_id = ?").run(reportId);
}
