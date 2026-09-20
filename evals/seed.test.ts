import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db/index.js";
import { assertProvenanceSchema } from "../src/lib/db/provenance-migrations.js";

describe("npm run seed", () => {
  it("boots a fresh isolated local database through the provenance ledger before dev opens it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-seed-cli-"));
    const dbPath = join(dir, "insight.db");
    try {
      execFileSync("npm", ["run", "seed"], {
        cwd: process.cwd(),
        env: { ...process.env, ANTHROPIC_API_KEY: "test-key", DB_PATH: dbPath },
        stdio: "pipe",
      });
      const db = openDb(dbPath);
      expect(() => assertProvenanceSchema(db)).not.toThrow();
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_review_snapshot'").get()).toBeTruthy();
      expect(db.prepare("SELECT COUNT(*) AS count FROM topic").get()).toEqual({ count: expect.any(Number) });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
