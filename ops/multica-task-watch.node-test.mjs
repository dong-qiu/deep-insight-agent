import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeIssue, parseArgs } from "./multica-task-watch.mjs";

const watcher = new URL("./multica-task-watch.mjs", import.meta.url);
const autoWatch = new URL("./multica-auto-watch.zsh", import.meta.url);

async function makeCommand(directory, name, contents) {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${contents}\n`, "utf8");
  await chmod(path, 0o755);
}

test("validates issue and PR inputs without retaining raw values", () => {
  assert.deepEqual(parseArgs(["INSI-96", "--pr", "0293"]), {
    issues: ["INSI-96"], prs: ["293"], intervalSeconds: 15, once: false, untilIdle: false,
  });
  assert.throws(() => parseArgs(["https://user:secret@example.test/INSI-96"]), /Invalid issue identifier/);
  assert.throws(() => parseArgs(["--pr", "token-should-not-print"]), /Invalid PR number/);

  const result = spawnSync(process.execPath, [watcher.pathname, "https://user:top-secret@example.test/INSI-96"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid issue identifier/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /top-secret|example\.test/i);
});

test("query errors remain active so --until-idle cannot report completion", () => {
  assert.equal(activeIssue({ issue: { _watchError: "query failed" } }), true);
});

test("does not print CLI stderr, URIs, or token-like arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insight-watch-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await makeCommand(directory, "multica", 'echo "https://api.example.test/?token=top-secret" >&2; exit 1');
  await makeCommand(directory, "gh", 'echo "https://api.example.test/?token=top-secret" >&2; exit 1');

  const child = spawn(process.execPath, [watcher.pathname, "--once", "INSI-96"], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0);
  assert.match(output, /ERROR query failed/);
  assert.doesNotMatch(output, /api\.example|top-secret|token=/i);
});

test("--until-idle keeps observing after a query error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insight-watch-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await makeCommand(directory, "multica", 'echo "https://api.example.test/?token=top-secret" >&2; exit 1');
  await makeCommand(directory, "gh", 'echo "https://api.example.test/?token=top-secret" >&2; exit 1');

  const child = spawn(process.execPath, [watcher.pathname, "--until-idle", "--interval", "5", "INSI-96"], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(output, /idle; watcher exiting/);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("close", resolve));
});

test("deduplicates discovered and explicit PRs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insight-watch-dedup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const multica = `case "$1:$2" in
  issue:get) echo '{"identifier":"INSI-96","status":"in_progress","assignee_type":"agent","assignee_id":"agent"}' ;;
  issue:runs) echo '[]' ;;
  issue:pull-requests) echo '{"pull_requests":[{"number":293}]}' ;;
  *) exit 1 ;;
esac`;
  const gh = 'echo "{\\"state\\":\\"OPEN\\",\\"mergeStateStatus\\":\\"CLEAN\\",\\"headRefOid\\":\\"123456789012\\",\\"statusCheckRollup\\":[]}"';
  await makeCommand(directory, "multica", multica);
  await makeCommand(directory, "gh", gh);
  const result = spawnSync(process.execPath, [watcher.pathname, "--once", "INSI-96", "--pr", "293"], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/PR #293:/g) ?? []).length, 1);
});

test("zsh TTY wrapper preserves Multica exit semantics for watcher success, failure, Ctrl-C, and command failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insight-auto-watch-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await makeCommand(directory, "multica", 'echo MULTICA_CALLED; exit "${MULTICA_RESULT:-0}"');
  await makeCommand(directory, "node", `echo WATCHER_STARTED
case "\${WATCHER_MODE:-success}" in
  success) exit 0 ;;
  failure) exit 42 ;;
  interrupt)
    trap 'echo WATCHER_INTERRUPTED; exit 130' INT
    while :; do sleep 1; done
    ;;
esac`);
  const watchedShellPath = join(directory, "run-auto-watch.zsh");
  await writeFile(watchedShellPath, `source ${JSON.stringify(autoWatch.pathname)}\nmultica issue status INSI-96 in_progress\nprint -r -- RESULT:$?\nexit\n`, "utf8");

  const runInTty = ({ multicaResult, watcherMode, interruptWatcher = false }) => {
    const watcherCommand = `zsh -fi ${JSON.stringify(watchedShellPath)}`;
    const collectOutput = interruptWatcher
      ? "sleep 1; zpty -rt watcher; zpty -w watcher $'\\003'; sleep 1; zpty -rt watcher; zpty -d watcher"
      : "sleep 2; zpty -rt watcher; zpty -d watcher";
    const harness = `zmodload zsh/zpty || exit 1; zpty -b watcher ${JSON.stringify(watcherCommand)}; ${collectOutput}`;
    const result = spawnSync("zsh", ["-fc", harness], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MULTICA_RESULT: String(multicaResult), WATCHER_MODE: watcherMode },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  const completedWatcher = runInTty({ multicaResult: 0, watcherMode: "success" });
  assert.match(completedWatcher, /WATCHER_STARTED/);
  assert.match(completedWatcher, /RESULT:0/);

  const failedWatcher = runInTty({ multicaResult: 0, watcherMode: "failure" });
  assert.match(failedWatcher, /WATCHER_STARTED/);
  assert.match(failedWatcher, /RESULT:0/);

  const interrupted = runInTty({ multicaResult: 0, watcherMode: "interrupt", interruptWatcher: true });
  assert.match(interrupted, /WATCHER_STARTED/);
  assert.match(interrupted, /WATCHER_INTERRUPTED/);
  assert.match(interrupted, /RESULT:0/);

  const failedCommand = runInTty({ multicaResult: 23, watcherMode: "success" });
  assert.match(failedCommand, /RESULT:23/);
  assert.doesNotMatch(failedCommand, /WATCHER_STARTED/);
});
