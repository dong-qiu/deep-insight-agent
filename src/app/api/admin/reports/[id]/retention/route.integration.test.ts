import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProvenanceMigrations } from "../../../../../../lib/db/provenance-migrations.js";

const auth = vi.hoisted(() => ({ requireAdminActor: vi.fn() }));
// See the integrity-check integration test: only the identity boundary is
// substituted; database, lifecycle, and runtime admission logic are real.
vi.mock("../../../../../../lib/auth-guard.js", () => auth);

let tempDir = "";
let POST: typeof import("./route.js").POST;
let getDb: typeof import("../../../../../../lib/db/index.js").getDb;
let closeDb: typeof import("../../../../../../lib/db/index.js").closeDb;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "insight-retention-"));
  vi.resetModules();
  vi.stubEnv("DB_PATH", join(tempDir, "insight.db"));
  vi.stubEnv("INTEGRITY_ANCHOR_ENABLED", "false");
  vi.stubEnv("P1_DASHBOARD_ENABLED", "true");
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

describe("retention lifecycle route integration", () => {
  it("does not perform an external legal hold while P1 anchors are disabled", async () => {
    const response = await POST(new Request("http://test/api/admin/reports/report_123/retention", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "place_hold", hold_id: "hold_123", reason_code: "legal_request" }),
    }), { params: Promise.resolve({ id: "report_123" }) });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "legal_hold_unavailable" });
  });
});
