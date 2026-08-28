import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProvenanceMigrations } from "../../../lib/db/provenance-migrations.js";

let tempDir = "";
let POST: typeof import("./route.js").POST;
let getDb: typeof import("../../../lib/db/index.js").getDb;
let closeDb: typeof import("../../../lib/db/index.js").closeDb;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "insight-cron-"));
  vi.resetModules();
  vi.stubEnv("DB_PATH", join(tempDir, "insight.db"));
  vi.stubEnv("CRON_SECRET", "integration-secret");
  vi.stubEnv("INTEGRITY_ANCHOR_ENABLED", "false");
  ({ POST } = await import("./route.js"));
  ({ getDb, closeDb } = await import("../../../lib/db/index.js"));
  applyProvenanceMigrations(getDb());
});

afterEach(async () => {
  closeDb?.();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

describe("cron integrity route integration", () => {
  it("keeps the authenticated cron endpoint healthy while P1 anchors are disabled", async () => {
    const request = new Request("http://test/api/cron?mode=integrity", {
      method: "POST", headers: { authorization: "Bearer integration-secret" },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, mode: "integrity", summary: { skipped: true, reason: "integrity_anchor_disabled" },
    });
  });

  it("still rejects an unauthenticated integrity request before touching the database", async () => {
    const response = await POST(new Request("http://test/api/cron?mode=integrity", { method: "POST" }));
    expect(response.status).toBe(401);
  });
});
