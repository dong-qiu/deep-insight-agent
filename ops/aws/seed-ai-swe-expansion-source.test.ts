/** Guard the exact JS payload shipped by the production cohort launcher.
 *
 * The shell wrapper only transports this payload over SSM; executing it against a
 * temporary SQLite database verifies its transaction and abnormal-state behaviour
 * without touching AWS or a live database.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type DB } from "../../src/lib/db/index.js";

const cohort = ["src_openai_codex_releases", "src_cursor_changelog", "src_openhands_releases"];
const shell = readFileSync(fileURLToPath(new URL("./seed-ai-swe-expansion-source.sh", import.meta.url)), "utf8");
const payload = shell.match(/read -r -d '' seed_js <<'JS' \|\| true\n([\s\S]*?)\nJS\n/)?.[1];
if (!payload) throw new Error("could not extract the guarded production payload");

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ia-ai-swe-cohort-"));
  db = openDb(join(dir, "insight.db"));
  db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runPayload() {
  return spawnSync(process.execPath, ["-e", payload!.replace('"/data/insight.db"', JSON.stringify(join(dir, "insight.db")))], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") },
  });
}

function rows() {
  const check = openDb(join(dir, "insight.db"));
  const values = check.prepare("SELECT id,enabled,endpoint,disabled_reason FROM source WHERE id IN (?,?,?) ORDER BY id")
    .all(...cohort) as { id: string; enabled: number; endpoint: string; disabled_reason: string | null }[];
  check.close();
  return values;
}

it("atomically inserts an unlaunched cohort and permits only an all-enabled retry", () => {
  const first = runPayload();
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).actions).toEqual(cohort.map((id) => ({ id, action: "inserted" })));
  expect(rows().map((row) => row.enabled)).toEqual([1, 1, 1]);

  const retry = runPayload();
  expect(retry.status, retry.stderr).toBe(0);
  expect(JSON.parse(retry.stdout).actions).toEqual(cohort.map((id) => ({ id, action: "already_enabled" })));

  const partial = openDb(join(dir, "insight.db"));
  partial.prepare("UPDATE source SET enabled=0 WHERE id=?").run("src_cursor_changelog");
  partial.close();
  const rejected = runPayload();
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("non-cohort initial state");
  expect(rows().find((row) => row.id === "src_cursor_changelog")?.enabled).toBe(0);
});

it("rejects drift and manual disablement before writing any member", () => {
  expect(runPayload().status).toBe(0);
  const mutate = openDb(join(dir, "insight.db"));
  mutate.exec("UPDATE source SET enabled=0");
  mutate.prepare("UPDATE source SET endpoint='https://example.invalid/feed' WHERE id=?").run("src_cursor_changelog");
  mutate.close();

  const drift = runPayload();
  expect(drift.status).toBe(1);
  expect(drift.stderr).toContain("source configuration drift");
  expect(rows().map((row) => row.enabled)).toEqual([0, 0, 0]);

  const repair = openDb(join(dir, "insight.db"));
  repair.prepare("UPDATE source SET endpoint='https://cursor.com/changelog/rss.xml', disabled_reason='manual review' WHERE id=?")
    .run("src_cursor_changelog");
  repair.close();
  const disabled = runPayload();
  expect(disabled.status).toBe(1);
  expect(disabled.stderr).toContain("manual disablement blocks src_cursor_changelog");
  expect(rows().map((row) => row.enabled)).toEqual([0, 0, 0]);
});
