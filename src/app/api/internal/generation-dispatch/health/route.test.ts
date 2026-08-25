import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../lib/db/index.js", () => ({ getDb: vi.fn() }));
vi.mock("../../../../../lib/db/provenance.js", () => ({ getGenerationDispatchHealth: vi.fn() }));
vi.mock("../../../../../lib/runtime/dispatch-auth.js", () => ({ hasDispatchWorkerSecret: vi.fn() }));
vi.mock("../../../../../lib/runtime/generation-dispatch-health.js", () => ({ maybeAlertGenerationDispatchHealth: vi.fn() }));

import { getDb } from "../../../../../lib/db/index.js";
import { getGenerationDispatchHealth } from "../../../../../lib/db/provenance.js";
import { hasDispatchWorkerSecret } from "../../../../../lib/runtime/dispatch-auth.js";
import { maybeAlertGenerationDispatchHealth } from "../../../../../lib/runtime/generation-dispatch-health.js";
import { GET } from "./route.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("dispatch worker readiness", () => {
  it("returns 200 for a degraded but still ready queue and triggers alerting", async () => {
    vi.stubEnv("DISPATCH_WORKER_SECRET", "secret");
    vi.mocked(hasDispatchWorkerSecret).mockReturnValue(true);
    vi.mocked(getDb).mockReturnValue({} as never);
    const health = { queuedCount: 1, expiredClaimedCount: 0, oldestActionableAt: "2026-08-03T00:00:00.000Z", oldestActionableAgeMs: 301_000, status: "degraded" as const };
    vi.mocked(getGenerationDispatchHealth).mockReturnValue(health);

    const response = await GET(new Request("http://test/api/internal/generation-dispatch/health", { headers: { "x-dispatch-worker-secret": "secret" } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(health);
    expect(maybeAlertGenerationDispatchHealth).toHaveBeenCalledWith(health);
  });

  it("returns 503 after the queue breaches readiness age", async () => {
    vi.stubEnv("DISPATCH_WORKER_SECRET", "secret");
    vi.mocked(hasDispatchWorkerSecret).mockReturnValue(true);
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(getGenerationDispatchHealth).mockReturnValue({ queuedCount: 1, expiredClaimedCount: 0, oldestActionableAt: "2026-08-03T00:00:00.000Z", oldestActionableAgeMs: 901_000, status: "not_ready" });

    const response = await GET(new Request("http://test/api/internal/generation-dispatch/health", { headers: { "x-dispatch-worker-secret": "secret" } }));
    expect(response.status).toBe(503);
  });

  it("rejects callers without the worker secret", async () => {
    vi.stubEnv("DISPATCH_WORKER_SECRET", "secret");
    vi.mocked(hasDispatchWorkerSecret).mockReturnValue(false);
    const response = await GET(new Request("http://test/api/internal/generation-dispatch/health"));
    expect(response.status).toBe(403);
    expect(getGenerationDispatchHealth).not.toHaveBeenCalled();
  });
});
