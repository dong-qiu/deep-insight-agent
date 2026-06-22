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
