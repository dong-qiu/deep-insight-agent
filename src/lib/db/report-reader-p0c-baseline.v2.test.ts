import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// The baseline must load even when resolving the current lifecycle module is
// forbidden. This guards its frozen module graph as well as its behavior.
vi.mock("./integrity-lifecycle.js", () => {
  throw new Error("current_lifecycle_module_must_not_be_resolved_by_p0c_baseline");
});

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("uses the versioned visibility snapshot without resolving current lifecycle code", async () => {
  const baselineSource = readFileSync(new URL("./report-reader-p0c-baseline.v2.ts", import.meta.url), "utf8");
  const snapshotSource = readFileSync(new URL("./report-reader-p0c-visibility.v1.ts", import.meta.url), "utf8");
  expect(baselineSource).not.toMatch(/["']\.\/integrity-lifecycle\.js["']/);
  expect(snapshotSource).not.toMatch(/["']\.\/integrity-lifecycle\.js["']/);

  const directory = mkdtempSync(join(tmpdir(), "report-reader-p0c-baseline-"));
  cleanup.push(directory);
  const bodyPath = join(directory, "report");
  writeFileSync(`${bodyPath}.md`, "# frozen", "utf8");
  writeFileSync(`${bodyPath}.html`, "<h1>frozen</h1>", "utf8");
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE report (
    id TEXT PRIMARY KEY, type TEXT, topic_id TEXT, status TEXT, generated_at TEXT,
    title TEXT, body_path TEXT, insight_ids TEXT, event_ids TEXT, prev_report_id TEXT,
    citation_count INTEGER, cost TEXT
  )`);
  db.prepare(`INSERT INTO report VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "report", "brief", "topic", "done", "2026-08-17T00:00:00.000Z", "Frozen", bodyPath,
    "[]", "[]", null, 0, "{}",
  );

  const { getP0cBaselineReport } = await import("./report-reader-p0c-baseline.v2.js");
  expect(getP0cBaselineReport(db, "report")).toMatchObject({ id: "report", title: "Frozen" });
  db.close();
});
