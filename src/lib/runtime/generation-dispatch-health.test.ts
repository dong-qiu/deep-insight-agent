import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationDispatchHealth } from "../db/provenance.js";
import {
  generationDispatchHealthNotification,
  maybeAlertGenerationDispatchHealth,
  resetGenerationDispatchHealthAlertState,
} from "./generation-dispatch-health.js";

const healthy: GenerationDispatchHealth = {
  queuedCount: 0, expiredClaimedCount: 0, oldestActionableAt: null, oldestActionableAgeMs: null, status: "ready",
};
const stalled: GenerationDispatchHealth = {
  queuedCount: 2,
  expiredClaimedCount: 1,
  oldestActionableAt: "2026-08-03T00:00:00.000Z",
  oldestActionableAgeMs: 5 * 60_000 + 1,
  status: "degraded",
};

afterEach(() => {
  resetGenerationDispatchHealthAlertState();
  vi.unstubAllEnvs();
});

describe("generation dispatch queue-age alert", () => {
  it("alerts once per incident window and includes actionable queue facts", () => {
    const send = vi.fn();
    maybeAlertGenerationDispatchHealth(stalled, 1_000, send);
    maybeAlertGenerationDispatchHealth(stalled, 2_000, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      title: "🔴 生成调度队列积压",
      text: expect.stringContaining("queued：2；已过期 claimed：1"),
    }));
  });

  it("resets deduplication after recovery so a new incident alerts immediately", () => {
    const send = vi.fn();
    maybeAlertGenerationDispatchHealth(stalled, 1_000, send);
    maybeAlertGenerationDispatchHealth(healthy, 2_000, send);
    maybeAlertGenerationDispatchHealth(stalled, 3_000, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("renders a useful notification without a task timestamp", () => {
    expect(generationDispatchHealthNotification({ ...stalled, oldestActionableAt: null }).text).toContain("最早任务创建时间：无");
  });
});
