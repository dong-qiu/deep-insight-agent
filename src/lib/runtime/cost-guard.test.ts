/** 成本预算守卫单测 —— 纯判定（evaluateBudget / loadBudgetLimits）+ 查库判定（getBudgetStatus）。
 *  无 API key，CI 可跑。getBudgetStatus 用内存库 + 受控 started_at/cost + 注入 nowIso 覆盖日/月窗。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Run } from "../types.js";
import { type DB, openDb } from "../db/index.js";
import { insertRun } from "../db/repos.js";
import { evaluateBudget, getBudgetStatus, loadBudgetLimits } from "./cost-guard.js";

describe("loadBudgetLimits", () => {
  it("读取正数 env；alertPct 默认 80", () => {
    expect(loadBudgetLimits({ COST_LIMIT_DAILY: "10", COST_LIMIT_MONTHLY: "200" })).toEqual({
      daily: 10,
      monthly: 200,
      alertPct: 80,
    });
  });

  it("缺失 / NaN / ≤0 → undefined（该维度不限）", () => {
    expect(loadBudgetLimits({})).toEqual({ daily: undefined, monthly: undefined, alertPct: 80 });
    expect(loadBudgetLimits({ COST_LIMIT_DAILY: "abc", COST_LIMIT_MONTHLY: "0" }).daily).toBeUndefined();
    expect(loadBudgetLimits({ COST_LIMIT_DAILY: "-5" }).daily).toBeUndefined();
  });

  it("alertPct 落 (0,100]，脏值回落 80", () => {
    expect(loadBudgetLimits({ COST_ALERT_PCT: "90" }).alertPct).toBe(90);
    expect(loadBudgetLimits({ COST_ALERT_PCT: "0" }).alertPct).toBe(80);
    expect(loadBudgetLimits({ COST_ALERT_PCT: "150" }).alertPct).toBe(80);
    expect(loadBudgetLimits({ COST_ALERT_PCT: "x" }).alertPct).toBe(80);
  });
});

describe("evaluateBudget", () => {
  const limits = { daily: 10, monthly: 100, alertPct: 80 };

  it("无任何限额 → 恒 ok（零回归）", () => {
    const s = evaluateBudget({ today: 999, month: 9999 }, { alertPct: 80 });
    expect(s.verdict).toBe("ok");
    expect(s.reason).toBeUndefined();
    expect(s.dailyRatio).toBeUndefined();
  });

  it("远低于阈值 → ok", () => {
    expect(evaluateBudget({ today: 1, month: 1 }, limits).verdict).toBe("ok");
  });

  it("日 ≥alertPct 但未触顶 → alert", () => {
    const s = evaluateBudget({ today: 8, month: 1 }, limits); // 8/10 = 80%
    expect(s.verdict).toBe("alert");
    expect(s.reason).toContain("日预算已用 80%");
  });

  it("日触顶 → exceeded", () => {
    const s = evaluateBudget({ today: 10, month: 1 }, limits);
    expect(s.verdict).toBe("exceeded");
    expect(s.reason).toContain("日预算已触顶");
  });

  it("月触顶 → exceeded（即便日维度 ok）", () => {
    const s = evaluateBudget({ today: 1, month: 100 }, limits);
    expect(s.verdict).toBe("exceeded");
    expect(s.reason).toContain("月预算已触顶");
  });

  it("exceeded 优先级高于 alert（一维触顶一维告警 → exceeded，两条原因都给）", () => {
    const s = evaluateBudget({ today: 10, month: 85 }, limits); // 日触顶 + 月 85%
    expect(s.verdict).toBe("exceeded");
    expect(s.reason).toContain("日预算已触顶");
    expect(s.reason).toContain("月预算已用 85%");
  });

  it("ratio 计算正确，alertPct 透传", () => {
    const s = evaluateBudget({ today: 5, month: 50 }, limits);
    expect(s.dailyRatio).toBeCloseTo(0.5);
    expect(s.monthlyRatio).toBeCloseTo(0.5);
    expect(s.alertPct).toBe(80);
  });
});

describe("getBudgetStatus（查库 + 日/月窗）", () => {
  let db: DB;
  const NOW = "2026-06-13T12:00:00.000Z";
  const saved = { ...process.env };

  const run = (id: string, startedAt: string, amount: number | null): Run => ({
    id, kind: "analyze", target: { topic_id: "t1" }, status: "done",
    started_at: startedAt, ended_at: startedAt, duration_ms: 100,
    cost: amount == null ? null : { tokens: 1000, amount }, error: null, retry_of: null,
  });

  beforeEach(() => {
    db = openDb(":memory:");
    insertRun(db, run("today1", "2026-06-13T08:00:00.000Z", 5)); // 今日 + 本月
    insertRun(db, run("month1", "2026-06-05T08:00:00.000Z", 10)); // 本月、非今日
    insertRun(db, run("lastm", "2026-05-20T08:00:00.000Z", 100)); // 上月，两窗都排除
    insertRun(db, run("nocost", "2026-06-13T09:00:00.000Z", null)); // 无成本（确定性段）→ 计 0
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("日窗 = 当日 UTC、月窗 = 当月 UTC：spentToday=5、spentMonth=15", () => {
    process.env.COST_LIMIT_DAILY = "";
    process.env.COST_LIMIT_MONTHLY = "";
    const s = getBudgetStatus(db, { nowIso: NOW });
    expect(s.spentToday).toBeCloseTo(5);
    expect(s.spentMonth).toBeCloseTo(15);
    expect(s.verdict).toBe("ok"); // 未配限额
  });

  it("日上限 5 → exceeded（今日实花 5）", () => {
    process.env.COST_LIMIT_DAILY = "5";
    delete process.env.COST_LIMIT_MONTHLY;
    expect(getBudgetStatus(db, { nowIso: NOW }).verdict).toBe("exceeded");
  });

  it("月上限 18 + alertPct 80 → alert（15/18 ≈ 83%）", () => {
    delete process.env.COST_LIMIT_DAILY;
    process.env.COST_LIMIT_MONTHLY = "18";
    process.env.COST_ALERT_PCT = "80";
    expect(getBudgetStatus(db, { nowIso: NOW }).verdict).toBe("alert");
  });
});
