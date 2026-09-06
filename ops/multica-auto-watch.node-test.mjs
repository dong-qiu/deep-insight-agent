import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const integration = resolve("ops/multica-auto-watch.zsh");

function startedIssue(...args) {
  const result = spawnSync(
    "zsh",
    ["-fc", 'source "$1"; shift; _insight_multica_started_issue "$@"', "zsh", integration, ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  return result.stdout.trim();
}

test("finds a normal Multica issue identifier", () => {
  assert.equal(startedIssue("issue", "assign", "INSI-91"), "INSI-91");
});

test("does not confuse option values with the issue identifier", () => {
  assert.equal(startedIssue("issue", "assign", "--to", "researcher", "INSI-91"), "INSI-91");
  assert.equal(startedIssue("issue", "assign", "--output", "table", "GH-242"), "GH-242");
});

test("does not watch commands that explicitly suppress task start", () => {
  assert.equal(startedIssue("issue", "status", "--no-start", "INSI-91", "in_progress"), "");
});
