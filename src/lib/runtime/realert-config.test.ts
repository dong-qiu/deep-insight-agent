import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationDispatchHealth } from "../db/provenance.js";
import * as staleness from "./staleness.js";
import * as dispatch from "./generation-dispatch-health.js";
import * as provenance from "../db/provenance.js";

const mocks = vi.hoisted(() => ({ notify: vi.fn(), warn: vi.fn(), error: vi.fn(), getDb: vi.fn() }));
vi.mock("./alert.js", () => ({ notify: mocks.notify }));
vi.mock("./logger.js", () => ({ runLogger: () => ({ warn: mocks.warn, error: mocks.error }) }));
vi.mock("../db/index.js", () => ({ getDb: mocks.getDb }));

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const stale: staleness.StalenessResult = { stale: true, reason: "stale", thresholdHours: 26,
  latestReportAt: null, latestContentAt: null, reportAgeHours: 30, contentAgeHours: 30 };
const topic = { topicId: "t1", topicName: "topic", latestReportAt: null, reportAgeHours: 30, state: "stale" as const };
const daily: staleness.DailyTopicStalenessResult = { thresholdHours: 26, topics: [topic], staleTopics: [topic] };
const stalled: GenerationDispatchHealth = { queuedCount: 1, expiredClaimedCount: 0,
  oldestActionableAt: "2026-10-01T00:00:00.000Z", oldestActionableAgeMs: 301_000, status: "degraded" };
const healthy: GenerationDispatchHealth = { queuedCount: 0, expiredClaimedCount: 0,
  oldestActionableAt: null, oldestActionableAgeMs: null, status: "ready" };
const modes = ["global", "daily", "dispatch"] as const;
type Mode = typeof modes[number];
const field = (mode: Mode) => mode === "dispatch" ? "GENERATION_DISPATCH_REALERT_HOURS" : "STALENESS_REALERT_HOURS";
function invoke(mode: Mode, now: number): void {
  if (mode === "global") staleness.maybeAlertStale(stale, now, mocks.notify);
  else if (mode === "daily") staleness.maybeAlertDailyTopicStaleness(daily, now, mocks.notify);
  else dispatch.maybeAlertGenerationDispatchHealth(stalled, now, mocks.notify);
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
  staleness.resetStalenessAlertState(); dispatch.resetGenerationDispatchHealthAlertState();
  mocks.warn.mockReset(); mocks.error.mockReset(); mocks.notify.mockReset();
  delete process.env.STALENESS_REALERT_HOURS; delete process.env.GENERATION_DISPATCH_REALERT_HOURS;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

for (const mode of modes) describe(`${mode} real re-alert consumer`, () => {
  it.each([undefined, "", "  ", "0", "-0", "0.0", "0x0", "NaN", "invalid"])("preserves safe default for %s", raw => {
    if (raw !== undefined) vi.stubEnv(field(mode), raw);
    const hours = mode === "dispatch" ? 1 : 24;
    invoke(mode, NOW); invoke(mode, NOW + hours * HOUR - 1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    invoke(mode, NOW + hours * HOUR); expect(mocks.notify).toHaveBeenCalledTimes(2);
  });
  it.each([["1.5", 1.5], [" 2 ", 2], ["2e0", 2], ["0x2", 2], ["0.5", 1], ["-2", 1], ["-Infinity", 1], ["-1e309", 1]] as const)("preserves Number and clamp for %s", (raw, hours) => {
    vi.stubEnv(field(mode), raw); invoke(mode, NOW); invoke(mode, NOW + hours * HOUR - 1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    invoke(mode, NOW + hours * HOUR); expect(mocks.notify).toHaveBeenCalledTimes(2);
  });
  it("accepts a huge finite product without an invented business limit", () => {
    vi.stubEnv(field(mode), "1e300"); invoke(mode, NOW); invoke(mode, NOW + HOUR);
    // Global's original zero timestamp is also within this enormous valid window.
    expect(mocks.notify).toHaveBeenCalledTimes(mode === "global" ? 0 : 1);
    expect(mocks.warn.mock.calls.some(call => call[0]?.reason_code === "realert_interval_nonfinite")).toBe(false);
  });
  it.each(["Infinity", "1e309", "1e308"])("rejects final nonfinite ms before notification or incident advance: %s", raw => {
    vi.stubEnv(field(mode), raw); invoke(mode, NOW);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith({ field: field(mode), reason_code: "realert_interval_nonfinite" }, "invalid re-alert interval");
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(raw);
    vi.stubEnv(field(mode), "1"); invoke(mode, NOW + 1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    if (mode === "dispatch") expect(mocks.warn.mock.calls.at(-1)?.[0].unhealthySince).toBe(new Date(NOW + 1).toISOString());
  });
  it("reads env dynamically and preserves the existing incident window across rejection", () => {
    vi.stubEnv(field(mode), "2"); invoke(mode, NOW);
    vi.stubEnv(field(mode), "Infinity"); invoke(mode, NOW + HOUR);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    vi.stubEnv(field(mode), "2"); invoke(mode, NOW + HOUR);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    vi.stubEnv(field(mode), "1"); invoke(mode, NOW + HOUR);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });
  it("swallows diagnostic logger failure and retains the unchanged window", () => {
    vi.stubEnv(field(mode), "Infinity"); mocks.warn.mockImplementation(() => { throw new Error("logger failed"); });
    expect(() => invoke(mode, NOW)).not.toThrow(); expect(mocks.notify).not.toHaveBeenCalled();
    mocks.warn.mockReset(); vi.stubEnv(field(mode), "1"); invoke(mode, NOW + 1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
  it("keeps the original state advancement when a legal notification/logger fails", () => {
    vi.stubEnv(field(mode), "1"); mocks.warn.mockImplementation(() => { throw new Error("logger failed"); });
    invoke(mode, NOW); mocks.warn.mockReset(); invoke(mode, NOW + 1);
    expect(mocks.notify).not.toHaveBeenCalled();
    invoke(mode, NOW + HOUR); expect(mocks.notify).toHaveBeenCalledTimes(1);
    mocks.notify.mockImplementation(() => { throw new Error("notification failed"); });
    expect(() => invoke(mode, NOW + 2 * HOUR)).not.toThrow();
    mocks.notify.mockReset(); invoke(mode, NOW + 2 * HOUR + 1); expect(mocks.notify).not.toHaveBeenCalled();
  });
});

it("global fresh never resets deduplication", () => {
  vi.stubEnv("STALENESS_REALERT_HOURS", "2"); invoke("global", NOW);
  staleness.maybeAlertStale({ ...stale, stale: false, reason: "fresh" }, NOW + 1, mocks.notify);
  invoke("global", NOW + HOUR); expect(mocks.notify).toHaveBeenCalledTimes(1);
  invoke("global", NOW + 2 * HOUR); expect(mocks.notify).toHaveBeenCalledTimes(2);
});
it("daily recovery clears only recovered topics even when another stale topic has an invalid interval", () => {
  vi.stubEnv("STALENESS_REALERT_HOURS", "2"); invoke("daily", NOW);
  const other = { ...topic, topicId: "t2" };
  vi.stubEnv("STALENESS_REALERT_HOURS", "Infinity");
  staleness.maybeAlertDailyTopicStaleness({ thresholdHours: 26, topics: [other], staleTopics: [other] }, NOW + 1, mocks.notify);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  vi.stubEnv("STALENESS_REALERT_HOURS", "2");
  staleness.maybeAlertDailyTopicStaleness({ thresholdHours: 26, topics: [topic, other], staleTopics: [topic, other] }, NOW + 2, mocks.notify);
  expect(mocks.notify).toHaveBeenCalledTimes(3);
  invoke("daily", NOW + 3); expect(mocks.notify).toHaveBeenCalledTimes(3);
});
it("dispatch healthy recovery still resets before returning without reading invalid configuration", () => {
  invoke("dispatch", NOW); vi.stubEnv("GENERATION_DISPATCH_REALERT_HOURS", "Infinity");
  dispatch.maybeAlertGenerationDispatchHealth(healthy, NOW + 1, mocks.notify);
  vi.stubEnv("GENERATION_DISPATCH_REALERT_HOURS", "1"); invoke("dispatch", NOW + 2);
  expect(mocks.notify).toHaveBeenCalledTimes(2);
});

describe("actual health GETs with real alert facades", () => {
  it.each([false, true])("public liveness retains actual response when rejection logger throws=%s", async loggerThrows => {
    vi.spyOn(staleness, "checkStaleness").mockReturnValue(stale);
    vi.spyOn(staleness, "checkDailyTopicStaleness").mockReturnValue(daily);
    mocks.getDb.mockReturnValue({ prepare: () => ({ get: () => ({ c: 3 }) }) });
    vi.stubEnv("STALENESS_REALERT_HOURS", "Infinity");
    if (loggerThrows) mocks.warn.mockImplementation(() => { throw new Error("private logger raw"); });
    const { GET } = await import("../../app/api/health/route.js"); const response = await GET();
    expect(response.status).toBe(200); const body = await response.json();
    expect(body).toMatchObject({ status: "ok", reports: 3, data: { stale: true, thresholdHours: 26, staleDailyTopicCount: 1 } });
    expect(JSON.stringify(body)).not.toContain("Infinity"); expect(mocks.notify).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
  });
  it.each([["degraded", 200], ["not_ready", 503]] as const)("worker %s retains actual classification despite invalid interval and logger failure", async (status, expected) => {
    vi.stubEnv("DISPATCH_WORKER_SECRET", "isolated-secret"); vi.stubEnv("GENERATION_DISPATCH_REALERT_HOURS", "1e308");
    vi.spyOn(provenance, "getGenerationDispatchHealth").mockReturnValue({ ...stalled, status });
    mocks.getDb.mockReturnValue({}); mocks.warn.mockImplementation(() => { throw new Error("private logger raw"); });
    const { GET } = await import("../../app/api/internal/generation-dispatch/health/route.js");
    const response = await GET(new Request("http://isolated/api/internal/generation-dispatch/health", { headers: { "x-dispatch-worker-secret": "isolated-secret" } }));
    expect(response.status).toBe(expected); expect(await response.json()).toEqual({ ...stalled, status }); expect(mocks.notify).not.toHaveBeenCalled();
    expect((await GET(new Request("http://isolated/health"))).status).toBe(403);
    delete process.env.DISPATCH_WORKER_SECRET; expect((await GET(new Request("http://isolated/health"))).status).toBe(503);
  });
});

it("module import and original fresh/healthy early returns do not read either re-alert field", async () => {
  vi.resetModules(); const original = process.env; const reads: string[] = [];
  process.env = new Proxy(original, { get(target, key: string) {
    if (key === "STALENESS_REALERT_HOURS" || key === "GENERATION_DISPATCH_REALERT_HOURS") reads.push(key);
    return target[key];
  } });
  try {
    const s = await import("./staleness.js"), d = await import("./generation-dispatch-health.js");
    expect(reads).toEqual([]);
    s.maybeAlertStale({ ...stale, stale: false, reason: "fresh" }, NOW, mocks.notify);
    d.maybeAlertGenerationDispatchHealth(healthy, NOW, mocks.notify); expect(reads).toEqual([]);
  } finally { process.env = original; }
});
