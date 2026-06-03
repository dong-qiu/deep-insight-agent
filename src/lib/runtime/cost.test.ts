/**
 * 计价纯函数单测 —— 无需 API key，CI 可跑（npm test）。
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_PRICING, PRICING, costUSD } from "./cost.js";

describe("costUSD", () => {
  it("Sonnet 4.6：输入/输出按 $3 / $15 每 1M", () => {
    expect(costUSD("claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(3);
    expect(costUSD("claude-sonnet-4-6", { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(15);
  });

  it("Opus 4.7：输入/输出按 $5 / $25 每 1M", () => {
    expect(costUSD("claude-opus-4-7", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(5);
    expect(costUSD("claude-opus-4-7", { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(25);
  });

  it("缓存读 = 0.1× 输入价、缓存写 = 1.25× 输入价（Opus 4.7）", () => {
    expect(
      costUSD("claude-opus-4-7", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }),
    ).toBeCloseTo(0.5);
    expect(
      costUSD("claude-opus-4-7", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }),
    ).toBeCloseTo(6.25);
  });

  it("组合计费", () => {
    // 100k in + 20k out @ Sonnet = 0.1*3 + 0.02*15 = 0.3 + 0.3 = 0.6
    expect(costUSD("claude-sonnet-4-6", { input_tokens: 100_000, output_tokens: 20_000 })).toBeCloseTo(0.6);
  });

  it("未知模型 → null（无法计价）", () => {
    expect(costUSD("gpt-4", { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });

  it("Opus 4.8（2026-06-03 补入表）：与 4.7 同档 \$5 / \$25", () => {
    expect(costUSD("claude-opus-4-8", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(5);
    expect(costUSD("claude-opus-4-8", { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(25);
  });

  it("FALLBACK_PRICING = 表内最贵价（Opus tier 上限：input \$5 / output \$25）", () => {
    expect(FALLBACK_PRICING.input).toBe(Math.max(...Object.values(PRICING).map((p) => p.input)));
    expect(FALLBACK_PRICING.output).toBe(Math.max(...Object.values(PRICING).map((p) => p.output)));
    expect(FALLBACK_PRICING.input).toBe(5);
    expect(FALLBACK_PRICING.output).toBe(25);
  });
});
