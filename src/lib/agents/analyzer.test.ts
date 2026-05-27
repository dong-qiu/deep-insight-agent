/**
 * analyzer 产出守卫的纯函数单测 —— 无需 API key，CI 可跑（npm test）。
 * 覆盖截断检测（结构化输出偶发把长 statement 提前收尾）。
 */
import { describe, expect, it } from "vitest";
import type { ContentItem } from "../types.js";
import { chunkByChars, isCompleteStatement, repairQuote } from "./analyzer.js";

function item(id: string, bodyLen: number): ContentItem {
  return {
    id, source_id: "s", url: `https://x/${id}`, title: "t", author: null, published_at: null,
    fetched_at: "2026-05-27T00:00:00Z", language: "en", topic_ids: ["t"], tags: [],
    body: "x".repeat(bodyLen), raw_ref: "", content_hash: `h_${id}`, fetch_status: "ok",
  };
}

describe("isCompleteStatement", () => {
  it("完整句（句末标点）→ true", () => {
    expect(isCompleteStatement("模型把回归率降低了 38%。")).toBe(true);
    expect(isCompleteStatement("This is a complete sentence.")).toBe(true);
    expect(isCompleteStatement("结论是否成立？")).toBe(true);
    expect(isCompleteStatement("某结论（详见原文）")).toBe(true);
  });

  it("截断（非句末标点收尾）→ false", () => {
    // 三轮实跑里真实出现的截断尾巴
    expect(isCompleteStatement("一项针对高风险医疗问答场景的研究提出了")).toBe(false);
    expect(isCompleteStatement("…混淆样本与干净样本的嵌入最小间距仅为 1.02，存在显著的")).toBe(false);
    expect(isCompleteStatement("面向高风险医疗问答场景，研究者提出")).toBe(false);
  });

  it("忽略首尾空白", () => {
    expect(isCompleteStatement("  完整结论。  ")).toBe(true);
    expect(isCompleteStatement("半句结论 ")).toBe(false);
  });
});

describe("chunkByChars（F4 分批）", () => {
  it("小池不超预算 → 单批", () => {
    const items = [item("a", 5000), item("b", 5000)];
    const chunks = chunkByChars(items, 30_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("累计超预算 → 切多批，顺序保持", () => {
    const items = [item("a", 20_000), item("b", 20_000), item("c", 5_000)];
    const chunks = chunkByChars(items, 30_000);
    expect(chunks.map((c) => c.map((i) => i.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("单条超预算 → 独占一批（不丢）", () => {
    const items = [item("big", 50_000), item("small", 1_000)];
    const chunks = chunkByChars(items, 30_000);
    expect(chunks).toEqual([[items[0]], [items[1]]]);
  });

  it("空输入 → 空批列表", () => {
    expect(chunkByChars([], 30_000)).toEqual([]);
  });
});

describe("repairQuote（M3-6 引用对齐修复）", () => {
  it("起头逐字、后半漂移 → snap 回连续 verbatim 子串（变可达）", () => {
    const body = "Coding agents introduce tangled refactorings less frequently than human developers.";
    const quote = "Coding agents introduce tangled refactorings less often than humans"; // “often/humans”漂移
    const r = repairQuote(body, quote);
    expect(r).not.toBeNull();
    expect(body.replace(/\s+/g, " ").includes(r!)).toBe(true); // 修复后是正文连续子串 → 可达
    expect(r!.length).toBeGreaterThanOrEqual(24);
    expect(r).not.toContain("often"); // 漂移部分被切掉
  });

  it("已逐字可达 → null（用原 quote）", () => {
    expect(repairQuote("The full sentence appears verbatim in the body.", "The full sentence appears verbatim")).toBeNull();
  });

  it("起头都不在正文（真改写）→ null（不造假，留给可达性闸门挡下）", () => {
    expect(repairQuote("The system records action accuracy of 0.92 on test.", "A totally unrelated claim sharing no prefix at all here.")).toBeNull();
  });

  it("太短 → null", () => {
    expect(repairQuote("some sufficiently long body text here", "short")).toBeNull();
  });
});
