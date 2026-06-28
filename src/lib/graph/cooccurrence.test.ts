import { describe, expect, it } from "vitest";
import type { Entity, Insight } from "../types.js";
import { deriveCooccurrenceGraph, pickEdgeWeightForBudget } from "./cooccurrence.js";

/** 造一条只关心 entities 的洞察 */
function ins(id: string, entities: Entity[]): Insight {
  return {
    id,
    topic_id: "t",
    type: "aggregation",
    event_id: null,
    statement: "",
    importance: 3,
    importance_basis: "",
    citations: [],
    source_count: 1,
    multi_source: false,
    time_window: { start: "", end: "" },
    confidence: "high",
    language: "zh",
    entities,
  };
}
const org = (name: string): Entity => ({ name, type: "organization" });

describe("deriveCooccurrenceGraph", () => {
  it("同条共现一次 weight=1 < 默认阈值 2 → 不画边、节点全孤点被剔", () => {
    const g = deriveCooccurrenceGraph([ins("i1", [org("OpenAI"), org("Cursor")])]);
    expect(g.edges).toEqual([]);
    expect(g.nodes).toEqual([]);
  });

  it("共现 2 条 → 一条 weight=2 的边 + 两节点 mentions=2", () => {
    const g = deriveCooccurrenceGraph([
      ins("i1", [org("OpenAI"), org("Cursor")]),
      ins("i2", [org("OpenAI"), org("Cursor")]),
    ]);
    expect(g.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 2 }]);
    expect(g.nodes.map((n) => [n.name, n.mentions])).toEqual([
      ["Cursor", 2],
      ["OpenAI", 2],
    ]);
  });

  it("多词实体名（含空格）正确连边——回归：曾用分隔符 join/split 会拆错", () => {
    const g = deriveCooccurrenceGraph([
      ins("i1", [{ name: "Sam Altman", type: "person" }, { name: "Claude Code", type: "product" }]),
      ins("i2", [{ name: "Sam Altman", type: "person" }, { name: "Claude Code", type: "product" }]),
    ]);
    expect(g.edges).toEqual([{ a: "Claude Code", b: "Sam Altman", weight: 2 }]);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["Claude Code", "Sam Altman"]);
  });

  it("边 key 顺序无关：A,B 与 B,A 累加进同一对", () => {
    const g = deriveCooccurrenceGraph([
      ins("i1", [org("OpenAI"), org("Cursor")]),
      ins("i2", [org("Cursor"), org("OpenAI")]), // 反序
    ]);
    expect(g.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 2 }]);
  });

  it("一条洞察内同名重复只计一次（防脏数据虚增）", () => {
    const g = deriveCooccurrenceGraph(
      [
        ins("i1", [org("OpenAI"), org("OpenAI"), org("Cursor")]),
        ins("i2", [org("OpenAI"), org("Cursor")]),
      ],
      { minEdgeWeight: 2 },
    );
    expect(g.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 2 }]);
    expect(g.nodes.find((n) => n.name === "OpenAI")!.mentions).toBe(2); // 不是 3
  });

  it("trim 名称、丢空白名", () => {
    const g = deriveCooccurrenceGraph([
      ins("i1", [{ name: "  OpenAI ", type: "organization" }, org("Cursor"), { name: "  ", type: "organization" }]),
      ins("i2", [org("OpenAI"), org("Cursor")]),
    ]);
    expect(g.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 2 }]);
    expect(g.nodes.some((n) => n.name === "")).toBe(false);
  });

  it("少于 2 实体的洞察不产边", () => {
    const g = deriveCooccurrenceGraph([ins("i1", [org("OpenAI")]), ins("i2", [])], { minEdgeWeight: 1 });
    expect(g.edges).toEqual([]);
  });

  it("minEdgeWeight 阈值可调：=1 时单次共现也连", () => {
    const g = deriveCooccurrenceGraph([ins("i1", [org("OpenAI"), org("Cursor")])], { minEdgeWeight: 1 });
    expect(g.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 1 }]);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["Cursor", "OpenAI"]);
  });

  it("topN 按 mentions 截断：低频实体及其边被排除", () => {
    // A,B 共现多次（高频）；C 只和 A 共现 2 次但 C 自身 mentions 低
    const list: Insight[] = [];
    for (let k = 0; k < 5; k++) list.push(ins(`ab${k}`, [org("A"), org("B")]));
    list.push(ins("ac1", [org("A"), org("C")]));
    list.push(ins("ac2", [org("A"), org("C")]));
    const g = deriveCooccurrenceGraph(list, { minEdgeWeight: 2, topN: 2 });
    // top2 by mentions = A(7), B(5) → 只剩 A-B；C 落选、A-C 边随之消失
    expect(g.nodes.map((n) => n.name)).toEqual(["A", "B"]);
    expect(g.edges).toEqual([{ a: "A", b: "B", weight: 5 }]);
  });

  it("孤点剔除：候选集里没有任何边的实体不出现在 nodes", () => {
    const g = deriveCooccurrenceGraph(
      [
        ins("i1", [org("OpenAI"), org("Cursor")]),
        ins("i2", [org("OpenAI"), org("Cursor")]),
        ins("i3", [org("Lonely")]), // 高 topN 也进候选，但无边
        ins("i4", [org("Lonely")]),
        ins("i5", [org("Lonely")]),
      ],
      { minEdgeWeight: 2, topN: 40 },
    );
    expect(g.nodes.some((n) => n.name === "Lonely")).toBe(false);
  });

  it("dominantType：同名跨条 type 不一致取众数", () => {
    const g = deriveCooccurrenceGraph(
      [
        ins("i1", [{ name: "Codex", type: "product" }, org("OpenAI")]),
        ins("i2", [{ name: "Codex", type: "product" }, org("OpenAI")]),
        ins("i3", [{ name: "Codex", type: "project" }, org("OpenAI")]),
      ],
      { minEdgeWeight: 2 },
    );
    expect(g.nodes.find((n) => n.name === "Codex")!.type).toBe("product"); // 2 票 > 1 票
  });

  it("空输入 → 空图", () => {
    expect(deriveCooccurrenceGraph([])).toEqual({ nodes: [], edges: [] });
  });

  describe("pickEdgeWeightForBudget（按边密度自适应初始阈值）", () => {
    /** n 条都含 [a,b] 的洞察 → 该对共现 n 次 */
    const pairN = (a: string, b: string, n: number): Insight[] =>
      Array.from({ length: n }, (_, k) => ins(`${a}${b}${k}`, [org(a), org(b)]));

    it("w2 即在预算内 → 返回 2", () => {
      const g = [...pairN("A", "B", 2), ...pairN("C", "D", 2)]; // w2 时 2 条边
      expect(pickEdgeWeightForBudget(g, { targetMaxEdges: 5, maxWeight: 4 })).toBe(2);
    });

    it("w2 超预算、w3 落进 → 返回 3", () => {
      const g = [...pairN("A", "B", 2), ...pairN("C", "D", 2)]; // w2:2 边 > 预算1；w3:0 边 ≤1
      expect(pickEdgeWeightForBudget(g, { targetMaxEdges: 1, maxWeight: 4 })).toBe(3);
    });

    it("到上限仍超预算 → 返回 maxWeight", () => {
      const g = pairN("A", "B", 10); // 任何 w≤4 都有 1 条边
      expect(pickEdgeWeightForBudget(g, { targetMaxEdges: 0, maxWeight: 4 })).toBe(4);
    });
  });

  it("边按 weight 降序排列", () => {
    const list: Insight[] = [
      ins("x1", [org("A"), org("B")]),
      ins("x2", [org("A"), org("B")]),
      ins("x3", [org("A"), org("B")]), // A-B weight 3
      ins("y1", [org("A"), org("C")]),
      ins("y2", [org("A"), org("C")]), // A-C weight 2
    ];
    const g = deriveCooccurrenceGraph(list, { minEdgeWeight: 2 });
    expect(g.edges.map((e) => e.weight)).toEqual([3, 2]);
  });
});
