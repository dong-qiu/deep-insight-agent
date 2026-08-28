import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProvenanceMigrations } from "../../../../../../lib/db/provenance-migrations.js";

const auth = vi.hoisted(() => ({ requireAdminActor: vi.fn() }));
// Authentication transport is outside this route's runtime admission contract.
// Keep the database and P1 runtime modules real so this exercises the actual
// fail-closed path used after an authenticated administrator reaches the route.
vi.mock("../../../../../../lib/auth-guard.js", () => auth);

let tempDir = "";
let POST: typeof import("./route.js").POST;
let getDb: typeof import("../../../../../../lib/db/index.js").getDb;
let closeDb: typeof import("../../../../../../lib/db/index.js").closeDb;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "insight-integrity-check-"));
  vi.resetModules();
  vi.stubEnv("DB_PATH", join(tempDir, "insight.db"));
  vi.stubEnv("INTEGRITY_ANCHOR_ENABLED", "false");
  auth.requireAdminActor.mockReset().mockResolvedValue({ id: "admin_1", role: "admin" });
  ({ POST } = await import("./route.js"));
  ({ getDb, closeDb } = await import("../../../../../../lib/db/index.js"));
  applyProvenanceMigrations(getDb());
});

afterEach(async () => {
  closeDb?.();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

describe("integrity check route integration", () => {
  it("fails closed for an authenticated administrator while P1 anchors are disabled", async () => {
    const response = await POST(new Request("http://test/api/admin/integrity-checks/artifact_1/v1", { method: "POST" }), {
      params: Promise.resolve({ artifactId: "artifact_1", version: "v1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "integrity_check_failed" });
  });
});
