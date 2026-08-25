import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProvenanceMigrations } from "../../../../../lib/db/provenance-migrations.js";
import { createDeepDiveTraceRequest, hashIdempotencyKey } from "../../../../../lib/db/provenance.js";
import { insertTopic } from "../../../../../lib/db/repos.js";

let tempDir = "";
let GET: typeof import("./route.js").GET;
let getDb: typeof import("../../../../../lib/db/index.js").getDb;
let closeDb: typeof import("../../../../../lib/db/index.js").closeDb;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "insight-dispatch-health-"));
  vi.resetModules();
  vi.stubEnv("DB_PATH", join(tempDir, "insight.db"));
  vi.stubEnv("DISPATCH_WORKER_SECRET", "integration-secret");
  ({ GET } = await import("./route.js"));
  ({ getDb, closeDb } = await import("../../../../../lib/db/index.js"));
  applyProvenanceMigrations(getDb());
});

afterEach(async () => {
  closeDb?.();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

describe("dispatch worker readiness route integration", () => {
  it("authenticates the worker and returns real queue-age readiness", async () => {
    const request = (secret?: string) => new Request("http://test/api/internal/generation-dispatch/health", {
      headers: secret ? { "x-dispatch-worker-secret": secret } : {},
    });
    expect((await GET(request())).status).toBe(403);
    expect(await (await GET(request("integration-secret"))).json()).toMatchObject({
      status: "ready", queuedCount: 0, expiredClaimedCount: 0,
    });

    insertTopic(getDb(), {
      id: "topic-health", name: "Health", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true,
    });
    createDeepDiveTraceRequest(getDb(), {
      topicId: "topic-health", idempotencyKeyHash: hashIdempotencyKey("abcdefgh", "integration-secret"), planning: true,
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    const response = await GET(request("integration-secret"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      queuedCount: 1, status: "not_ready", oldestActionableAgeMs: expect.any(Number),
    });
  });
});
