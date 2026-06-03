import { afterEach, describe, expect, it, vi } from "vitest";
import type { Insight, Topic } from "../types.js";
import type { IncludedInsightLite } from "./ppt-gen.js";

// 把 callStructured mock 掉——无 API key、CI 可跑
vi.mock("../runtime/llm.js", () => ({
  callStructured: vi.fn(),
}));

import { callStructured } from "../runtime/llm.js";
import { polishForPpt } from "./ppt-polish.js";

afterEach(() => {
  vi.mocked(callStructured).mockReset();
});

const topic: Topic = {
  id: "t1", name: "AI 软件工程", keywords: ["k"], industry: "ai-swe", language: "zh",
  brief_schedule: "daily", enabled: true,
};

function ins(id: string, statement: string, importance = 5): Insight {
  return {
    id, topic_id: "t1", type: "aggregation", event_id: null, statement, importance,
    importance_basis: "因为重要", citations: [], source_count: 0, multi_source: false,
    time_window: { start: "2026-06-01", end: "2026-06-07" }, confidence: null, language: "zh",
  };
}
function lite(i: Insight): IncludedInsightLite {
  return { insight: i, citationIndices: [], flagged: false };
}

describe("polishForPpt", () => {
  it("正常路径：N 条 insight + executive，全部成功 → perInsight 全填、cost 累计", async () => {
    const insightCall = {
      data: { brief_summary: "凝练", implications: ["启示 1", "启示 2"] },
      usage: {} as Parameters<typeof callStructured>[0],
      cost: { tokens: 100, amount: 0.01 },
    };
    const execCall = {
      data: { takeaways: ["TK1", "TK2", "TK3"] },
      usage: {} as Parameters<typeof callStructured>[0],
      cost: { tokens: 500, amount: 0.05 },
    };
    vi.mocked(callStructured).mockImplementation((opts) => {
      opts.onCost?.(opts.system.includes("Executive") ? execCall.cost : insightCall.cost);
      return Promise.resolve(opts.system.includes("Executive") ? (execCall as unknown as ReturnType<typeof callStructured>) : (insightCall as unknown as ReturnType<typeof callStructured>));
    });
    const insights = [lite(ins("i1", "S1")), lite(ins("i2", "S2"))];
    const r = await polishForPpt(insights, topic);
    expect(r.perInsight.size).toBe(2);
    expect(r.perInsight.get("i1")).toEqual({ brief_summary: "凝练", implications: ["启示 1", "启示 2"] });
    expect(r.executive).toEqual({ takeaways: ["TK1", "TK2", "TK3"] });
    // cost = 2 * insight + 1 executive
    expect(r.cost.amount).toBeCloseTo(0.01 + 0.01 + 0.05);
    expect(callStructured).toHaveBeenCalledTimes(3);
  });

  it("单条 polish 失败 → perInsight 缺该条，其他正常；不抛", async () => {
    let calls = 0;
    vi.mocked(callStructured).mockImplementation((opts) => {
      calls++;
      // 仅"单条 insight 调用且含 S_fail"失败；executive 因 system 不同放行
      const isExecutive = opts.system.includes("Executive");
      if (!isExecutive && opts.user.includes("S_fail")) return Promise.reject(new Error("relay 503"));
      const ok = opts.system.includes("Executive")
        ? { data: { takeaways: ["TK"] }, usage: {}, cost: { tokens: 1, amount: 0 } }
        : { data: { brief_summary: "ok", implications: ["x"] }, usage: {}, cost: { tokens: 1, amount: 0 } };
      return Promise.resolve(ok as unknown as ReturnType<typeof callStructured>);
    });
    const insights = [lite(ins("i_fail", "S_fail")), lite(ins("i_ok", "S_ok"))];
    const r = await polishForPpt(insights, topic);
    expect(r.perInsight.has("i_fail")).toBe(false);
    expect(r.perInsight.has("i_ok")).toBe(true);
    expect(r.executive).not.toBeNull();
    expect(calls).toBe(3);
  });

  it("executive 失败 → executive=null，不影响 perInsight", async () => {
    vi.mocked(callStructured).mockImplementation((opts) => {
      if (opts.system.includes("Executive")) return Promise.reject(new Error("timeout"));
      return Promise.resolve({
        data: { brief_summary: "ok", implications: ["x"] }, usage: {}, cost: { tokens: 1, amount: 0 },
      } as unknown as ReturnType<typeof callStructured>);
    });
    const r = await polishForPpt([lite(ins("i1", "S1"))], topic);
    expect(r.executive).toBeNull();
    expect(r.perInsight.size).toBe(1);
  });

  it("空 keyInsights → executive=null、perInsight 空、不调 LLM", async () => {
    const r = await polishForPpt([], topic);
    expect(r.executive).toBeNull();
    expect(r.perInsight.size).toBe(0);
    expect(callStructured).not.toHaveBeenCalled();
  });
});
