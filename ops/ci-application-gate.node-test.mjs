import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertApplicationGate, identityFromEnvironment, laneIdentity } from "./ci-application-gate.mjs";

const identity = { commit: "a".repeat(40), tested_commit: "b".repeat(40), repository: "owner/repo", event: "pull_request", run_id: "123", run_attempt: 1 };
function upstream(expected = identity) {
  return {
    scope: { result: "success", outputs: { mode: "full" } },
    application_checks: { result: "success", outputs: { identity: JSON.stringify(laneIdentity("application", expected)) } },
    ops_checks: { result: "success", outputs: { identity: JSON.stringify(laneIdentity("ops", expected)) } },
  };
}

test("successful lanes must match the candidate, tested merge, repository, event and attempt", () => {
  assert.doesNotThrow(() => assertApplicationGate(upstream(), identity));
  const main = { ...identity, event: "push", tested_commit: identity.commit };
  assert.doesNotThrow(() => assertApplicationGate(upstream(main), main));
  for (const job of ["application_checks", "ops_checks"]) {
    for (const field of Object.keys(identity)) {
      const needs = upstream(), actual = JSON.parse(needs[job].outputs.identity);
      actual[field] = typeof actual[field] === "number" ? 2 : `${actual[field]}x`;
      needs[job].outputs.identity = JSON.stringify(actual);
      assert.throws(() => assertApplicationGate(needs, identity), /identity mismatch/);
    }
  }
});

test("either failed/cancelled/skipped/unknown lane or scope fails closed", () => {
  for (const job of ["scope", "application_checks", "ops_checks"]) {
    for (const result of ["failure", "cancelled", "skipped", "", "unknown", undefined]) {
      const needs = upstream(); needs[job].result = result;
      assert.throws(() => assertApplicationGate(needs, identity));
    }
    const missing = upstream(); delete missing[job]; assert.throws(() => assertApplicationGate(missing, identity));
  }
  for (const mode of ["docs", "unknown", undefined]) {
    const needs = upstream(); needs.scope.outputs.mode = mode;
    assert.throws(() => assertApplicationGate(needs, identity));
  }
});

test("lane outputs cannot be empty, forged as another role or contain extra/missing fields", () => {
  for (const job of ["application_checks", "ops_checks"]) {
    for (const output of [undefined, "", "{", "null", "[]", "{}", upstream().application_checks.outputs.identity.replace('"application"', '"other"')]) {
      const needs = upstream(); needs[job].outputs.identity = output;
      assert.throws(() => assertApplicationGate(needs, identity));
    }
    for (const mutate of [x => { delete x.commit; }, x => { x.extra = "pass"; }, x => { x.run_attempt = "1"; }]) {
      const needs = upstream(), actual = JSON.parse(needs[job].outputs.identity); mutate(actual);
      needs[job].outputs.identity = JSON.stringify(actual); assert.throws(() => assertApplicationGate(needs, identity));
    }
  }
  const swapped = upstream(); swapped.ops_checks.outputs.identity = swapped.application_checks.outputs.identity;
  assert.throws(() => assertApplicationGate(swapped, identity));
});

test("invalid runtime identity is not recordable", () => {
  for (const tweak of [{ commit: "0".repeat(40) }, { tested_commit: "bad" }, { run_attempt: 0 }, { run_attempt: NaN }, { run_id: "0" }, { repository: "repo" }, { event: "workflow_dispatch" }, { event: "push" }]) {
    assert.throws(() => laneIdentity("application", { ...identity, ...tweak }));
  }
  assert.throws(() => laneIdentity("other", identity));
});

test("actual Git/record/verify CLI binds checkout and prevents continuation on failure", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-application-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "ci@example.test"); git("config", "user.name", "CI test");
  writeFileSync(join(cwd, "fixture"), "isolated\n"); git("add", "."); git("commit", "-qm", "fixture");
  const sha = git("rev-parse", "HEAD"), output = join(cwd, "output"), proof = join(cwd, "proof");
  const env = { ...process.env, PROTOTYPE_CI_EVIDENCE_COMMIT: sha, GITHUB_SHA: sha, GITHUB_REPOSITORY: "owner/repo", GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: output };
  const actual = identityFromEnvironment(env, cwd), cli = fileURLToPath(new URL("./ci-application-gate.mjs", import.meta.url));
  for (const lane of ["application", "ops"]) assert.equal(spawnSync(process.execPath, [cli, "record", lane], { cwd, env }).status, 0);
  const rows = readFileSync(output, "utf8").trim().split("\n").map(l => JSON.parse(l.slice("identity=".length)));
  const needs = upstream(actual); needs.application_checks.outputs.identity = JSON.stringify(rows[0]); needs.ops_checks.outputs.identity = JSON.stringify(rows[1]);
  assert.equal(spawnSync(process.execPath, [cli, "verify"], { cwd, env: { ...env, NEEDS_JSON: JSON.stringify(needs) } }).status, 0);
  for (const tweak of [{ GITHUB_SHA: "b".repeat(40) }, { GITHUB_RUN_ATTEMPT: "2" }, { NEEDS_JSON: "{" }]) {
    const result = spawnSync(process.execPath, [cli, "verify"], { cwd, env: { ...env, NEEDS_JSON: JSON.stringify(needs), ...tweak } });
    if (result.status === 0) writeFileSync(proof, "pass");
    assert.notEqual(result.status, 0); assert.equal(existsSync(proof), false);
  }
});
