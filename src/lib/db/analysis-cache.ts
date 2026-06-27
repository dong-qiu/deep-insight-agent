/** 增量分析缓存（ADR-0009 切片1，**行为中性·只写不读**）。
 *
 *  目的：量化「同内容跨日重析」的冗余/命中率——为切片2（据缓存跳过重析）提供真数据校准省幅。
 *  做法：每轮 analyze 之后，对本轮分析的每个 item 按 (analyzer版本, topic, content_hash) upsert；
 *   - 新键 = miss（插入、hit_count=0）；
 *   - 旧键 = **would-be 命中**（hit_count++，insights_json 首写定不覆写）——若已开复用即省一次 LLM。
 *  命中率 = Σhit_count / (count + Σhit_count)。
 *
 *  契约：
 *   - **不改 analyze 输出**：在 analyze 之后旁路调用，LLM 照常跑、洞察照常落库；本模块只追加一次写入 + 计数。
 *   - 异常全吞、绝不连累管线（纯度量旁路）。
 *   - 版本隔离 + TTL 同 consistency_cache：改模型/prompt → 版本变 → 旧键不再撞 → 自然失效。
 *   - 单源洞察才入缓存（其全部 citation 指向同一 item；96% 洞察为单源，ADR-0009）；跨条洞察（4%）切片2 另处理。 */
import { createHash } from "node:crypto";
import type { HistoricalEvent } from "../agents/analyzer.js";
import type { ContentItem, Insight } from "../types.js";
import type { DB } from "./index.js";

const DEFAULT_TTL_DAYS = 14;

/** (version, topic_id, content_hash) → 稳定 key。NUL 分隔避免拼接歧义。 */
export function computeAnalysisKey(version: string, topicId: string, contentHash: string): string {
  return createHash("sha256").update(`${version}\x00${topicId}\x00${contentHash}`).digest("hex");
}

/** 开关：默认开；ANALYSIS_CACHE=0 关闭（排查/止血）。切片1 即便开也只写不读、不改行为。 */
export function analysisCacheEnabled(): boolean {
  return process.env.ANALYSIS_CACHE !== "0";
}

/** 某 item 的「单源洞察」= 其全部 citation 都指向该 item 的洞察。返 Map<item_id, Insight[]>。 */
function singleSourceInsightsByItem(insights: Insight[]): Map<string, Insight[]> {
  const m = new Map<string, Insight[]>();
  for (const ins of insights) {
    const ids = new Set(ins.citations.map((c) => c.content_item_id));
    if (ids.size !== 1) continue; // 跨条洞察（多 item）不归属单 item
    const id = [...ids][0];
    const list = m.get(id);
    if (list) list.push(ins);
    else m.set(id, [ins]);
  }
  return m;
}

/** 切片1 写入 + 度量。对本轮分析的**每个** item（含没产出洞察的——空数组，捕获完整重析冗余）按键 upsert。
 *  返回本轮 {writes, wouldHit} 供日志/排查；命中率累计见 analysisCacheStats。 */
export function recordAnalysisCache(
  db: DB,
  topicId: string,
  items: ContentItem[],
  insights: Insight[],
  version: string,
  ttlDays = DEFAULT_TTL_DAYS,
): { writes: number; wouldHit: number } {
  try {
    const ttl = `-${ttlDays} days`;
    db.prepare("DELETE FROM analysis_cache WHERE created_at < datetime('now', ?)").run(ttl);
    const byItem = singleSourceInsightsByItem(insights);
    const getStmt = db.prepare<[string], { key: string }>("SELECT key FROM analysis_cache WHERE key = ?");
    const upsert = db.prepare(
      `INSERT INTO analysis_cache (key, topic_id, content_hash, insights_json, hit_count, created_at, last_seen)
       VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))
       ON CONFLICT(key) DO UPDATE SET hit_count = hit_count + 1, last_seen = datetime('now')`,
    );
    let writes = 0;
    let wouldHit = 0;
    const run = db.transaction(() => {
      // 同轮内按 key 去重（review M1）：同一 content_hash 的多个 item（同文多源 / 同 url 未去重）只算一次——
      // 否则第一个写入后、第二个 getStmt 在同事务内即命中，会把「单轮内容重复」错记成「跨日重析」、虚高命中率。
      // wouldHit 只反映**跨轮**（跨日）冗余，即本切片要量的真值。
      const seen = new Set<string>();
      for (const item of items) {
        const key = computeAnalysisKey(version, topicId, item.content_hash);
        if (seen.has(key)) continue;
        seen.add(key);
        if (getStmt.get(key)) wouldHit++; // 已存在（来自**先前轮次**）= 若开复用即命中（首写定不覆写 insights）
        upsert.run(key, topicId, item.content_hash, JSON.stringify(byItem.get(item.id) ?? []));
        writes++;
      }
    });
    run();
    return { writes, wouldHit };
  } catch (e) {
    // 纯度量旁路：绝不连累管线（契约）。但切片1 全部价值在这张表，持续静默失败会让命中率假性为 0
    // 而无人知 → 留一行 warn（不抛）便于排查。
    console.warn(`[analysis-cache] recordAnalysisCache 失败（已忽略，不影响管线）：${e instanceof Error ? e.message : e}`);
    return { writes: 0, wouldHit: 0 };
  }
}

/** 开关：切片2「据缓存跳过重析」的读路径。默认**关**（ANALYSIS_CACHE_READ=1 开）——
 *  与切片1（写路径 ANALYSIS_CACHE，默认开）解耦：读路径行为改变、过 eval 时序对照验证前不默认开。 */
export function analysisCacheReadEnabled(): boolean {
  return process.env.ANALYSIS_CACHE_READ === "1";
}

/** 周期性全析日（切片2c 兜底安全网）：增量只析新 item、丢「新×旧」跨条综合；故每周一次**全窗 full re-analyze**
 *  把损失上界钉在 ≤1 周（2b eval caveat 要求）。默认每周一（UTC dow=1）；`FULL_REANALYZE_DOW` 0–6 可调，
 *  设为 -1（或非 0–6）则**关闭兜底**（增量天天跑、不再周期全析——仅在确证无综合损失后才用）。
 *  仅当读路径已开（ANALYSIS_CACHE_READ=1）时才有意义：runAnalysis 在全析日临时绕过读路径、全量析。 */
export function isFullReanalyzeToday(now: Date = new Date()): boolean {
  const raw = process.env.FULL_REANALYZE_DOW;
  const target = raw === undefined || raw === "" ? 1 : Number(raw);
  if (!Number.isInteger(target) || target < 0 || target > 6) return false; // 关闭兜底
  return now.getUTCDay() === target;
}

/** 读缓存分流（切片2）：按 (version, topic, content_hash) 查每个 item 是否已缓存分析结果。
 *  - **命中**（键存在且 insights_json 可解析，含空数组=当初分析无产出）= 复用其单源洞察、跳过 LLM；
 *  - **未命中 / 坏 JSON** = 仍需 analyze（坏 JSON 当未命中，宁可重析也不喂错洞察）。
 *  同轮内按 key 去重（同 content_hash 的多 item 只处理首个，余跳过）——同 recordAnalysisCache 口径，避免重复实例化。 */
export function lookupCachedInsights(
  db: DB,
  topicId: string,
  items: ContentItem[],
  version: string,
): { hits: Insight[]; missItems: ContentItem[]; hitItemCount: number } {
  const get = db.prepare<[string], { insights_json: string }>(
    "SELECT insights_json FROM analysis_cache WHERE key = ?",
  );
  const hits: Insight[] = [];
  const missItems: ContentItem[] = [];
  const seen = new Set<string>();
  // 当前窗口的 item id 集——M1 防御（见下）。
  const windowIds = new Set(items.map((i) => i.id));
  let hitItemCount = 0;
  for (const item of items) {
    const key = computeAnalysisKey(version, topicId, item.content_hash);
    if (seen.has(key)) continue; // 同轮同内容去重
    seen.add(key);
    const row = get.get(key);
    if (!row) {
      missItems.push(item);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.insights_json);
    } catch {
      missItems.push(item); // 坏 JSON → 当未命中、重析（安全）
      continue;
    }
    if (!Array.isArray(parsed)) {
      missItems.push(item);
      continue;
    }
    const cachedInsights = parsed as Insight[];
    // M1 防御：缓存键按 content_hash，但复用洞察的 citation 指向**原始** item id。
    // 同内容换了 id（同步/镜像 feed、re-fetch 给新 id、原 item 滑出 recency 窗）时，该 id 可能不在当前窗口
    // → citation 不可达被 validator 静默丢弃 = 悄悄丢内容。故仅当全部被引 id 都在窗内才复用，否则退回重析（安全）。
    // 零产出命中（无 citation）天然通过（every over 空 = true），仍算命中、不重析。
    const allCitedInWindow = cachedInsights.every((ins) => ins.citations.every((c) => windowIds.has(c.content_item_id)));
    if (!allCitedInWindow) {
      missItems.push(item);
      continue;
    }
    hitItemCount++;
    hits.push(...cachedInsights);
  }
  return { hits, missItems, hitItemCount };
}

/** 把缓存命中的洞察「实例化」进新 batch（切片2）：
 *  - 重生成 insight id（`ins_${batchId}_${i}`，从 startIdx 续号，避免与本批 analyze 产出的 id 撞）；
 *  - **event_id 保持缓存值**（事件身份跨日稳定，供「不复报」识别同事件）；
 *  - **is_followup 按当前 history 重判**（缓存里的 is_followup 是首析当时的，复用时该事件可能已被报告 → 须重算）；
 *  - statement/citations/importance/quote/locator 等原样复用（content_hash 未变 ⇒ quote 仍逐字可达、locator 仍命中）。
 *  注：复用洞察仍走 validateBatch（reachability 确定性重算、consistency 走缓存近零成本），不在此跳校验。 */
export function instantiateCachedInsights(
  cached: Insight[],
  batchId: string,
  history: HistoricalEvent[],
  startIdx: number,
): Insight[] {
  const histIds = new Set(history.map((h) => h.event_id));
  return cached.map((ins, k) => ({
    ...ins,
    id: `ins_${batchId}_${startIdx + k}`,
    is_followup: ins.event_id != null && histIds.has(ins.event_id),
  }));
}

/** 命中率度量（切片1 读出）：总分析次数 = distinct 键 + Σhit_count；would-be 命中 = Σhit_count。
 *  ⚠️ 这是**滑动窗口**度量、非累计（review m4）：每次 record 先删 14 天前的行（created_at 首写定不刷新），
 *  热键满 TTL 即整行删除、连同其 hit_count 一起消失 → 反映的是「近 ~TTL 天窗内」的重析行为，别当累计读。 */
export function analysisCacheStats(db: DB): {
  distinctKeys: number;
  totalAnalyses: number;
  wouldHit: number;
  wouldHitRate: number;
} {
  const r = db
    .prepare("SELECT count(*) k, COALESCE(sum(hit_count), 0) h FROM analysis_cache")
    .get() as { k: number; h: number };
  const total = r.k + r.h;
  return { distinctKeys: r.k, totalAnalyses: total, wouldHit: r.h, wouldHitRate: total ? r.h / total : 0 };
}
