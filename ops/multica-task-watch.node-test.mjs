import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, summarizeChecks } from "./multica-task-watch.mjs";

test("parses issues, PRs, and watcher lifecycle options", () => {
  assert.deepEqual(
    parseArgs(["INSI-91", "GH-242", "--pr", "291", "--pr", "296", "--interval", "30", "--until-idle"]),
    {
      issues: ["INSI-91", "GH-242"],
      prs: ["291", "296"],
      intervalSeconds: 30,
      once: false,
      untilIdle: true,
    },
  );
});

test("rejects an invalid watcher interval", () => {
  assert.throws(() => parseArgs(["INSI-91", "--interval", "4"]), /at least 5 seconds/);
});

test("summarizes completed, active, and failed CI checks", () => {
  assert.equal(
    summarizeChecks([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "FAILURE" },
      { status: "IN_PROGRESS" },
    ]),
    "2/3 complete, 1 active, 1 failed",
  );
});
