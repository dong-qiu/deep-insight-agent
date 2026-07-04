/** reportPlan 纯函数单测（冷启动 → 首版综述决策）。
 *  （rankAndDiversify 选片单测随其迁往 analysis-selection.test.ts；源健康接线见 scheduler.source-health.test.ts。） */
import { describe, expect, it } from "vitest";
import { reportPlan } from "./scheduler.js";

describe("reportPlan（冷启动 → 首版综述）", () => {
  const warm = { type: "brief" as const, windowHours: 168, items: 15 };
  const cold = { windowHours: 720, items: 25 };

  it("topic 无历史报告 → initial_digest + 宽窗 + 多条", () => {
    expect(reportPlan(true, warm, cold)).toEqual({ type: "initial_digest", windowHours: 720, items: 25 });
  });

  it("topic 已有报告 → 沿用常规 reportType 与窗口/条数", () => {
    expect(reportPlan(false, warm, cold)).toEqual({ type: "brief", windowHours: 168, items: 15 });
    expect(reportPlan(false, { type: "deep_dive", windowHours: 168, items: 20 }, cold))
      .toEqual({ type: "deep_dive", windowHours: 168, items: 20 });
  });
});
