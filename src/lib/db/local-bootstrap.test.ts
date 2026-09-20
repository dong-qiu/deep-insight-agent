import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "./index.js";
import { openLocalBootstrapDb } from "./local-bootstrap.js";
import { assertProvenanceSchema } from "./provenance-migrations.js";

describe("local development bootstrap", () => {
  it("makes the documented seed-to-dev database ready for the report review writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-local-bootstrap-"));
    const path = join(dir, "insight.db");
    try {
      const seeded = openLocalBootstrapDb(path);
      expect(() => assertProvenanceSchema(seeded)).not.toThrow();
      expect(seeded.prepare("SELECT 1 FROM schema_migration WHERE version='20260916_45_report_quality_review_trace_v1'").get()).toBeTruthy();
      expect(seeded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_review_snapshot'").get()).toBeTruthy();
      seeded.close();

      // `next dev` uses the normal application opener after `npm run seed`.
      const dev = openDb(path);
      expect(dev.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_selection_decision'").get()).toBeTruthy();
      dev.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the local-only entrypoint in strict or production environments", () => {
    try {
      vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", "1");
      expect(() => openLocalBootstrapDb(":memory:")).toThrow("local_bootstrap_forbidden_in_production");
      vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", undefined);
      vi.stubEnv("NODE_ENV", "production");
      expect(() => openLocalBootstrapDb(":memory:")).toThrow("local_bootstrap_forbidden_in_production");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
