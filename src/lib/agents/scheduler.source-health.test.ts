/** runScheduledPipeline 源健康自愈（1b 熔断 / 1c 半开探测 / 1d 零产出）+ 采集阶段的**特征化测试**。
 *  这三段当前内联在 runScheduledPipeline、零直接测试；本文件在拆分前先锁住可观测行为
 *  （summary.circuitOpened/circuitRevived/zeroYield/collected/errors + setCircuit/reviveSource/告警副作用），
 *  作为 scheduler 拆分（抽 source-health.ts）的回归网。纯决策逻辑另见 run-stats.test.ts。
 *
 *  隔离手法：只 mock collector（采集/探测）、config（源清单）、alert（告警）；保留**真 DB 落库 + 真评估器**。
 *  不插入任何 topic → per-topic 循环为空，聚焦源健康三段。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DB, openDb } from "../db/index.js";
import { getSource, insertRun, insertSource, setCircuit, setRunInserted } from "../db/repos.js";
import type { Run, Source } from "../types.js";

const { collectSourceMock, notifyCircuitMock, notifyRevivedMock, notifyZeroYieldMock } = vi.hoisted(() => ({
  collectSourceMock: vi.fn(),
  notifyCircuitMock: vi.fn(),
  notifyRevivedMock: vi.fn(),
  notifyZeroYieldMock: vi.fn(),
}));
vi.mock("./collector.js", async (orig) => ({
  ...(await orig<typeof import("./collector.js")>()),
  collectSource: collectSourceMock,
}));
vi.mock("../config/index.js", async (orig) => ({
  ...(await orig<typeof import("../config/index.js")>()),
  getEffectiveSources: vi.fn(() => sources),
  loadStaticConfig: vi.fn(() => ({})),
}));
vi.mock("../runtime/alert.js", async (orig) => ({
  ...(await orig<typeof import("../runtime/alert.js")>()),
  notifySourceCircuit: notifyCircuitMock,
  notifySourceRevived: notifyRevivedMock,
  notifySourceZeroYield: notifyZeroYieldMock,
  notifyBudget: vi.fn(),
}));

import { runScheduledPipeline } from "./scheduler.js";

let db: DB;
let sources: Source[]; // getEffectiveSources mock 读它（闭包）

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function src(id: string, p: Partial<Source> = {}): Source {
  return { id, name: id, type: "rss", endpoint: "e", topic_ids: [], fetch_interval: "6h", backfill: null, enabled: true, ...p };
}
/** 落一条 ingest run（真库）。inserted 走 setRunInserted 回填——insertRun 建 run 时 inserted 恒 null，
 *  与生产一致（collector 完事后才 setRunInserted）。 */
function seedRun(sid: string, i: number, status: Run["status"], p: { at: string; inserted?: number }): void {
  const id = `run-${sid}-${i}`;
  const run: Run = {
    id, kind: "ingest", target: { source_id: sid }, status,
    started_at: p.at, ended_at: null, duration_ms: null, cost: null,
    error: status === "failed" ? { type: "net", message: "boom" } : null,
    retry_of: null, inserted: null,
  };
  insertRun(db, run);
  if (p.inserted != null) setRunInserted(db, id, p.inserted);
}
/** 造一个系统熔断态源（真 setCircuit：enabled=0 + disabled_reason=circuit_open + circuit_reset_at）。 */
function seedCircuitOpen(id: string): void {
  insertSource(db, src(id));
  setCircuit(db, id);
}

beforeEach(() => {
  db = openDb(":memory:");
  sources = [];
  collectSourceMock.mockReset().mockResolvedValue({ fetched: 0, inserted: 0, updated: 0 });
  notifyCircuitMock.mockReset();
  notifyRevivedMock.mockReset();
  notifyZeroYieldMock.mockReset();
  // 钉住阈值，隔离 env 漂移
  process.env.SOURCE_CIRCUIT_FAILS = "5";
  process.env.SOURCE_CIRCUIT_DAYS = "3";
  process.env.SOURCE_ZERO_YIELD_ROUNDS = "5";
  process.env.SOURCE_PROBE_MAX_PER_RUN = "5";
});
afterEach(() => {
  for (const k of ["SOURCE_CIRCUIT_FAILS", "SOURCE_CIRCUIT_DAYS", "SOURCE_ZERO_YIELD_ROUNDS", "SOURCE_PROBE_MAX_PER_RUN"]) {
    delete process.env[k];
  }
});

describe("1b 熔断判定接线", () => {
  it("连失够阈值 + 最近成功超期 → 熔断该源、独立字段记账、告警一次", async () => {
    const s = src("s_fail");
    insertSource(db, s);
    sources = [s];
    // 6 连失（近 6 小时）+ 1 次成功在 5 天前（> days=3）→ evaluateCircuit.open
    for (let i = 0; i < 6; i++) seedRun("s_fail", i, "failed", { at: ago(i * HOUR) });
    seedRun("s_fail", 99, "done", { at: ago(5 * DAY), inserted: 1 });
    // 本轮熔断后，同轮 1c 半开会立刻探它（新熔断源 last_probe_at=null 即候选）——真下线源探测也失败，
    // 故让 probe 抛错，s_fail 维持熔断（否则默认 mock resolve 会当场把它复活，掩盖熔断断言）。
    collectSourceMock.mockImplementation(async (_db: unknown, _s: unknown, opts?: { probe?: boolean }) => {
      if (opts?.probe) throw new Error("still failing");
      return { fetched: 0, inserted: 0, updated: 0 };
    });

    const summary = await runScheduledPipeline(db);

    expect(summary.circuitOpened).toEqual(["s_fail"]);
    expect(getSource(db, "s_fail")?.enabled).toBe(false); // setCircuit 真落库（停采）
    expect(getSource(db, "s_fail")?.disabled_reason).toBe("circuit_open");
    expect(notifyCircuitMock).toHaveBeenCalledTimes(1);
    expect(notifyCircuitMock.mock.calls[0][0]).toMatchObject({ sourceId: "s_fail", consecutiveFails: 6 });
    expect(summary.errors).toEqual([]); // 熔断是正常处置，不污染 errors
  });

  it("连失不足阈值 → 不熔断、不告警", async () => {
    const s = src("s_ok");
    insertSource(db, s);
    sources = [s];
    for (let i = 0; i < 3; i++) seedRun("s_ok", i, "failed", { at: ago(i * HOUR) }); // 3 < 5

    const summary = await runScheduledPipeline(db);

    expect(summary.circuitOpened).toBeUndefined();
    expect(getSource(db, "s_ok")?.enabled).toBe(true);
    expect(notifyCircuitMock).not.toHaveBeenCalled();
  });
});

describe("1d 零产出看门狗接线", () => {
  it("有基线 + 恰好连续 N 次 done 且 0 入库 → 边沿告警一次、独立字段记账", async () => {
    const s = src("s_zero");
    insertSource(db, s);
    sources = [s];
    // 基线（更早的一次有产出）+ 最近 5 次 done 但 inserted=0（rounds=5，边沿）
    seedRun("s_zero", 99, "done", { at: ago(6 * HOUR), inserted: 7 });
    for (let i = 0; i < 5; i++) seedRun("s_zero", i, "done", { at: ago(i * HOUR), inserted: 0 });

    const summary = await runScheduledPipeline(db);

    expect(summary.zeroYield).toEqual(["s_zero"]);
    expect(notifyZeroYieldMock).toHaveBeenCalledTimes(1);
    expect(notifyZeroYieldMock.mock.calls[0][0]).toMatchObject({ sourceId: "s_zero", consecutiveZero: 5 });
    expect(summary.circuitOpened).toBeUndefined(); // 全 done、无连失 → 不熔断
  });

  it("无基线（生来稀疏、从未产出）→ 不报（降假阳）", async () => {
    const s = src("s_sparse");
    insertSource(db, s);
    sources = [s];
    for (let i = 0; i < 5; i++) seedRun("s_sparse", i, "done", { at: ago(i * HOUR), inserted: 0 });

    const summary = await runScheduledPipeline(db);

    expect(summary.zeroYield).toBeUndefined();
    expect(notifyZeroYieldMock).not.toHaveBeenCalled();
  });
});

describe("1c 半开探测复活接线", () => {
  it("熔断源探测成功 → 复活、清熔断态、告警一次、独立字段记账", async () => {
    // 熔断态源（enabled=0 + circuit_open + 未探测过）→ listProbeCandidates 命中
    seedCircuitOpen("s_open");
    sources = []; // 已停用，不在采集清单
    collectSourceMock.mockImplementation(async (_db: unknown, _s: unknown, opts?: { probe?: boolean }) => {
      if (opts?.probe) return { fetched: 1, inserted: 1, updated: 0 }; // 探测成功
      return { fetched: 0, inserted: 0, updated: 0 };
    });

    const summary = await runScheduledPipeline(db);

    expect(summary.circuitRevived).toEqual(["s_open"]);
    const revived = getSource(db, "s_open");
    expect(revived?.enabled).toBe(true); // reviveSource 真落库
    expect(revived?.disabled_reason).toBeNull();
    expect(notifyRevivedMock).toHaveBeenCalledTimes(1);
  });

  it("熔断源探测失败 → 维持熔断、不告警、不复活（last_probe_at 已记以节流）", async () => {
    seedCircuitOpen("s_stuck");
    sources = [];
    collectSourceMock.mockImplementation(async (_db: unknown, _s: unknown, opts?: { probe?: boolean }) => {
      if (opts?.probe) throw new Error("still down"); // 探测失败
      return { fetched: 0, inserted: 0, updated: 0 };
    });

    const summary = await runScheduledPipeline(db);

    expect(summary.circuitRevived).toBeUndefined();
    const stuck = getSource(db, "s_stuck");
    expect(stuck?.enabled).toBe(false);
    expect(stuck?.disabled_reason).toBe("circuit_open");
    expect(stuck?.last_probe_at).not.toBeNull(); // 探测前已记（节流锚点）
    expect(notifyRevivedMock).not.toHaveBeenCalled();
  });
});

describe("采集阶段接线", () => {
  it("成功采集 → collected 记 fetched/inserted；失败源 → collected 记 error + errors 记账，不连累其余", async () => {
    const good = src("s_good");
    const bad = src("s_bad");
    insertSource(db, good);
    insertSource(db, bad);
    sources = [good, bad];
    collectSourceMock.mockImplementation(async (_db: unknown, s: Source) => {
      if (s.id === "s_bad") throw new Error("fetch failed");
      return { fetched: 3, inserted: 2, updated: 1 };
    });

    const summary = await runScheduledPipeline(db);

    expect(summary.collected).toContainEqual({ source: "s_good", fetched: 3, inserted: 2, updated: 1 });
    expect(summary.collected).toContainEqual({ source: "s_bad", error: "fetch failed" });
    expect(summary.errors).toContain("collect s_bad: fetch failed");
  });
});
