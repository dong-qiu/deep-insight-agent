/** analysis-cache（ADR-0009 切片1）单测 —— 内存库，无需 API key，CI 可跑。
 *  重点：键稳定 + 版本隔离、单源归属、hit_count 计 would-be 命中、命中率度量、行为中性（异常吞）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentItem, Insight } from "../types.js";
import type { HistoricalEvent } from "../agents/analyzer.js";
import {
  analysisCacheStats,
  computeAnalysisKey,
  instantiateCachedInsights,
  isFullReanalyzeToday,
  lookupCachedInsights,
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

describe("lookupCachedInsights（切片2 读分流）", () => {
  it("已缓存 item → 命中（取回单源洞察）；新 item → 未命中", () => {
    recordAnalysisCache(db, "t1", [mkItem("ci1", "h1")], [mkInsight("i1", ["ci1"])], "v1");
    const r = lookupCachedInsights(db, "t1", [mkItem("ci1", "h1"), mkItem("ci2", "h2")], "v1");
    expect(r.hits.map((x) => x.id)).toEqual(["i1"]);
    expect(r.missItems.map((x) => x.id)).toEqual(["ci2"]);
    expect(r.hitItemCount).toBe(1);
  });

  it("零产出 item 命中 = 空洞察但不算 miss（不重析）", () => {
    recordAnalysisCache(db, "t1", [mkItem("ci1", "h1")], [], "v1"); // 当初没产出
    const r = lookupCachedInsights(db, "t1", [mkItem("ci1", "h1")], "v1");
    expect(r.hits).toEqual([]);
    expect(r.missItems).toEqual([]); // 命中（键存在）→ 不重析
    expect(r.hitItemCount).toBe(1);
  });

  it("版本不符 → 全未命中（按版本失效）", () => {
    recordAnalysisCache(db, "t1", [mkItem("ci1", "h1")], [mkInsight("i1", ["ci1"])], "v1");
    const r = lookupCachedInsights(db, "t1", [mkItem("ci1", "h1")], "v2");
    expect(r.hits).toEqual([]);
    expect(r.missItems.map((x) => x.id)).toEqual(["ci1"]);
  });

  it("坏 JSON → 当未命中重析（安全）", () => {
    db.prepare(
      "INSERT INTO analysis_cache (key,topic_id,content_hash,insights_json,hit_count,created_at,last_seen) VALUES (?,?,?,?,0,datetime('now'),datetime('now'))",
    ).run(computeAnalysisKey("v1", "t1", "h1"), "t1", "h1", "not json");
    const r = lookupCachedInsights(db, "t1", [mkItem("ci1", "h1")], "v1");
    expect(r.hits).toEqual([]);
    expect(r.missItems.map((x) => x.id)).toEqual(["ci1"]); // 坏 JSON → miss
  });

  it("同轮同 content_hash 去重：只处理首个", () => {
    recordAnalysisCache(db, "t1", [mkItem("ci1", "hS")], [mkInsight("i1", ["ci1"])], "v1");
    const r = lookupCachedInsights(db, "t1", [mkItem("ci1", "hS"), mkItem("ci2", "hS")], "v1");
    expect(r.hitItemCount).toBe(1); // 第二个同指纹 item 被跳过、不重复实例化
    expect(r.hits.map((x) => x.id)).toEqual(["i1"]);
  });

  it("M1 防御：被引 id 不在当前窗口（同内容换了 id）→ 退回重析、不复用断引洞察", () => {
    // 缓存：item ci_old(h1) 产 insight 引 ci_old
    recordAnalysisCache(db, "t1", [mkItem("ci_old", "h1")], [mkInsight("i1", ["ci_old"])], "v1");
    // 本轮窗口里是 ci_new（同内容 h1、不同 id；ci_old 已不在窗）→ 命中键但被引 ci_old 不在窗
    const r = lookupCachedInsights(db, "t1", [mkItem("ci_new", "h1")], "v1");
    expect(r.hits).toEqual([]); // 不复用断引洞察
    expect(r.missItems.map((x) => x.id)).toEqual(["ci_new"]); // 退回重析（安全）
  });
});

describe("isFullReanalyzeToday（切片2c 周期全析兜底）", () => {
  const saved = process.env.FULL_REANALYZE_DOW;
  afterEach(() => {
    if (saved === undefined) delete process.env.FULL_REANALYZE_DOW;
    else process.env.FULL_REANALYZE_DOW = saved;
  });
  const day = new Date(Date.UTC(2026, 0, 5, 12, 0, 0)); // 某固定 UTC 日
  const dow = day.getUTCDay();

  it("FULL_REANALYZE_DOW 匹配当日 dow → 全析日；不匹配 → 否", () => {
    process.env.FULL_REANALYZE_DOW = String(dow);
    expect(isFullReanalyzeToday(day)).toBe(true);
    process.env.FULL_REANALYZE_DOW = String((dow + 1) % 7);
    expect(isFullReanalyzeToday(day)).toBe(false);
  });

  it("缺省（未设）= 每周一（dow=1）", () => {
    delete process.env.FULL_REANALYZE_DOW;
    expect(isFullReanalyzeToday(day)).toBe(dow === 1);
  });

  it("-1 / 非法值 → 关闭兜底（任何日都 false）", () => {
    for (const v of ["-1", "7", "x", ""]) {
      process.env.FULL_REANALYZE_DOW = v;
      // 空串走缺省=1，需单独判
      if (v === "") expect(isFullReanalyzeToday(day)).toBe(dow === 1);
      else expect(isFullReanalyzeToday(day)).toBe(false);
    }
  });
});

describe("instantiateCachedInsights（切片2 实例化）", () => {
  const cached: Insight[] = [
    { ...mkInsight("old1", ["ci1"]), event_id: "evt_A" },
    { ...mkInsight("old2", ["ci2"]), event_id: "evt_B" },
  ];

  it("重生 id（从 startIdx 续号）+ 保持 event_id", () => {
    const out = instantiateCachedInsights(cached, "batch_X", [], 3);
    expect(out.map((x) => x.id)).toEqual(["ins_batch_X_3", "ins_batch_X_4"]);
    expect(out.map((x) => x.event_id)).toEqual(["evt_A", "evt_B"]); // 事件身份稳定
  });

  it("is_followup 按当前 history 重判（事件已报告 → true）", () => {
    const history: HistoricalEvent[] = [{ event_id: "evt_A", statement: "s", date: "2026-06-25" }];
    const out = instantiateCachedInsights(cached, "batch_X", history, 0);
    expect(out.find((x) => x.event_id === "evt_A")?.is_followup).toBe(true); // 在历史 → 复报标记
    expect(out.find((x) => x.event_id === "evt_B")?.is_followup).toBe(false); // 不在历史 → 当新
  });

  it("statement / citations 原样复用", () => {
    const out = instantiateCachedInsights(cached, "b", [], 0);
    expect(out[0].statement).toBe("s_old1");
    expect(out[0].citations).toEqual(cached[0].citations);
  });
});
