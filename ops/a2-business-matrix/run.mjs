import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "../aws/security-release-gate.mjs";
import { releasePolicy as policy, makeLegacyFixture, historicalRevision, oldRevision } from "../aws/a2-compatibility-source.mjs";
import { assertPolicy, assertContainer, image, revision, manifest } from "./contracts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const harness = fileURLToPath(new URL("./", import.meta.url)).replace(/\/$/, "");
const hash = data => createHash("sha256").update(data).digest("hex");
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// Only these host values can reach Docker's client; container env is separately generated from scratch.
const hostEnv = { PATH: process.env.PATH };
function docker(args, timeout = 60_000) {
  const result = spawnSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], { env: hostEnv, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
  // Never include commands, raw inspect, env-file bytes, auth responses or arbitrary subprocess logs in failures.
  if (result.error || result.status !== 0) {
    const locations = [...(result.stderr ?? "").matchAll(/\/matrix\/[a-z-]+\.mjs:\d+:\d+/g)].map(m => m[0]);
    throw new Error(`isolated Docker ${args[0]} failed (status ${result.status}, signal ${result.signal ?? "none"}; ${locations.join(",")})`);
  }
  return result.stdout.trim();
}
export async function runMatrix() {
  assertPolicy(policy);
  const directory = mkdtempSync(join(tmpdir(), "a2-business-matrix-"));
  const owner = `a2-business-${randomBytes(10).toString("hex")}`, volumes = [], containers = [];
  const labelKey = "org.insight-agent.a2-business-owner";
  const event = process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)) : null;
  const candidateHead = event?.pull_request?.head?.sha ?? git(["rev-parse", "HEAD"]);
  assert.match(candidateHead, /^[a-f0-9]{40}$/);
  const evidence = { schema_version: "a2-same-image-business-matrix-v1", owner, started_at: new Date().toISOString(),
    tool: { base: git(["merge-base", "HEAD", "origin/main"]), head: candidateHead, tested: git(["rev-parse", "HEAD"]),
      github_head: event?.pull_request?.head?.sha ?? null, run_id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      harness_sha256: hash(["contracts.mjs", "in-image.mjs", "fixture.mjs", "http-probe.mjs", "failure-probe.mjs", "run.mjs"].map(name => `${name}:${hash(readFileSync(join(harness, name)))}`).join("\n")) },
    stages: [], failures: [], production_compatibility: "unverified", cross_version_safe_rollback: "unapproved", safe_rollback: null, deployment_permitted: false, rollback_permitted: false };
  try {
    // Existing gate owns registry verification, pull/save and frozen compose. No mutable tag is used to run containers.
    evidence.identity = await preflight({ policy, request: { image_tag: `sha-${revision}`, approved_index_digest: policy.index_digest,
      approved_manifest_digest: manifest, approved_config_digest: policy.config_digest },
      run: (command, args, options) => {
        assert.equal(command, "docker");
        const result = spawnSync(command, args, { ...options, env: { ...hostEnv, DOCKER_HOST: "unix:///var/run/docker.sock", INSIGHT_IMAGE: image, GIT_SHA: revision, INSIGHT_IMAGE_DIGEST: manifest },
          encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
        if (result.error || result.status !== 0) throw new Error("existing identity preflight Docker phase failed");
        return result.stdout;
      } });
    const imageInfo = JSON.parse(docker(["image", "inspect", image]))[0];
    const synthetic = { AUTH_SECRET: randomBytes(32).toString("hex"), ADMIN_EMAIL: "admin@a2.example.test", ADMIN_PASSWORD: randomBytes(24).toString("hex"),
      A2_VIEWER_PASSWORD: randomBytes(24).toString("hex"), PROVENANCE_SCHEMA_REQUIRED: "1", PROVENANCE_DEPLOYMENT_REQUIRED: "1",
      GIT_SHA: revision, INSIGHT_IMAGE_DIGEST: manifest, HOSTNAME: "127.0.0.1", STALENESS_ALERT_HOURS: "1000000", DEPLOY_ACTOR: "a2-synthetic-business-matrix" };
    const envPath = join(directory, "synthetic.env");
    writeFileSync(envPath, Object.entries(synthetic).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
    const envKeys = new Set([...imageInfo.Config.Env.map(pair => pair.split("=", 1)[0]), ...Object.keys(synthetic)]);
    const v46 = makeLegacyFixture(join(directory, "v46"), historicalRevision), v47 = makeLegacyFixture(join(directory, "v47"), oldRevision);
    for (const [name, fixture, count] of [["v46", v46, 46], ["v47", v47, 47]]) {
      // The helper has a real versioned historical source; verify ledger before any image upgrades it.
      const Database = (await import("better-sqlite3")).default, db = new Database(fixture.path, { readonly: true });
      const ledger = db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all();
      const expected = JSON.parse(readFileSync(join(root, "tests/fixtures/c3-v47-migration-checksums.json"))).ledger.slice(0, count);
      assert.deepEqual(ledger, expected); db.close();
      evidence[name] = { source_revision: fixture.source_revision, schema_migrations: count, database_sha256: fixture.sha256, ledger_sha256: hash(JSON.stringify(ledger)) };
    }
    function volumeFor(stage) {
      const volume = `${owner}-${stage}`; docker(["volume", "create", "--label", `${labelKey}=${owner}`, volume]); volumes.push(volume);
      // Root exists solely to set ownership of the newly created empty volume, never to run the application.
      docker(["run", "--rm", "--pull=never", "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop=ALL", "--cap-add=CHOWN", "--security-opt", "no-new-privileges", "--user", "0",
        "--mount", `type=volume,src=${volume},dst=/data`, image, "node", "-e", "require('node:fs').chownSync('/data',1001,1001)"]);
      return volume;
    }
    function baseArgs(volume) {
      return ["--pull=never", "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--memory", "768m", "--cpus", "2",
        "--tmpfs", "/tmp:rw,mode=1777", "--env-file", envPath, "--label", `${labelKey}=${owner}`,
        "--mount", `type=volume,src=${volume},dst=/data`, "--mount", `type=bind,src=${harness},dst=/matrix,readonly`];
    }
    function oneShot(volume, command) { return docker(["run", "--rm", ...baseArgs(volume), image, ...command], 90_000); }
    function copyLegacy(volume, fixture) {
      docker(["run", "--rm", ...baseArgs(volume), "--mount", `type=bind,src=${fixture.path},dst=/matrix-legacy.db,readonly`, image,
        "node", "-e", "require('node:fs').copyFileSync('/matrix-legacy.db','/data/insight.db')"]);
    }
    function app(volume, stage) {
      const name = `${owner}-${stage}`;
      const id = docker(["create", "--name", name, ...baseArgs(volume), image]); containers.push(id);
      const binding = { owner, volume, harness, envKeys };
      const inspect = () => assertContainer(JSON.parse(docker(["inspect", id]))[0], binding);
      const start = inspect(); docker(["start", id]);
      return { id, start, inspect, probe: phase => JSON.parse(docker(["exec", id, "node", "/matrix/http-probe.mjs", phase], 100_000)) };
    }
    for (const [stage, legacy] of [["fresh", null], ["v46", v46], ["v47", v47]]) {
      const volume = volumeFor(stage);
      if (legacy) copyLegacy(volume, legacy);
      oneShot(volume, ["node", "/app/ops/run-provenance-migrations.mjs"]);
      oneShot(volume, ["node", "/app/ops/record-deployment.mjs"]);
      const running = app(volume, stage);
      const ready = running.probe("ready");
      // Seed AFTER getDb initialization: unknown effect tests current reader refusal before startup recovery.
      const fixture = JSON.parse(docker(["exec", running.id, "node", "/matrix/fixture.mjs"]));
      const matrix = running.probe("matrix");
      const beforeRestart = running.inspect(); docker(["restart", "--time", "10", running.id]);
      const restart = running.probe("restart"), end = running.inspect();
      assert.equal(end.id, running.start.id); assert.equal(end.image, running.start.image);
      evidence.stages.push({ stage, container_start: running.start, container_before_restart: beforeRestart, container_end: end, ready, fixture, matrix, restart });
      docker(["stop", "--time", "10", running.id]);
    }
    for (const kind of ["checksum", "record", "unmigrated-v47"]) {
      const volume = volumeFor(`failure-${kind}`);
      if (kind === "unmigrated-v47") copyLegacy(volume, v47);
      else { oneShot(volume, ["node", "/app/ops/run-provenance-migrations.mjs"]); oneShot(volume, ["node", "/app/ops/record-deployment.mjs"]); }
      const preparation = JSON.parse(oneShot(volume, ["node", "/matrix/failure-probe.mjs", "prepare", kind]));
      if (kind === "checksum") assert.throws(() => oneShot(volume, ["node", "/app/ops/run-provenance-migrations.mjs"]), /Docker run failed/);
      const running = app(volume, `failure-${kind}`);
      const result = JSON.parse(docker(["exec", running.id, "node", "/matrix/failure-probe.mjs", "probe", kind], 60_000));
      evidence.failures.push({ kind, container_start: running.start, preparation, result, container_end: running.inspect() });
      docker(["stop", "--time", "10", running.id]);
    }
    evidence.finished_at = new Date().toISOString(); evidence.result = "pass";
    return evidence;
  } finally {
    // Cleanup only exact resources whose ownership was created in this call. Never prune or inspect other sessions.
    for (const id of containers) {
      const inspected = JSON.parse(docker(["inspect", id]))[0]; assert.equal(inspected.Config.Labels[labelKey], owner); docker(["rm", "--force", id]);
    }
    for (const volume of volumes) {
      const inspected = JSON.parse(docker(["volume", "inspect", volume]))[0]; assert.equal(inspected.Labels[labelKey], owner); docker(["volume", "rm", volume]);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runMatrix()));
