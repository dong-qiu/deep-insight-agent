import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { discoverNodeTests, runNodeTests } from "./run-node-tests.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("both compilers check tools separately from the production application build", () => {
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const compiler of ["ts6", "ts7"]) assert.ok(scripts[`typecheck:${compiler}`].includes("--noEmit -p tsconfig.tools.json"));
  function inputs(config) {
    const path = join(root, config);
    const { config: json, error } = ts.readConfigFile(path, ts.sys.readFile);
    assert.equal(error, undefined);
    const parsed = ts.parseJsonConfigFileContent(json, ts.sys, root);
    assert.deepEqual(parsed.errors, []);
    return parsed.fileNames;
  }
  const app = inputs("tsconfig.json");
  const tools = inputs("tsconfig.tools.json");
  for (const path of ["ops/record-deployment.ts", "ops/prototype-release.ts", "ops/replay-redaction-registry.ts", "tests/e2e/report-review.e2e.ts"]) {
    assert.ok(!app.includes(join(root, path)), `${path} must not become a Next build root`);
    assert.ok(tools.includes(join(root, path)), `${path} must remain typechecked`);
  }
});

test("test and coverage use the same inventory, including all existing ops suites", () => {
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(scripts["test:ops"], "node ops/run-node-tests.mjs");
  assert.ok(scripts.test.endsWith("&& npm run test:ops"));
  assert.ok(scripts["test:coverage"].endsWith("&& npm run test:ops"));
  for (const path of ["ops/aws/gen-env.node-test.mjs", "ops/cleanup-merged-branches.node-test.mjs", "ops/multica-task-watch.node-test.mjs", "ops/p0-forward-observation.node-test.mjs", "ops/run-node-tests.node-test.mjs"]) {
    assert.ok(discoverNodeTests(root).includes(path), path);
  }
});

test("discovers nested tests deterministically, ignores other files and symlinks, rejects an empty inventory", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ia-node-test-inventory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "ops", "nested"), { recursive: true });
  assert.throws(() => discoverNodeTests(dir), /No ops Node tests/);
  for (const path of ["ops/z.node-test.mjs", "ops/nested/a.node-test.mjs", "ops/ignored.test.ts", "outside.node-test.mjs"]) writeFileSync(join(dir, path), "");
  symlinkSync(join(dir, "ops"), join(dir, "ops", "loop"), "dir");
  symlinkSync(join(dir, "outside.node-test.mjs"), join(dir, "ops", "linked.node-test.mjs"));
  assert.deepEqual(discoverNodeTests(dir), ["ops/nested/a.node-test.mjs", "ops/z.node-test.mjs"]);
});

test("preserves failures and signal exits instead of reporting a successful suite", () => {
  for (const [status, expected] of [[0, 0], [1, 1], [7, 7], [null, 1]]) {
    assert.equal(runNodeTests(root, (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ["--test", ...discoverNodeTests(root)]);
      assert.equal(options.cwd, root);
      assert.equal(options.stdio, "inherit");
      return { status };
    }), expected);
  }
  const error = new Error("spawn failed");
  assert.throws(() => runNodeTests(root, () => ({ error, status: null })), (actual) => actual === error);
});
