import { describe, expect, it } from "vitest";
import { emptyJudgeStats, judgeAccuracy, judgeCompletion, judgeNegativeRecall, recordJudgeAttempt } from "./a1-judge-metrics.js";

describe("A1 judge 端到端计分", () => {
  it("将重试耗尽后的失败计入准确率和 not_support 召回率分母", () => {
    const stats = emptyJudgeStats();
    recordJudgeAttempt(stats, "support", "support");
    recordJudgeAttempt(stats, "not_support", null);
    recordJudgeAttempt(stats, "uncertain", null);

    expect(stats).toMatchObject({ attempted: 3, judged: 1, correct: 1, errors: 2, negTotal: 1, negRecalled: 0 });
    expect(judgeAccuracy(stats)).toBeCloseTo(1 / 3);
    expect(judgeNegativeRecall(stats)).toBe(0);
    expect(judgeCompletion(stats)).toBeCloseTo(1 / 3);
  });

  it("已完成的正确 not_support 才计入负例召回", () => {
    const stats = emptyJudgeStats();
    recordJudgeAttempt(stats, "not_support", "not_support");
    recordJudgeAttempt(stats, "not_support", "uncertain");

    expect(judgeNegativeRecall(stats)).toBe(0.5);
  });
});
