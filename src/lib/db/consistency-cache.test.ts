import { beforeEach, describe, expect, it } from "vitest";
import type { ConsistencyJudge } from "../types.js";
import { computeConsistencyKey, makeConsistencyCache } from "./consistency-cache.js";
import { type DB, openDb } from "./index.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

const V = "model-x|promptv1"; // 版本标签
const judge = (c: ConsistencyJudge["consistency"], r: ConsistencyJudge["consistency_reason"]): ConsistencyJudge =>
  ({ consistency: c, consistency_reason: r, rationale: "r" });

describe("computeConsistencyKey", () => {
  it("相同 (version, statement, body) → 相同 key（64 位 hex）", () => {
    const a = computeConsistencyKey(V, "结论", "原文");
    expect(a).toBe(computeConsistencyKey(V, "结论", "原文"));
    expect(a).toHaveLength(64);
  });
  it("version / statement / body 任一变化 → key 变（版本隔离）", () => {
    expect(computeConsistencyKey(V, "S", "B")).not.toBe(computeConsistencyKey("model-y|promptv1", "S", "B"));
    expect(computeConsistencyKey(V, "S", "B")).not.toBe(computeConsistencyKey(V, "S2", "B"));
    expect(computeConsistencyKey(V, "S", "B")).not.toBe(computeConsistencyKey(V, "S", "B2"));
  });
  it("NUL 分隔防拼接歧义：('ab','c') ≠ ('a','bc')", () => {
    expect(computeConsistencyKey(V, "ab", "c")).not.toBe(computeConsistencyKey(V, "a", "bc"));
  });
});

describe("makeConsistencyCache", () => {
  it("set 后 get 命中、返回判定（rationale 标 cached）", () => {
    const cache = makeConsistencyCache(db, V);
    expect(cache.get("S", "B")).toBeUndefined(); // miss
    cache.set("S", "B", judge("support", "ok"));
    expect(cache.get("S", "B")).toMatchObject({ consistency: "support", consistency_reason: "ok" });
    expect(cache.get("S", "B")?.rationale).toBe("(cached)");
  });

  it("版本隔离：换 version 即 miss（治改模型/改 prompt 后的陈旧判定）", () => {
    makeConsistencyCache(db, "v-old").set("S", "B", judge("support", "ok"));
    expect(makeConsistencyCache(db, "v-new").get("S", "B")).toBeUndefined(); // 新版本不命中旧判定
    expect(makeConsistencyCache(db, "v-old").get("S", "B")?.consistency).toBe("support"); // 旧版本仍命中
  });

  it("TTL 内首写定：同 key 第二次写不覆写（消除非确定性翻转）", () => {
    const cache = makeConsistencyCache(db, V);
    cache.set("S", "B", judge("support", "ok"));
    cache.set("S", "B", judge("not_support", "exaggeration")); // 未过期 → 不覆写
    expect(cache.get("S", "B")?.consistency).toBe("support");
  });

  it("TTL 过期：get 视为 miss，且新判定刷新覆写（重跑可纠错）", () => {
    const cache = makeConsistencyCache(db, V, 14);
    const key = computeConsistencyKey(V, "S", "B");
    // 直接插一条 20 天前的旧判定
    db.prepare("INSERT INTO consistency_cache (key, consistency, consistency_reason, created_at) VALUES (?,?,?,datetime('now','-20 days'))")
      .run(key, "support", "ok");
    expect(cache.get("S", "B")).toBeUndefined(); // 过期 → miss
    cache.set("S", "B", judge("not_support", "exaggeration")); // 过期项允许刷新
    expect(cache.get("S", "B")?.consistency).toBe("not_support"); // 已被新判定覆写、created_at 刷新
  });

  it("跨实例持久化：实例 A set，新实例 B get 命中（缓存的本职）", () => {
    makeConsistencyCache(db, V).set("S", "B", judge("uncertain", "uncertain"));
    expect(makeConsistencyCache(db, V).get("S", "B")?.consistency).toBe("uncertain");
  });

  it("构造时 prune 过期行（防表无限增长）", () => {
    db.prepare("INSERT INTO consistency_cache (key, consistency, consistency_reason, created_at) VALUES ('old','support','ok',datetime('now','-30 days'))").run();
    db.prepare("INSERT INTO consistency_cache (key, consistency, consistency_reason, created_at) VALUES ('fresh','support','ok',datetime('now'))").run();
    makeConsistencyCache(db, V, 14); // 构造即清理
    const rows = db.prepare("SELECT key FROM consistency_cache ORDER BY key").all() as { key: string }[];
    expect(rows.map((r) => r.key)).toEqual(["fresh"]); // 30 天前的被清，新的留
  });

  it("非法 TTL env（Infinity）→ 回退默认 14 天，缓存仍可用（不静默失效）", () => {
    process.env.CONSISTENCY_CACHE_TTL_DAYS = "Infinity";
    try {
      const cache = makeConsistencyCache(db, V); // 不传 ttlDays，走 env 解析
      cache.set("S", "B", judge("support", "ok"));
      expect(cache.get("S", "B")?.consistency).toBe("support"); // 命中 = TTL 没被算成 NULL
    } finally {
      delete process.env.CONSISTENCY_CACHE_TTL_DAYS;
    }
  });
});
