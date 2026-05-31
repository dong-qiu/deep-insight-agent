import { describe, expect, it } from "vitest";
import type { Run } from "../types.js";
import { aggregateByKind } from "./run-stats.js";

function run(p: Partial<Run> & Pick<Run, "kind" | "status">): Run {
  return {
    id: "x", target: {}, started_at: "t",
    ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null,
    ...p,
  };
}

describe("aggregateByKind", () => {
  it("按 kind 汇总 total/done/failed/running + 成本 + 平均耗时", () => {
    const runs: Run[] = [
      run({ kind: "ingest",  status: "done",   duration_ms: 100 }),
      run({ kind: "ingest",  status: "done",   duration_ms: 200 }),
      run({ kind: "ingest",  status: "failed", duration_ms: 50  }),
      run({ kind: "analyze", status: "done",   duration_ms: 5000, cost: { tokens: 100, amount: 0.5 } }),
      run({ kind: "analyze", status: "failed", duration_ms: 1000, cost: { tokens: 10,  amount: 0.05 } }),
    ];
    const stats = aggregateByKind(runs);
    expect(stats.find((s) => s.kind === "ingest")).toMatchObject({
      total: 3, done: 2, failed: 1, running: 0, costUSD: 0,
      avgDurationMs: Math.round((100 + 200 + 50) / 3), // 117
    });
    expect(stats.find((s) => s.kind === "analyze")).toMatchObject({
      total: 2, done: 1, failed: 1,
      costUSD: 0.55, avgDurationMs: 3000,
    });
  });

  it("固定 kind 顺序（管线流水方向，便于看板扫读）", () => {
    const runs: Run[] = [
      run({ kind: "report-gen", status: "done" }),
      run({ kind: "validate",   status: "done" }),
      run({ kind: "analyze",    status: "done" }),
      run({ kind: "ingest",     status: "done" }),
    ];
    expect(aggregateByKind(runs).map((s) => s.kind)).toEqual(["ingest", "analyze", "validate", "report-gen"]);
  });

  it("running 状态不参与 duration 均值（duration_ms=null 跳过）", () => {
    const runs: Run[] = [
      run({ kind: "validate", status: "done",    duration_ms: 1000 }),
      run({ kind: "validate", status: "running", duration_ms: null }),
    ];
    expect(aggregateByKind(runs)[0]).toMatchObject({
      kind: "validate", total: 2, done: 1, running: 1, avgDurationMs: 1000,
    });
  });

  it("空输入 → 空数组（不抛）", () => {
    expect(aggregateByKind([])).toEqual([]);
  });
});
