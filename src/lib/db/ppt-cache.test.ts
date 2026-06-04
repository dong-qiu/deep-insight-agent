import { beforeEach, describe, expect, it } from "vitest";
import type { Insight, Topic } from "../types.js";
import { type DB, openDb } from "./index.js";
import {
  computePolishInputsHash,
  deletePolishCacheEntry,
  getPolishCacheEntry,
  upsertPolishCacheEntry,
} from "./ppt-cache.js";

let db: DB;
const topic: Topic = {
  id: "t1", name: "AI 软件工程", keywords: ["k"], industry: "ai-swe", language: "zh",
  brief_schedule: "daily", enabled: true,
};
function ins(id: string, statement: string, basis = "x"): Pick<Insight, "id" | "statement" | "importance_basis"> {
  return { id, statement, importance_basis: basis };
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("computePolishInputsHash", () => {
  it("相同输入 → 相同 hash", () => {
    const a = computePolishInputsHash(topic, [ins("i1", "S1"), ins("i2", "S2")]);
    const b = computePolishInputsHash(topic, [ins("i1", "S1"), ins("i2", "S2")]);
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // SHA-256 hex
  });

  it("不同顺序 → 相同 hash（按 id 字典序归一）", () => {
    const a = computePolishInputsHash(topic, [ins("i1", "S1"), ins("i2", "S2")]);
    const b = computePolishInputsHash(topic, [ins("i2", "S2"), ins("i1", "S1")]);
    expect(a).toBe(b);
  });

  it("topic.name 变化 → hash 变化", () => {
    const a = computePolishInputsHash(topic, [ins("i1", "S1")]);
    const b = computePolishInputsHash({ ...topic, name: "AI 安全" }, [ins("i1", "S1")]);
    expect(a).not.toBe(b);
  });

  it("statement 变化 → hash 变化", () => {
    const a = computePolishInputsHash(topic, [ins("i1", "S1")]);
    const b = computePolishInputsHash(topic, [ins("i1", "S1 改写后")]);
    expect(a).not.toBe(b);
  });

  it("importance_basis 变化 → hash 变化", () => {
    const a = computePolishInputsHash(topic, [ins("i1", "S1", "basis A")]);
    const b = computePolishInputsHash(topic, [ins("i1", "S1", "basis B")]);
    expect(a).not.toBe(b);
  });

  it("增/删 insight → hash 变化", () => {
    const a = computePolishInputsHash(topic, [ins("i1", "S1")]);
    const b = computePolishInputsHash(topic, [ins("i1", "S1"), ins("i2", "S2")]);
    expect(a).not.toBe(b);
  });
});

describe("getPolishCacheEntry / upsertPolishCacheEntry", () => {
  it("未写入 → null", () => {
    expect(getPolishCacheEntry(db, "rep_x")).toBeNull();
  });

  it("写入往返：perInsight Map + executive + cost", () => {
    const polish = {
      perInsight: new Map([
        ["i1", { brief_summary: "凝练 1", implications: ["a", "b"] }],
        ["i2", { brief_summary: "凝练 2", implications: ["c"] }],
      ]),
      executive: { takeaways: ["TK1", "TK2", "TK3"] },
    };
    upsertPolishCacheEntry(db, "rep_x", "hash_v1", polish, { tokens: 1234, amount: 0.12 });
    const got = getPolishCacheEntry(db, "rep_x");
    expect(got).not.toBeNull();
    expect(got!.inputsHash).toBe("hash_v1");
    expect(got!.polish.perInsight.size).toBe(2);
    expect(got!.polish.perInsight.get("i1")).toEqual({ brief_summary: "凝练 1", implications: ["a", "b"] });
    expect(got!.polish.executive).toEqual({ takeaways: ["TK1", "TK2", "TK3"] });
    expect(got!.originalCost).toEqual({ tokens: 1234, amount: 0.12 });
  });

  it("UPSERT 覆盖（同 report_id 第二次写入替换旧条目）", () => {
    upsertPolishCacheEntry(db, "rep_x", "hash_v1", { perInsight: new Map(), executive: null }, { tokens: 1, amount: 0.01 });
    upsertPolishCacheEntry(db, "rep_x", "hash_v2", {
      perInsight: new Map([["i1", { brief_summary: "new", implications: ["x"] }]]),
      executive: { takeaways: ["new1", "new2"] },
    }, { tokens: 2000, amount: 0.2 });
    const got = getPolishCacheEntry(db, "rep_x")!;
    expect(got.inputsHash).toBe("hash_v2");
    expect(got.polish.perInsight.size).toBe(1);
    expect(got.originalCost.amount).toBe(0.2);
  });

  it("executive=null 也能正确读写", () => {
    upsertPolishCacheEntry(db, "rep_x", "h", {
      perInsight: new Map([["i1", { brief_summary: "s", implications: ["x"] }]]),
      executive: null,
    }, { tokens: 0, amount: 0 });
    expect(getPolishCacheEntry(db, "rep_x")!.polish.executive).toBeNull();
  });

  it("deletePolishCacheEntry 清掉条目", () => {
    upsertPolishCacheEntry(db, "rep_x", "h", { perInsight: new Map(), executive: null }, { tokens: 0, amount: 0 });
    deletePolishCacheEntry(db, "rep_x");
    expect(getPolishCacheEntry(db, "rep_x")).toBeNull();
  });

  it("polish_json 损坏 → 返 null + warn（不抛）", () => {
    // 手动塞个非法 JSON
    db.prepare("INSERT INTO ppt_polish_cache (report_id, inputs_hash, polish_json, tokens, amount, created_at) VALUES (?,?,?,?,?,datetime('now'))")
      .run("rep_bad", "h", "{not json", 0, 0);
    expect(getPolishCacheEntry(db, "rep_bad")).toBeNull();
  });
});
