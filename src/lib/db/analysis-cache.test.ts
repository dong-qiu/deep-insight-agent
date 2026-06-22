/** analysis-cache（ADR-0009 切片1）单测 —— 内存库，无需 API key，CI 可跑。
 *  重点：键稳定 + 版本隔离、单源归属、hit_count 计 would-be 命中、命中率度量、行为中性（异常吞）。 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ContentItem, Insight } from "../types.js";
import {
  analysisCacheStats,
  computeAnalysisKey,
  recordAnalysisCache,
} from "./analysis-cache.js";
import { type DB, openDb } from "./index.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

function mkItem(id: string, hash: string): ContentItem {
  return {
    id, source_id: "s1", url: `https://x/${id}`, title: "T", author: null,
    published_at: "2026-06-20", fetched_at: "2026-06-21T00:00:00Z", language: "en",
    topic_ids: ["t1"], tags: [], body: "b", body_kind: "article", raw_ref: "", content_hash: hash,
    fetch_status: "ok",
  };
}
function mkInsight(id: string, citedItemIds: string[]): Insight {
  return {
    id, topic_id: "t1", type: "aggregation", event_id: null, statement: `s_${id}`,
    importance: 3, importance_basis: "b", confidence: "high", language: "en",
    source_count: new Set(citedItemIds).size, multi_source: new Set(citedItemIds).size > 1,
    time_window: { start: "2026-06-13", end: "2026-06-20" },
    citations: citedItemIds.map((cid, i) => ({
      content_item_id: cid, quote: `q${i}`, locator: { paragraph_index: 0, char_start: 0, char_end: 1 },
    })),
  };
}

describe("computeAnalysisKey", () => {
  it("同 (version,topic,hash) → 同 key；版本变 → key 变（版本隔离）", () => {
    const a = computeAnalysisKey("v1", "t1", "h1");
    expect(computeAnalysisKey("v1", "t1", "h1")).toBe(a);
    expect(computeAnalysisKey("v2", "t1", "h1")).not.toBe(a); // 改模型/prompt → 失效
    expect(computeAnalysisKey("v1", "t2", "h1")).not.toBe(a); // 跨 topic 隔离
    expect(computeAnalysisKey("v1", "t1", "h2")).not.toBe(a); // 内容变 → 重析
  });
});

describe("recordAnalysisCache", () => {
  it("首轮全 miss；同内容再记 → would-be 命中累加（hit_count++）", () => {
    const items = [mkItem("ci1", "h1"), mkItem("ci2", "h2")];
    const ins = [mkInsight("i1", ["ci1"])];
    const r1 = recordAnalysisCache(db, "t1", items, ins, "v1");
    expect(r1).toEqual({ writes: 2, wouldHit: 0 }); // 首轮俩 item 全新

    const r2 = recordAnalysisCache(db, "t1", items, ins, "v1");
    expect(r2).toEqual({ writes: 2, wouldHit: 2 }); // 同内容再析 → 俩都 would-hit

    const st = analysisCacheStats(db);
    expect(st.distinctKeys).toBe(2);
    expect(st.wouldHit).toBe(2);
    expect(st.totalAnalyses).toBe(4); // 2 distinct + 2 命中
    expect(st.wouldHitRate).toBeCloseTo(0.5); // 第二轮全冗余
  });

  it("版本变 → 旧键不撞 → 全 miss（缓存按版本失效）", () => {
    const items = [mkItem("ci1", "h1")];
    recordAnalysisCache(db, "t1", items, [], "v1");
    const r = recordAnalysisCache(db, "t1", items, [], "v2"); // 改了 analyzer prompt/模型
    expect(r.wouldHit).toBe(0); // 新版本 → 不命中旧
  });

  it("没产出洞察的 item 也入缓存（空数组）——捕获完整重析冗余", () => {
    const items = [mkItem("ci1", "h1")];
    recordAnalysisCache(db, "t1", items, [], "v1"); // 该 item 没产出
    const again = recordAnalysisCache(db, "t1", items, [], "v1");
    expect(again.wouldHit).toBe(1); // 零产出 item 重析也算冗余命中
  });

  it("只缓存单源洞察；跨条洞察（多 item）不归属任何单 item", () => {
    const items = [mkItem("ci1", "h1"), mkItem("ci2", "h2")];
    const insights = [mkInsight("i1", ["ci1"]), mkInsight("i2", ["ci1", "ci2"])]; // i2 跨两源
    recordAnalysisCache(db, "t1", items, insights, "v1");
    const row = db
      .prepare("SELECT insights_json FROM analysis_cache WHERE content_hash = ?")
      .get("h1") as { insights_json: string };
    const stored = JSON.parse(row.insights_json) as Insight[];
    expect(stored.map((x) => x.id)).toEqual(["i1"]); // 仅单源 i1，跨条 i2 不入
  });

  it("同轮内两不同 item 同 content_hash（同文多源）→ 去重、不虚计 wouldHit（review M1）", () => {
    const items = [mkItem("ci1", "hSAME"), mkItem("ci2", "hSAME")]; // 不同 id、同内容指纹
    const r1 = recordAnalysisCache(db, "t1", items, [], "v1");
    expect(r1).toEqual({ writes: 1, wouldHit: 0 }); // 去重为 1 个键、首轮 miss（非「跨日命中」）
    const r2 = recordAnalysisCache(db, "t1", items, [], "v1");
    expect(r2).toEqual({ writes: 1, wouldHit: 1 }); // 第二轮才是真·跨轮命中
  });

  it("同一 item 多条 quote（多 citation 同 item）仍归单源（review m1）", () => {
    const items = [mkItem("ci1", "h1")];
    recordAnalysisCache(db, "t1", items, [mkInsight("i1", ["ci1", "ci1"])], "v1"); // 同 item 两 quote
    const row = db
      .prepare("SELECT insights_json FROM analysis_cache WHERE content_hash = ?")
      .get("h1") as { insights_json: string };
    expect((JSON.parse(row.insights_json) as Insight[]).map((x) => x.id)).toEqual(["i1"]); // 仍单源、入缓存
  });

  it("insights_json 首写定：同键重写不覆写已存洞察", () => {
    const items = [mkItem("ci1", "h1")];
    recordAnalysisCache(db, "t1", items, [mkInsight("first", ["ci1"])], "v1");
    recordAnalysisCache(db, "t1", items, [mkInsight("second", ["ci1"])], "v1"); // 同 content_hash 再记
    const row = db
      .prepare("SELECT insights_json, hit_count FROM analysis_cache WHERE content_hash = ?")
      .get("h1") as { insights_json: string; hit_count: number };
    expect((JSON.parse(row.insights_json) as Insight[])[0].id).toBe("first"); // 首写定
    expect(row.hit_count).toBe(1);
  });
});

describe("行为中性 / 健壮", () => {
  it("空 items → 不报错、零写入", () => {
    expect(recordAnalysisCache(db, "t1", [], [], "v1")).toEqual({ writes: 0, wouldHit: 0 });
    expect(analysisCacheStats(db)).toEqual({ distinctKeys: 0, totalAnalyses: 0, wouldHit: 0, wouldHitRate: 0 });
  });
});
