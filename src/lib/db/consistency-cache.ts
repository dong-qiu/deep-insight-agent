/** 一致性判定缓存：跨批/跨run 复用 (statement, item.body) 的 Opus 一致性判定，省重复校验成本。
 *
 *  命中场景：relay 抖动导致的部分校验失败后重跑、报告重生成、幂等重试——同一 (结论, 原文) 不必再打 Opus。
 *  key = sha256(version + NUL + statement + NUL + body)：
 *   - version = 校验模型 + 一致性 prompt 哈希（由调用方 validator.consistencyCacheVersion() 提供）——
 *     **改模型/改 prompt → version 变 → key 变 → 自动重判**，旧判定不再命中（治安全关键路径的"陈旧判定"）。
 *   - statement/body 取精确字面（不归一化），避免假命中。
 *
 *  契约（安全关键路径，对齐"幻觉零容忍"）：
 *   - 只缓存**成功**判定（support/not_support/uncertain）；调用失败（not_evaluated）绝不入缓存——
 *     那是 relay/LLM 瞬时抖动，必须下次重试，缓存它会把瞬时故障固化成永久结论。
 *   - **TTL（默认 14 天）**：get 只返未过期项；过期项视为 miss → 重判。这给"重跑可纠错"留了出口——
 *     首跑偶发的错判最多冻结一个 TTL，不会永久发布。
 *   - **TTL 内首写定**（ON CONFLICT WHERE：仅当现有行已过期才覆写）：消除"同输入多跑→LLM 非确定性
 *     互相矛盾"的伪阳性，同时让过期项被新判定刷新（带新 created_at）。
 *   - get miss 返 undefined（不抛）。 */
import { createHash } from "node:crypto";
import type { ConsistencyCache, ConsistencyJudge } from "../types.js";
import type { DB } from "./index.js";

const DEFAULT_TTL_DAYS = 14;

/** (version, statement, body) → 稳定 key。NUL 分隔避免拼接歧义（'ab'+'c' ≠ 'a'+'bc'）。 */
export function computeConsistencyKey(version: string, statement: string, body: string): string {
  return createHash("sha256").update(`${version}\x00${statement}\x00${body}`).digest("hex");
}

interface CacheRow {
  consistency: ConsistencyJudge["consistency"];
  consistency_reason: ConsistencyJudge["consistency_reason"];
}

/** 构造一个 DB 支撑、按 version 隔离、带 TTL 的一致性缓存。
 *  ttlDays 默认读 CONSISTENCY_CACHE_TTL_DAYS（无则 14）。 */
export function makeConsistencyCache(db: DB, version: string, ttlDays?: number): ConsistencyCache {
  // env 解析必须挡 NaN/Infinity（`Number("Infinity")` 为真值、能漏过 `|| 14`，会算出 `-Infinity days`
  // → SQLite datetime 返 NULL → get 恒 miss + set 恒不刷新 = 缓存静默失效）。
  const envRaw = Number(process.env.CONSISTENCY_CACHE_TTL_DAYS);
  const envDays = Number.isFinite(envRaw) && envRaw >= 1 ? Math.floor(envRaw) : DEFAULT_TTL_DAYS;
  const days = ttlDays ?? envDays;
  const ttl = `-${days} days`; // SQLite datetime modifier
  // 构造时清一次过期行（含版本变更后被孤立、且已过 TTL 的旧行）——防表随版本churn/历史 body 无限增长。
  db.prepare("DELETE FROM consistency_cache WHERE created_at < datetime('now', ?)").run(ttl);
  const getStmt = db.prepare<[string, string], CacheRow>(
    "SELECT consistency, consistency_reason FROM consistency_cache WHERE key = ? AND created_at >= datetime('now', ?)",
  );
  // TTL 内：现有行未过期 → WHERE 假 → 不覆写（首写定）；现有行过期 → 覆写并刷新 created_at（重判生效）。
  const setStmt = db.prepare(
    `INSERT INTO consistency_cache (key, consistency, consistency_reason, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       consistency = excluded.consistency,
       consistency_reason = excluded.consistency_reason,
       created_at = excluded.created_at
     WHERE created_at < datetime('now', ?)`,
  );
  return {
    get(statement, body) {
      const row = getStmt.get(computeConsistencyKey(version, statement, body), ttl);
      if (!row) return undefined;
      // rationale 不入缓存（下游 checks 只用 consistency + consistency_reason）；标注来源便于排查。
      return { consistency: row.consistency, consistency_reason: row.consistency_reason, rationale: "(cached)" };
    },
    set(statement, body, judge) {
      setStmt.run(computeConsistencyKey(version, statement, body), judge.consistency, judge.consistency_reason, ttl);
    },
  };
}
