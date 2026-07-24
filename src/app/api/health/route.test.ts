import { afterEach, describe, expect, it, vi } from "vitest";
import type { StalenessResult } from "../../../lib/runtime/staleness.js";

vi.mock("../../../lib/db/index.js", () => ({ getDb: vi.fn() }));
vi.mock("../../../lib/runtime/staleness.js", () => ({
  checkStaleness: vi.fn(),
  maybeAlertStale: vi.fn(),
}));
vi.mock("../../../lib/runtime/logger.js", () => ({
  runLogger: vi.fn(() => ({ error: vi.fn() })),
}));

import { getDb } from "../../../lib/db/index.js";
import { runLogger } from "../../../lib/runtime/logger.js";
import { checkStaleness, maybeAlertStale } from "../../../lib/runtime/staleness.js";
import { GET } from "./route.js";

const fresh: StalenessResult = {
  stale: false,
  reason: "fresh",
  latestReportAt: "2026-07-01T00:00:00.000Z",
  latestContentAt: "2026-07-01T01:00:00.000Z",
  reportAgeHours: 1.24,
  contentAgeHours: 0.06,
  thresholdHours: 26,
};

afterEach(() => vi.clearAllMocks());

describe("GET /api/health", () => {
  it("DB 可达 → 返回报告数、四舍五入后的新鲜度，并触发非阻塞告警检查", async () => {
    const get = vi.fn(() => ({ c: 3 }));
    vi.mocked(getDb).mockReturnValue({ prepare: vi.fn(() => ({ get })) } as never);
    vi.mocked(checkStaleness).mockReturnValue(fresh);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      reports: 3,
      data: {
        stale: false,
        reason: "fresh",
        reportAgeHours: 1.2,
        contentAgeHours: 0.1,
        latestReportAt: fresh.latestReportAt,
        thresholdHours: 26,
      },
    });
    expect(maybeAlertStale).toHaveBeenCalledWith(fresh);
  });

  it("DB 查询失败 → 500；内部错误只记日志、不回显给公开探针", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("database unavailable");
    });

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ status: "error", error: "health check failed" });
    expect(runLogger).toHaveBeenCalledWith({ stage: "health" });
    expect(checkStaleness).not.toHaveBeenCalled();
    expect(maybeAlertStale).not.toHaveBeenCalled();
  });
});
