import { describe, expect, it } from "vitest";
import type { Run, Source } from "../types.js";
import { aggregateByKind, aggregateDailyCost, aggregateSourceHealth } from "./run-stats.js";

function run(p: Partial<Run> & Pick<Run, "kind" | "status">): Run {
  return {
    id: "x", target: {}, started_at: "t",
    ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null,
    ...p,
  };
}

function src(id: string, p: Partial<Source> = {}): Source {
  return {
    id, name: id, type: "rss", endpoint: "e", industry: "ai-swe", topic_ids: [],
    fetch_interval: "6h", backfill: null, enabled: true, ...p,
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

describe("aggregateDailyCost", () => {
  function r(started_at: string, amount: number): Run {
    return run({ kind: "analyze", status: "done", started_at, cost: { tokens: 100, amount } });
  }

  it("缺失日补 0 + X 轴连续", () => {
    const out = aggregateDailyCost(
      [r("2026-06-04T08:00:00Z", 0.1), r("2026-06-06T08:00:00Z", 0.2)],
      { days: 5, todayIso: "2026-06-06T12:00:00Z" },
    );
    expect(out).toHaveLength(5);
    expect(out.map((x) => x.date)).toEqual([
      "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06",
    ]);
    expect(out.map((x) => x.costUSD)).toEqual([0, 0, 0.1, 0, 0.2]);
  });

  it("同日多 Run 累加 cost + runCount", () => {
    const out = aggregateDailyCost(
      [r("2026-06-06T01:00:00Z", 0.05), r("2026-06-06T15:00:00Z", 0.07)],
      { days: 2, todayIso: "2026-06-06T18:00:00Z" },
    );
    expect(out[1]).toMatchObject({ date: "2026-06-06", runCount: 2 });
    expect(out[1].costUSD).toBeCloseTo(0.12);
  });

  it("超出窗口的 Run 不计", () => {
    const out = aggregateDailyCost(
      [r("2025-01-01T00:00:00Z", 999)],
      { days: 7, todayIso: "2026-06-06T00:00:00Z" },
    );
    expect(out.every((x) => x.costUSD === 0)).toBe(true);
  });

  it("空输入 → N 个 0 cost 槽（仍连续）", () => {
    const out = aggregateDailyCost([], { days: 3, todayIso: "2026-06-06T00:00:00Z" });
    expect(out).toHaveLength(3);
    expect(out.every((x) => x.costUSD === 0 && x.runCount === 0)).toBe(true);
  });

  it("无 cost 字段（ingest/report-gen 等确定性任务）→ amount=0 不计", () => {
    const out = aggregateDailyCost(
      [run({ kind: "ingest", status: "done", started_at: "2026-06-06T00:00:00Z", cost: null })],
      { days: 1, todayIso: "2026-06-06T00:00:00Z" },
    );
    expect(out[0]).toMatchObject({ costUSD: 0, runCount: 1 });
  });
});

describe("aggregateSourceHealth", () => {
  const ig = (sid: string, status: Run["status"], p: Partial<Run> = {}) =>
    run({ kind: "ingest", status, target: { source_id: sid }, ...p });

  it("每源成功率 / 最近成功 / 连续失败 / 近期错误", () => {
    const runs: Run[] = [
      ig("s1", "failed", { started_at: "2026-06-19T03:00:00Z", ended_at: "2026-06-19T03:00:01Z", error: { type: "FetchError", message: "fetch failed" } }),
      ig("s1", "failed", { started_at: "2026-06-19T02:00:00Z", ended_at: "2026-06-19T02:00:01Z", error: { type: "FetchError", message: "fetch failed" } }),
      ig("s1", "done",   { started_at: "2026-06-19T01:00:00Z", ended_at: "2026-06-19T01:00:02Z" }),
    ];
    const [h] = aggregateSourceHealth(runs, [src("s1")]);
    expect(h).toMatchObject({ source_id: "s1", total: 3, ok: 1, failed: 2, consecutiveFails: 2 });
    expect(h.successRate).toBeCloseTo(1 / 3);
    expect(h.lastSuccessAt).toBe("2026-06-19T01:00:02Z");
    expect(h.lastError).toMatchObject({ type: "FetchError", message: "fetch failed" });
  });

  it("无 ingest run 的源 → total 0 / lastSuccess null（从未采集）", () => {
    const [h] = aggregateSourceHealth([], [src("s_new")]);
    expect(h).toMatchObject({ total: 0, ok: 0, failed: 0, successRate: 0, lastSuccessAt: null, consecutiveFails: 0 });
  });

  it("最近一次成功后无失败 → consecutiveFails 0", () => {
    const runs = [
      run({ kind: "ingest", status: "done", target: { source_id: "s1" }, started_at: "2026-06-19T02:00:00Z" }),
      run({ kind: "ingest", status: "failed", target: { source_id: "s1" }, started_at: "2026-06-19T01:00:00Z" }),
    ];
    expect(aggregateSourceHealth(runs, [src("s1")])[0].consecutiveFails).toBe(0); // 最近是 done
  });

  it("run 引用了已删除的源 → 仍列出为未知源（enabled=false, type=null）", () => {
    const runs = [run({ kind: "ingest", status: "failed", target: { source_id: "gone" }, started_at: "t" })];
    const rows = aggregateSourceHealth(runs, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_id: "gone", name: "gone", type: null, enabled: false });
  });

  it("排序：连续失败多的在前，再按成功率升序", () => {
    const runs = [
      ig("healthy", "done", { started_at: "t1" }),
      ig("failing", "failed", { started_at: "t3" }), ig("failing", "failed", { started_at: "t2" }), ig("failing", "failed", { started_at: "t1" }),
    ];
    const rows = aggregateSourceHealth(runs, [src("healthy"), src("failing")]);
    expect(rows.map((r) => r.source_id)).toEqual(["failing", "healthy"]); // failing(3连失)在前
  });
});
