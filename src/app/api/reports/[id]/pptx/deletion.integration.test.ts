import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../../../../../lib/db/index.js";
import { applyProvenanceMigrations } from "../../../../../lib/db/provenance-migrations.js";
import { applyRedactionTombstone } from "../../../../../lib/db/redaction.js";
import { saveReport } from "../../../../../lib/db/reports.js";
import * as pptGen from "../../../../../lib/services/ppt-gen.js";

const state = vi.hoisted(() => ({ db: null as DB | null }));
vi.mock("../../../../../lib/db/index.js", async (original) => ({ ...(await original<typeof import("../../../../../lib/db/index.js")>()), getDb: () => state.db }));
vi.mock("../../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: async () => null }));
import { GET } from "./route.js";

describe("real HTTP PPT deletion boundary", () => {
  it("real exporter/SQLite/handler reject a deck whose deletion commits after input loading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c1-http-ppt-"));
    const db = openDb(":memory:"); state.db = db;
    let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const actualBuild = pptGen.buildPptx;
    const spy = vi.spyOn(pptGen, "buildPptx").mockImplementationOnce(async (input) => {
      entered(); await barrier; return actualBuild(input); // scheduling seam; real deck builder still runs
    });
    try {
      applyProvenanceMigrations(db);
      db.exec(`INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','zh','daily',1)`);
      const report = { id: "r", type: "brief" as const, topic_id: "t", status: "done" as const,
        generated_at: "2026-01-01T00:00:00Z", title: "T", body_md: "# T", body_html: "<h1>T</h1>",
        insight_ids: [], event_ids: [], prev_report_id: null, citation_count: 0, cost: { tokens: 0, amount: 0 } };
      saveReport(db, report, { report_id: "r", type: "brief", topic_id: "t", facets: [], date: "2026-01-01",
        source_ids: [], title: "T", summary: "", highlights: [], tags: [], entity_names: [], importance: 0, event_ids: [], milestone_count: 0 }, { dir });
      const response = GET(new Request("http://localhost/api/reports/r/pptx"), { params: Promise.resolve({ id: "r" }) });
      await started;
      applyRedactionTombstone(db, { record_id: "deleted", entity_key: "report:r", scope: "report", reason_code: "user_erasure", effective_at: "2020-01-01T00:00:00.000Z", expiry_at: "2020-02-01T00:00:00.000Z", registry_ref: "records/deleted.json" });
      release(); const result = await response;
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({ error: "report_not_found" });
      expect(result.headers.get("X-Ppt-Page-Count")).toBeNull();
      expect(spy).toHaveBeenCalledOnce();
    } finally { release(); spy.mockRestore(); state.db = null; db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
