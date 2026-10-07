import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { assessA2 } from "./a2-rollback-contract.mjs";
import { preflight } from "./security-release-gate.mjs";
import { releasePolicy as policy, makeLegacyFixture, historicalRevision, oldRevision, testFrozenSource, verifySourceUpgrade } from "./a2-compatibility-source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const now = Date.parse("2026-10-07T12:00:00.000Z");
const identity = Object.fromEntries(["repository", "revision", "platform", "index_digest", "manifest_digest", "config_digest", "compose_sha256"].map(k => [k, policy[k]]));
function fixture() {
  const context = { operation_id: "synthetic-operation", maintenance_holder: "synthetic-holder", operator: "synthetic-operator",
    schema_sha256: "a".repeat(64), migrations_sha256: "b".repeat(64), configuration_sha256: "c".repeat(64), data_sample_sha256: "d".repeat(64), release: identity };
  const evidence = {};
  for (const [kind, scope, checks] of [
    ["identity", "isolated-runner", ["actual_pull", "compose_binding"]],
    ["security", "isolated-runner", ["native_six", "builder_source_map_magicast", "runtime_source_map", "auth_reader_contract"]],
    ["isolated_compatibility", "synthetic", ["pre_release", "target_new_data", "post_migration", "rollback_read_update", "no_data_loss"]],
    ["production_compatibility", "current-production", ["schema", "configuration", "backup_hash_integrity", "capacity", "no_data_loss"]],
    ["approval", "scoped-authorization", ["operator", "oncall", "reviewer", "approver", "continuous_stop_accepted"]],
  ]) evidence[kind] = { scope, result: "pass", receipt_sha256: "e".repeat(64), issued_at: "2026-10-07T11:00:00.000Z",
    expires_at: "2026-10-07T13:00:00.000Z", binding: { ...context, rollback: identity }, checks: Object.fromEntries(checks.map(k => [k, true])) };
  return structuredClone({ schema_version: "a2-a3-handoff-v1", context, rollback: identity, phase: "before-writer-stop", evidence, a3: { ready: true } });
}
function blocked(input) {
  const result = assessA2(input, policy, now);
  assert.equal(result.deployment_permitted, false);
  assert.equal(result.rollback_permitted, false);
  assert.equal(result.approved_safe_rollback, null);
  assert.equal(result.commands_executed, false);
  assert.equal(result.database_restore_permitted, false);
  return result;
}
test("even complete fixture declarations are never verified or approved", () => {
  const r = blocked(fixture());
  for (const value of Object.values(r.declarations)) assert.deepEqual(value, { structurally_complete: true, verified: false });
  assert.ok(r.blockers.includes("safe_rollback_null_unapproved"));
  assert.ok(r.blockers.includes("a3_protocol_and_execution_evidence_not_verified"));
});
for (const [name, change, expected] of [
  ["missing rollback", f => { f.rollback = null; }, "rollback_missing_or_outside_researched_identity"],
  ["old vulnerable image", f => { f.rollback.revision = "b199bc0381a1ebd2b50fde0e68819e0b884a4383"; }, "rollback_missing_or_outside_researched_identity"],
  ["manifest mismatch", f => { f.rollback.manifest_digest = `sha256:${"f".repeat(64)}`; }, "rollback_missing_or_outside_researched_identity"],
  ["release revision mismatch", f => { f.context.release.revision = "f".repeat(40); }, "release_identity_mismatch"],
  ["post migration incompatible", f => { f.evidence.isolated_compatibility.checks.post_migration = false; }, "isolated_compatibility_missing_stale_or_misbound"],
  ["new data loss", f => { f.evidence.isolated_compatibility.checks.no_data_loss = false; }, "isolated_compatibility_missing_stale_or_misbound"],
  ["synthetic promoted to production", f => { f.evidence.production_compatibility.scope = "synthetic"; }, "production_compatibility_missing_stale_or_misbound"],
  ["missing binding", f => { delete f.context.operation_id; }, "missing_operation_or_data_binding"],
  ["unknown phase", f => { f.phase = "ready"; }, "unknown_execution_phase"],
]) test(`refuse ${name}`, () => { const f = fixture(); change(f); assert.ok(blocked(f).blockers.includes(expected)); });
for (const kind of ["identity", "security", "isolated_compatibility", "production_compatibility", "approval"]) {
  for (const [name, change] of [
    ["absent", f => { delete f.evidence[kind]; }],
    ["expired", f => { f.evidence[kind].expires_at = "2026-10-07T12:00:00.000Z"; }],
    ["future", f => { f.evidence[kind].issued_at = "2026-10-07T12:01:00.000Z"; }],
    ["wrong operation", f => { f.evidence[kind].binding.operation_id = "other"; }],
    ["wrong data sample", f => { f.evidence[kind].binding.data_sample_sha256 = "f".repeat(64); }],
    ["wrong rollback config", f => { f.evidence[kind].binding.rollback.config_digest = "other"; }],
    ["hash absent", f => { delete f.evidence[kind].receipt_sha256; }],
  ]) test(`${kind}: ${name} cannot pass structural assessment`, () => { const f = fixture(); change(f); assert.ok(blocked(f).blockers.includes(`${kind}_missing_stale_or_misbound`)); });
}
for (const phase of ["before-writer-stop", "writers-stopped", "backup", "migration", "deployment-record", "readiness", "rollback-readiness", "unknown"]) {
  test(`failure at ${phase} preserves stop/hold contract`, () => {
    const f = fixture(); f.phase = phase;
    const r = blocked(f);
    assert.equal(r.failure_disposition, phase === "before-writer-stop" ? "abort-before-production-change" : "retain-isolation-and-manual-takeover");
    assert.equal(r.health_is_security_acceptance, false);
    if (phase === "rollback-readiness") assert.ok(r.blockers.includes("rollback_startup_failure_requires_manual_takeover"));
  });
}
test("malformed declarations and falsely ready A3 never authorize", () => {
  for (const input of [null, [], true, {}, { ...fixture(), a3: { ready: true, ssm: "Success", drain: "done" } }]) blocked(input);
  const changedPolicy = structuredClone(policy); changedPolicy.deployment.safe_rollback = identity;
  assert.throws(() => assessA2(fixture(), changedPolicy, now), /unchanged blocked/);
});
test("actual diagnostic CLI stays nonzero and real workflow retains unconditional hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2-cli-"));
  try {
    const input = join(dir, "fixture.json"); writeFileSync(input, JSON.stringify(fixture()));
    const r = spawnSync(process.execPath, [join(root, "ops/aws/a2-rollback-contract.mjs"), input], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).rollback_permitted, false);
    const workflow = parse(readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8"));
    const hold = workflow.jobs.deploy.steps.find(step => step.id === "hold");
    assert.equal(hold.if, "always()");
    assert.equal(spawnSync("bash", ["-c", hold.run], { env: { PATH: process.env.PATH, A2_READY: "1", A3_READY: "1" } }).status, 1);
    assert.equal(policy.deployment.safe_rollback, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("specified 4477412 source compatibility paths (not image or production evidence)", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "a2-source-matrix-"));
  try {
    const result = testFrozenSource(dir);
    console.log(JSON.stringify(result));
    for (const revision of [historicalRevision, oldRevision]) {
      const fixture = makeLegacyFixture(join(dir, revision), revision);
      assert.equal(fixture.source_revision, revision);
      console.log(JSON.stringify(verifySourceUpgrade(dir, fixture)));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Linux PR CI: exact released manifest native and synthetic migration/record matrix", {
  skip: process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux" ? "Requires isolated Linux Actions Docker; local source tests do not prove image compatibility" : false,
  timeout: 480_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2-image-matrix-"));
  try {
    const evidence = await preflight({ policy, request: { image_tag: `sha-${policy.revision}`, approved_index_digest: policy.index_digest,
      approved_manifest_digest: policy.manifest_digest, approved_config_digest: policy.config_digest } });
    const fixture = makeLegacyFixture(join(dir, "v47"));
    const v46Fixture = makeLegacyFixture(join(dir, "v46"), historicalRevision);
    const native = join(dir, "sharp.node-test.mjs"), identityFile = join(dir, "identity.json");
    writeFileSync(native, execFileSync("git", ["show", `${policy.revision}:ops/sharp-security.node-test.mjs`], { cwd: root }));
    writeFileSync(identityFile, JSON.stringify(evidence));
    const output = execFileSync("docker", ["--host", "unix:///var/run/docker.sock", "run", "--rm", "--pull=never", "--platform", policy.platform,
      "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--memory", "768m", "--cpus", "2",
      "--tmpfs", "/data:rw,uid=1001,gid=1001,mode=0700", "--tmpfs", "/tmp:rw,mode=1777",
      "--mount", `type=bind,src=${fixture.path},dst=/app/a2-v47.db,readonly`,
      "--mount", `type=bind,src=${v46Fixture.path},dst=/app/a2-v46.db,readonly`,
      "--mount", `type=bind,src=${identityFile},dst=/app/a2-identity.json,readonly`,
      "--mount", `type=bind,src=${native},dst=/app/ops/a2-sharp-security.node-test.mjs,readonly`,
      "--mount", `type=bind,src=${join(root, "ops/aws/a2-image-probe.mjs")},dst=/app/a2-image-probe.mjs,readonly`,
      evidence.immutable_image, "node", "/app/a2-image-probe.mjs"], {
      encoding: "utf8", timeout: 240_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH },
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.manifest_digest, policy.manifest_digest);
    assert.equal(result.native_six, "pass");
    console.log(JSON.stringify({ ...result, fixture_source: fixture.source_revision, fixture_sha256: fixture.sha256, v46_fixture_source: v46Fixture.source_revision, v46_fixture_sha256: v46Fixture.sha256 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
