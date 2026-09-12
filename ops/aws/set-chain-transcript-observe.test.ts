/** Test the exact guarded production payload on a disposable SQLite database; AWS is never called. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDb, type DB } from "../../src/lib/db/index.js";
import { insertSource } from "../../src/lib/db/repos.js";
import type { Source } from "../../src/lib/types.js";

const shell = readFileSync(fileURLToPath(new URL("./set-chain-transcript-observe.sh", import.meta.url)), "utf8");
const payload = shell.match(/read -r -d '' migration_js <<'JS' \|\| true\n([\s\S]*?)\nJS\n/)?.[1];
if (!payload) throw new Error("could not extract Chain observe payload");
const source: Source = {
  id: "src_chain_of_thought", name: "Chain of Thought（播客 · 转写）", type: "rss",
  endpoint: "https://feeds.transistor.fm/chain-of-thought", topic_ids: ["t_code_agents"],
  fetch_interval: "24h", backfill: null, enabled: true, fetch_mode: "feed", content_container: null,
  transcript_mode: "off", transcript_strategy: "relevant_only", transcript_max_items_per_run: 5,
  transcript_max_bytes_per_run: 5 * 1024 * 1024, transcript_timeout_budget_ms: 30_000, transcript_host_qps: 0.5,
};
let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ia-chain-observe-"));
  db = openDb(join(dir, "insight.db"));
  insertSource(db, source);
  db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runPayload() {
  return spawnSync(process.execPath, ["-e", payload!.replace('"/data/insight.db"', JSON.stringify(join(dir, "insight.db")))], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") },
  });
}
function policy() {
  const check = openDb(join(dir, "insight.db"));
  const value = check.prepare("SELECT transcript_mode,transcript_strategy,transcript_max_items_per_run,transcript_max_bytes_per_run,transcript_timeout_budget_ms,transcript_host_qps FROM source WHERE id=?")
    .get(source.id);
  check.close();
  return value;
}

it("only transitions the exact audited source off -> observe and is idempotent", () => {
  expect(runPayload().status).toBe(0);
  expect(JSON.parse(runPayload().stdout)).toMatchObject({ action: "already_observing" });
  expect(policy()).toEqual({ transcript_mode: "observe", transcript_strategy: "all", transcript_max_items_per_run: 2,
    transcript_max_bytes_per_run: 2 * 1024 * 1024, transcript_timeout_budget_ms: 20_000, transcript_host_qps: 0.25 });
});

it("refuses a drifted source or an enabled policy rather than overwriting it", () => {
  const mutate = openDb(join(dir, "insight.db"));
  mutate.prepare("UPDATE source SET endpoint=? WHERE id=?").run("https://example.invalid/feed", source.id);
  mutate.close();
  expect(runPayload().status).toBe(1);

  const reset = openDb(join(dir, "insight.db"));
  reset.prepare("UPDATE source SET endpoint=?, transcript_mode='enabled' WHERE id=?").run(source.endpoint, source.id);
  reset.close();
  expect(runPayload().status).toBe(1);
});
