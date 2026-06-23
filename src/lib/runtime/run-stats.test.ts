import { describe, expect, it } from "vitest";
import type { Run, Source } from "../types.js";
import { aggregateByKind, aggregateDailyCost, aggregateSourceHealth, evaluateCircuit, evaluateZeroYield, groupRunsIntoRounds } from "./run-stats.js";

function run(p: Partial<Run> & Pick<Run, "kind" | "status">): Run {
  return {
    id: "x", target: {}, started_at: "t",
    ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null,
    ...p,
  };
}

function src(id: string, p: Partial<Source> = {}): Source {
  return {
    id, name: id, type: "rss", endpoint: "e", topic_ids: [],
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

describe("groupRunsIntoRounds", () => {
  it("按时间间隔聚成轮次：扎堆同轮、超 gap 新轮；计数/失败/成本", () => {
    const runs: Run[] = [
      // 第二轮（较新）：03:00 附近扎堆
      run({ kind: "report-gen", status: "done", started_at: "2026-06-19T03:05:00Z", cost: { tokens: 0, amount: 0 } }),
      run({ kind: "validate", status: "failed", started_at: "2026-06-19T03:00:00Z", cost: { tokens: 10, amount: 0.2 } }),
      run({ kind: "analyze", status: "done", started_at: "2026-06-19T02:50:00Z", cost: { tokens: 100, amount: 0.5 } }),
      // 第一轮（较旧）：前一天，间隔 > 2h
      run({ kind: "ingest", status: "done", started_at: "2026-06-18T17:00:00Z" }),
      run({ kind: "ingest", status: "done", started_at: "2026-06-18T17:01:00Z" }),
    ];
    const rounds = groupRunsIntoRounds(runs);
    expect(rounds).toHaveLength(2);
    // 第一轮 = 较新那簇
    expect(rounds[0].counts).toMatchObject({ analyze: 1, validate: 1, "report-gen": 1, ingest: 0 });
    expect(rounds[0].failed).toBe(1);
    expect(rounds[0].costUSD).toBeCloseTo(0.7);
    expect(rounds[0].start).toBe("2026-06-19T02:50:00Z"); // 本轮最早
    expect(rounds[0].end).toBe("2026-06-19T03:05:00Z");   // 本轮最晚
    // 第二轮 = 前一天两条 ingest
    expect(rounds[1].counts.ingest).toBe(2);
    expect(rounds[1].failed).toBe(0);
  });

  it("自定义 gap：极小 gap → 每条自成一轮", () => {
    const runs: Run[] = [
      run({ kind: "analyze", status: "done", started_at: "2026-06-19T03:00:00Z" }),
      run({ kind: "analyze", status: "done", started_at: "2026-06-19T02:59:00Z" }),
    ];
    expect(groupRunsIntoRounds(runs, 1000)).toHaveLength(2); // 60s 间隔 > 1s gap
  });

  it("空输入 → 空数组", () => {
    expect(groupRunsIntoRounds([])).toEqual([]);
  });
});

describe("evaluateCircuit（源熔断判定 · 切片3b）", () => {
  const CFG = { fails: 5, days: 3 };
  const NOW = Date.parse("2026-06-21T00:00:00Z");
  const DAY = 86_400_000;
  // n 条 failed ingest run，最新在 startMsAgo 天前往回（每条隔 1 小时）
  const fails = (sid: string, n: number, newestDaysAgo: number): Run[] =>
    Array.from({ length: n }, (_, i) =>
      run({ kind: "ingest", status: "failed", target: { source_id: sid }, started_at: new Date(NOW - newestDaysAgo * DAY - i * 3_600_000).toISOString(), error: { type: "net", message: "boom" } }),
    );
  const ok = (sid: string, daysAgo: number): Run =>
    run({ kind: "ingest", status: "done", target: { source_id: sid }, started_at: new Date(NOW - daysAgo * DAY).toISOString() });

  it("连失不足阈值 → 不熔断", () => {
    const ev = evaluateCircuit(fails("s", 4, 0), src("s"), NOW, CFG);
    expect(ev.open).toBe(false);
    expect(ev.consecutiveFails).toBe(4);
  });

  it("连失够 但最近成功在 days 内 → 不熔断（时间条件未满）", () => {
    const runs = [...fails("s", 6, 0), ok("s", 1)]; // 6 连失 + 1 天前成功
    expect(evaluateCircuit(runs, src("s"), NOW, CFG).open).toBe(false);
  });

  it("连失够 且 距最近成功 > days 天 → 熔断", () => {
    const runs = [...fails("s", 6, 0), ok("s", 5)]; // 6 连失 + 最近成功 5 天前
    const ev = evaluateCircuit(runs, src("s"), NOW, CFG);
    expect(ev.open).toBe(true);
    expect(ev.consecutiveFails).toBe(6);
    expect(ev.lastErrorMsg).toBe("boom");
  });

  it("circuit_reset_at 锚定：reset 之前的旧失败不计 → 不熔断（防复活后反扑）", () => {
    // 10 条旧失败（都在 reset 之前 10 天），reset 设在昨天 → 锚定后无失败可数
    const old = fails("s", 10, 10);
    const source = src("s", { circuit_reset_at: new Date(NOW - 1 * DAY).toISOString() });
    expect(evaluateCircuit(old, source, NOW, CFG).consecutiveFails).toBe(0);
    expect(evaluateCircuit(old, source, NOW, CFG).open).toBe(false);
  });

  it("已熔断（disabled_reason=circuit_open）→ 不重复熔断", () => {
    const runs = [...fails("s", 8, 0), ok("s", 9)];
    expect(evaluateCircuit(runs, src("s", { enabled: false, disabled_reason: "circuit_open" }), NOW, CFG).open).toBe(false);
  });

  it("人工停用（enabled=false, reason=null）→ 不熔断", () => {
    const runs = [...fails("s", 8, 0), ok("s", 9)];
    expect(evaluateCircuit(runs, src("s", { enabled: false }), NOW, CFG).open).toBe(false);
  });

  it("排除半开探测 run（target.probe）", () => {
    const probeRuns = Array.from({ length: 8 }, (_, i) =>
      run({ kind: "ingest", status: "failed", target: { source_id: "s", probe: true } as Run["target"], started_at: new Date(NOW - i * 3_600_000).toISOString() }),
    );
    expect(evaluateCircuit(probeRuns, src("s"), NOW, CFG).consecutiveFails).toBe(0); // probe 不计
  });

  it("从未成功 + 连失够 + 距最早失败 > days → 熔断", () => {
    const runs = fails("s", 6, 4); // 全失败，最新在 4 天前（最早更早）
    expect(evaluateCircuit(runs, src("s"), NOW, CFG).open).toBe(true);
  });
});

describe("evaluateZeroYield（零产出看门狗 · 切片3b-3）", () => {
  // 倒序：传入数组按 started_at 排，这里直接给 ISO 控制顺序
  const ig = (n: number, status: Run["status"], inserted: number | null, probe = false): Run =>
    run({ kind: "ingest", status, started_at: new Date(Date.parse("2026-06-21T00:00:00Z") - n * 3_600_000).toISOString(), inserted, target: { source_id: "s", ...(probe ? { probe: true } : {}) } });

  it("有基线 + 恰好连续 N 次 done且inserted=0 → 报警一次（边沿）", () => {
    const runs = [ig(0, "done", 0), ig(1, "done", 0), ig(2, "done", 0), ig(3, "done", 5)]; // 3 连零 + 基线
    const ev = evaluateZeroYield(runs, 3);
    expect(ev).toMatchObject({ consecutiveZero: 3, hasBaseline: true, alert: true });
  });

  it("连续零 > N（已过阈值）→ 不再报（只在 ==N 那刻报）", () => {
    const runs = [ig(0, "done", 0), ig(1, "done", 0), ig(2, "done", 0), ig(3, "done", 0), ig(4, "done", 9)];
    expect(evaluateZeroYield(runs, 3).alert).toBe(false); // 4 > 3
  });

  it("无基线（从未产出，如生来稀疏源）→ 不报（降假阳）", () => {
    const runs = [ig(0, "done", 0), ig(1, "done", 0), ig(2, "done", 0)];
    expect(evaluateZeroYield(runs, 3)).toMatchObject({ consecutiveZero: 3, hasBaseline: false, alert: false });
  });

  it("inserted=null（旧 run/未知）打断连零计数", () => {
    const runs = [ig(0, "done", 0), ig(1, "done", null), ig(2, "done", 5)];
    expect(evaluateZeroYield(runs, 3).consecutiveZero).toBe(1);
  });

  it("最近有产出（inserted>0）→ 连零 0", () => {
    expect(evaluateZeroYield([ig(0, "done", 3), ig(1, "done", 0)], 3).consecutiveZero).toBe(0);
  });

  it("失败 run 打断连零（失败归熔断管，非零产出）", () => {
    const runs = [ig(0, "done", 0), ig(1, "failed", null), ig(2, "done", 0), ig(3, "done", 5)];
    expect(evaluateZeroYield(runs, 3).consecutiveZero).toBe(1);
  });

  it("排除 probe run", () => {
    const runs = [ig(0, "done", 0, true), ig(1, "done", 0), ig(2, "done", 0), ig(3, "done", 0), ig(4, "done", 5)];
    expect(evaluateZeroYield(runs, 3)).toMatchObject({ consecutiveZero: 3, alert: true }); // probe 不计，真零 3
  });

  it("未到阈值（<N）→ 不报", () => {
    const runs = [ig(0, "done", 0), ig(1, "done", 0), ig(2, "done", 5)]; // 2 连零 + 基线，rounds=3
    expect(evaluateZeroYield(runs, 3)).toMatchObject({ consecutiveZero: 2, hasBaseline: true, alert: false });
  });

  it("inserted=0 即算零产出（updated 不计，inserted 是新增数）", () => {
    // 即便源在更新旧条目（updated>0），只要 inserted=0 仍算零产出——「无新内容」是要暴露的信号
    const runs = [ig(0, "done", 0), ig(1, "done", 0), ig(2, "done", 0), ig(3, "done", 7)];
    expect(evaluateZeroYield(runs, 3).alert).toBe(true);
  });
});
