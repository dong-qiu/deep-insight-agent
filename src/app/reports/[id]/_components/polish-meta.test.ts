import { describe, expect, it } from "vitest";
import { describePolishMeta, parsePolishMeta, shouldOfferRefresh } from "./polish-meta.js";

function h(map: Record<string, string>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(map)) out.set(k, v);
  return out;
}

describe("parsePolishMeta", () => {
  it("hit · complete · 13/13 exec=y → 完整结构 + cost=0", () => {
    const m = parsePolishMeta(
      h({
        "X-Ppt-Polish-Cache": "hit",
        "X-Ppt-Polish-Status": "complete",
        "X-Ppt-Polish-Coverage": "13/13 exec=y",
        "X-Ppt-Polish-Cost-Usd": "0.000000",
      }),
    );
    expect(m).toEqual({
      cache: "hit",
      status: "complete",
      coverage: { perInsightDone: 13, perInsightTotal: 13, hasExecutive: true },
      costUsd: 0,
    });
  });

  it("miss · partial · 9/13 exec=n + 真实成本", () => {
    const m = parsePolishMeta(
      h({
        "X-Ppt-Polish-Cache": "miss",
        "X-Ppt-Polish-Status": "partial",
        "X-Ppt-Polish-Coverage": "9/13 exec=n",
        "X-Ppt-Polish-Cost-Usd": "0.172370",
      }),
    );
    expect(m!.cache).toBe("miss");
    expect(m!.status).toBe("partial");
    expect(m!.coverage).toEqual({ perInsightDone: 9, perInsightTotal: 13, hasExecutive: false });
    expect(m!.costUsd).toBeCloseTo(0.17237);
  });

  it("A 路径（无 polish）→ status=none → 返 null（UI 不显示状态行）", () => {
    const m = parsePolishMeta(
      h({
        "X-Ppt-Polish-Cache": "none",
        "X-Ppt-Polish-Status": "none",
        "X-Ppt-Polish-Coverage": "0/0 exec=n",
        "X-Ppt-Polish-Cost-Usd": "0.000000",
      }),
    );
    expect(m).toBeNull();
  });

  it("header 缺失 → null", () => {
    expect(parsePolishMeta(h({}))).toBeNull();
  });

  it("非法 cache 值 → null", () => {
    expect(parsePolishMeta(h({ "X-Ppt-Polish-Cache": "weird", "X-Ppt-Polish-Status": "complete" }))).toBeNull();
  });

  it("coverage 格式坏 → meta 存在但 coverage=null（不挡 UI 显示状态）", () => {
    const m = parsePolishMeta(
      h({
        "X-Ppt-Polish-Cache": "hit",
        "X-Ppt-Polish-Status": "complete",
        "X-Ppt-Polish-Coverage": "garbage",
        "X-Ppt-Polish-Cost-Usd": "0",
      }),
    );
    expect(m!.coverage).toBeNull();
    expect(m!.cache).toBe("hit");
  });

  it("cost-usd 非数字 → 0", () => {
    const m = parsePolishMeta(
      h({
        "X-Ppt-Polish-Cache": "hit",
        "X-Ppt-Polish-Status": "complete",
        "X-Ppt-Polish-Coverage": "1/1 exec=y",
        "X-Ppt-Polish-Cost-Usd": "abc",
      }),
    );
    expect(m!.costUsd).toBe(0);
  });
});

describe("describePolishMeta", () => {
  it("null → null", () => {
    expect(describePolishMeta(null)).toBeNull();
  });

  it("hit + complete + cost=0 → 缓存命中文案 + 不显示成本", () => {
    expect(
      describePolishMeta({
        cache: "hit",
        status: "complete",
        coverage: { perInsightDone: 13, perInsightTotal: 13, hasExecutive: true },
        costUsd: 0,
      }),
    ).toBe("缓存命中 · 13/13 重点 · 含 Executive 页");
  });

  it("miss + partial + 真实成本 → 跑了 LLM + 显示成本", () => {
    expect(
      describePolishMeta({
        cache: "miss",
        status: "partial",
        coverage: { perInsightDone: 9, perInsightTotal: 13, hasExecutive: false },
        costUsd: 0.172,
      }),
    ).toBe("本次跑了 LLM · 9/13 重点 · 无 Executive 页 · 本次 $0.1720");
  });

  it("coverage=null → 省略覆盖度段", () => {
    expect(
      describePolishMeta({ cache: "hit", status: "complete", coverage: null, costUsd: 0 }),
    ).toBe("缓存命中 · ");
  });
});

describe("shouldOfferRefresh", () => {
  it("complete → 不显示 refresh（已最优，省钱）", () => {
    expect(
      shouldOfferRefresh({
        cache: "hit",
        status: "complete",
        coverage: null,
        costUsd: 0,
      }),
    ).toBe(false);
  });
  it("partial → 显示 refresh（补漏）", () => {
    expect(
      shouldOfferRefresh({
        cache: "miss",
        status: "partial",
        coverage: null,
        costUsd: 0,
      }),
    ).toBe(true);
  });
  it("no-executive → 显示 refresh（补 executive）", () => {
    expect(
      shouldOfferRefresh({
        cache: "hit",
        status: "no-executive",
        coverage: null,
        costUsd: 0,
      }),
    ).toBe(true);
  });
  it("null（A 路径）→ 不显示", () => {
    expect(shouldOfferRefresh(null)).toBe(false);
  });
});
