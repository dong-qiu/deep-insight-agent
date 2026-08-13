import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer, parseLaunchctlStatus, parseLockOwner, readStatus } from "./symphony-dashboard.mjs";

test("parses the LaunchAgent state without accepting unrelated nested state", () => {
  const status = parseLaunchctlStatus(`
    active count = 1
    state = running
    runs = 12
    last exit code = 1
      state = active
  `);
  assert.deepEqual(status, { state: "running", activeCount: 1, runs: 12, lastExitCode: "1" });
});

test("parses the macOS lockf helper without exposing its arguments", () => {
  assert.deepEqual(parseLockOwner("COMMAND   PID USER\ntail 94945 symphony 9w REG lock\n"), { held: true, command: "tail", pid: 94945 });
  assert.deepEqual(parseLockOwner(""), { held: false, command: null, pid: null });
});

test("collects local-only status with static command arguments", async () => {
  const calls = [];
  const status = await readStatus({
    home: "/Users/symphony",
    uid: 502,
    countWorkspaces: async (root) => { assert.equal(root, "/Users/symphony/workspaces/insight-agent"); return 2; },
    runCommand: async (name, args) => {
      calls.push([name, args]);
      if (name.endsWith("launchctl")) return " active count = 1\n state = running\n runs = 2\n";
      if (name.endsWith("lsof")) return "COMMAND PID USER\ntail 42 symphony\n";
      return "260d3f4\n";
    },
  });
  assert.equal(status.service.state, "running");
  assert.deepEqual(status.controllerLock, { held: true });
  assert.equal(status.runtimeRevision, "260d3f4");
  assert.equal(status.workspaceCount, 2);
  assert.deepEqual(calls.map(([, args]) => args), [
    ["print", "gui/502/io.insight-agent.symphony"],
    ["/Users/symphony/locks/symphony-github-dong-qiu--deep-insight-agent.lock"],
    ["-C", "/Users/symphony/symphony-runtime/openai-symphony", "rev-parse", "--short", "HEAD"],
  ]);
});

test("only exposes read-only routes", async () => {
  const server = createDashboardServer({ readStatus: async () => ({ service: { state: "running", activeCount: 1 }, controllerLock: { held: true }, runtimeRevision: "260d3f4", workspaceCount: 0, checkedAt: "2026-08-14T00:00:00.000Z" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const status = await fetch(`http://127.0.0.1:${address.port}/api/status`);
    assert.equal(status.status, 200);
    assert.match(status.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.equal((await status.json()).runtimeRevision, "260d3f4");
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/status`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/not-found`)).status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("returns a safe unavailable response when local inspection fails", async () => {
  const server = createDashboardServer({ readStatus: async () => { throw new Error("private failure"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/status`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
