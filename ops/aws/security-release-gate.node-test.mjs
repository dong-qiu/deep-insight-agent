import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import { preflight, main } from "./security-release-gate.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = parse(readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8"));
const policyPath = join(root, "ops/aws/security-release-policy.json");
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const bytes = value => Buffer.from(JSON.stringify(value));
const services = ["app", "cron", "generation-dispatch-worker", "migrate", "deployment-record"];
const forbidden = /\b(?:aws|ssm|stop|up|restart|backup-db|run-provenance-migrations|deployment-record|prune)\b/;

// Real tar bytes, not a replacement for the production archive parser.
function tar(entries) {
  const blocks = [];
  for (const { name, body = Buffer.alloc(0), type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    header.write("0000600\0", 100);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write("ustar\0", 257);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function fixture(change = () => {}) {
  const f = { calls: [], config: { os: "linux", architecture: "amd64", config: { Labels: {
    "org.opencontainers.image.revision": "a".repeat(40), "org.insight-agent.p1-dashboard-admission": "isolated",
  } } }, composeBytes: Buffer.from("services: synthetic\n") };
  f.policy = { schema_version: "security-release-identity-v1", repository: "ghcr.io/dong-qiu/deep-insight-agent",
    revision: "a".repeat(40), platform: "linux/amd64", compose_sha256: hash(f.composeBytes).slice(7),
    deployment: { status: "blocked", safe_rollback: null } };
  f.configBytes = bytes(f.config);
  f.manifest = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: hash(f.configBytes), size: f.configBytes.length, mediaType: "application/vnd.oci.image.config.v1+json" }, layers: [] };
  f.manifestBytes = bytes(f.manifest);
  f.index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{
    digest: hash(f.manifestBytes), size: f.manifestBytes.length, mediaType: f.manifest.mediaType,
    platform: { os: "linux", architecture: "amd64" },
  }] };
  f.indexBytes = bytes(f.index);
  Object.assign(f.policy, { index_digest: hash(f.indexBytes), manifest_digest: hash(f.manifestBytes), config_digest: hash(f.configBytes) });
  f.request = { image_tag: `sha-${f.policy.revision}`, approved_index_digest: f.policy.index_digest,
    approved_manifest_digest: f.policy.manifest_digest, approved_config_digest: f.policy.config_digest };
  f.image = `${f.policy.repository}@${f.policy.manifest_digest}`;
  f.inspect = [{ Id: f.policy.index_digest, Os: "linux", Architecture: "amd64", RepoDigests: [f.image], Config: f.config.config }];
  f.compose = { services: Object.fromEntries(services.map(s => [s, { image: f.image }])) };
  f.entries = [{ name: "manifest.json", body: bytes([{ Config: `${f.policy.config_digest.slice(7)}.json`, Layers: [] }]) },
    { name: `${f.policy.config_digest.slice(7)}.json`, body: f.configBytes }];
  change(f);
  f.readObject = async (kind, ref) => {
    f.calls.push(["registry", kind, ref]);
    return { body: f[`${kind}Bytes`] };
  };
  f.readCompose = async () => { f.calls.push(["source-compose"]); return f.composeBytes; };
  f.run = (command, args, options = {}) => {
    f.calls.push([command, ...args]);
    assert.deepEqual(args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
    assert.equal(options.env.DOCKER_CONTEXT, undefined);
    assert.equal(options.env.DOCKER_HOST, "unix:///var/run/docker.sock");
    args = args.slice(2);
    if (f.failCommand === args[0]) throw new Error("synthetic command failure");
    if (args[0] === "version") return JSON.stringify({ Version: "29.5.3", ApiVersion: f.apiVersion ?? "1.54" });
    if (args[0] === "pull") {
      assert.deepEqual(args, ["pull", "--platform", "linux/amd64", f.image]);
      return "";
    }
    if (args[0] === "image" && args[1] === "inspect") return JSON.stringify(f.inspect);
    if (args[0] === "image" && args[1] === "save") {
      assert.equal(args.at(-1), f.image);
      writeFileSync(args[args.indexOf("--output") + 1], tar(f.entries));
      return "";
    }
    if (args[0] === "compose" && args[1] === "version") return "2.40.0\n";
    if (args[0] === "compose") {
      assert.ok(args.includes("--env-file"));
      assert.equal(args.at(-3), "config");
      assert.equal(options.env.INSIGHT_IMAGE, f.image);
      assert.equal(options.env.COMPOSE_FILE, undefined);
      assert.equal(options.env.COMPOSE_ENV_FILES, undefined);
      assert.equal(readFileSync(join(options.cwd, ".env.local"), "utf8"), "");
      return JSON.stringify(f.compose);
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return f;
}

const verify = f => preflight(f);
const noWriters = f => assert.ok(f.calls.filter(c => c[0] === "docker").every(c => !forbidden.test(c.slice(1).join(" "))), JSON.stringify(f.calls));

function refreshChain(f) {
  f.configBytes = bytes(f.config);
  f.manifest.config.digest = hash(f.configBytes);
  f.manifest.config.size = f.configBytes.length;
  f.manifestBytes = bytes(f.manifest);
  f.index.manifests[0].digest = hash(f.manifestBytes);
  f.index.manifests[0].size = f.manifestBytes.length;
  f.indexBytes = bytes(f.index);
  for (const kind of ["index", "manifest", "config"]) {
    f.policy[`${kind}_digest`] = f.request[`approved_${kind}_digest`] = hash(f[`${kind}Bytes`]);
  }
}

for (const [name, change] of [
  ["registry config revision wrong despite consistent hashes", f => { f.config.config.Labels["org.opencontainers.image.revision"] = "b".repeat(40); refreshChain(f); }],
  ["registry config platform wrong despite consistent hashes", f => { f.config.architecture = "arm64"; refreshChain(f); }],
  ["registry config forbidden dashboard admission", f => { f.config.config.Labels["org.insight-agent.p1-dashboard-admission"] = "enabled"; refreshChain(f); }],
  ["missing config descriptor", f => { delete f.manifest.config; f.manifestBytes = bytes(f.manifest); f.index.manifests[0].digest = hash(f.manifestBytes); f.index.manifests[0].size = f.manifestBytes.length; f.indexBytes = bytes(f.index); f.policy.manifest_digest = f.request.approved_manifest_digest = hash(f.manifestBytes); f.policy.index_digest = f.request.approved_index_digest = hash(f.indexBytes); }],
  ["unverified vulnerable rollback policy", f => { f.policy.deployment.safe_rollback = { revision: "b199bc0381a1ebd2b50fde0e68819e0b884a4383" }; }],
  ["policy attempts deployment permit", f => { f.policy.deployment.status = "ready"; }],
]) {
  test(`reject before actual pull: ${name}`, async () => {
    const f = fixture(change);
    await assert.rejects(verify(f));
    assert.equal(f.calls.filter(c => c[0] === "docker").length, 0);
  });
}

test("save supports OCI blob config paths without treating Docker ID as config digest", async () => {
  const f = fixture(f => {
    f.entries[1].name = `blobs/sha256/${f.policy.config_digest.slice(7)}`;
    f.entries[0].body = bytes([{ Config: f.entries[1].name, Layers: [] }]);
  });
  assert.equal((await verify(f)).immutable_image, f.image);
});

test("registry tag drift after verified index cannot change the object actually pulled or compose-bound", async () => {
  const f = fixture();
  f.readCompose = async () => { f.indexBytes = Buffer.from("tag changed after verification"); return f.composeBytes; };
  const evidence = await verify(f);
  assert.equal(evidence.immutable_image, f.image);
  assert.equal(f.calls.filter(c => c[0] === "registry" && c[1] === "index").length, 1);
  assert.equal(f.calls.filter(c => c[0] === "docker" && c.includes("pull")).length, 1);
  noWriters(f);
});

test("frozen policy identities match evidence and exact candidate compose, without becoming deployment approval", () => {
  const policy = JSON.parse(readFileSync(policyPath));
  const readiness = readFileSync(join(root, "docs/verify/c-security-release-readiness-2026-10-07.md"), "utf8");
  for (const field of ["revision", "index_digest", "manifest_digest", "config_digest"]) assert.ok(readiness.includes(policy[field]));
  const result = spawnSync("git", ["show", `${policy.revision}:docker-compose.yml`], { cwd: root });
  assert.equal(result.status, 0);
  assert.equal(hash(result.stdout).slice(7), policy.compose_sha256);
  assert.equal(policy.deployment.status, "blocked");
  assert.equal(policy.deployment.safe_rollback, null);
});

test("approved chain pulls and binds manifest, config proof does not compare Docker ID with config", async () => {
  const f = fixture();
  const result = await verify(f);
  assert.equal(result.immutable_image, f.image);
  assert.equal(result.config_digest, f.policy.config_digest);
  assert.equal(result.deployment_permitted, false);
  assert.deepEqual(Object.keys(result.services).sort(), services.sort());
  noWriters(f);
});

for (const field of ["image_tag", "approved_index_digest", "approved_manifest_digest", "approved_config_digest"]) {
  for (const value of [undefined, "", "latest", "sha256:" + "G".repeat(64), "sha256:" + "0".repeat(64)]) {
    test(`reject missing/illegal/unapproved ${field}: ${String(value).slice(0, 15)}`, async () => {
      const f = fixture(f => { f.request[field] = value; });
      await assert.rejects(verify(f));
      assert.equal(f.calls.length, 0);
    });
  }
}

for (const [name, change] of [
  ["tag resolves to drifted index", f => { f.indexBytes = Buffer.from("drift"); }],
  ["wrong platform in index", f => { f.index.manifests[0].platform.architecture = "arm64"; f.indexBytes = bytes(f.index); f.policy.index_digest = f.request.approved_index_digest = hash(f.indexBytes); }],
  ["duplicate amd64 descriptors", f => { f.index.manifests.push(f.index.manifests[0]); f.indexBytes = bytes(f.index); f.policy.index_digest = f.request.approved_index_digest = hash(f.indexBytes); }],
  ["descriptor manifest digest mismatch", f => { f.index.manifests[0].digest = hash("other"); f.indexBytes = bytes(f.index); f.policy.index_digest = f.request.approved_index_digest = hash(f.indexBytes); }],
  ["descriptor size mismatch", f => { f.index.manifests[0].size++; f.indexBytes = bytes(f.index); f.policy.index_digest = f.request.approved_index_digest = hash(f.indexBytes); }],
  ["manifest bytes mismatch", f => { f.manifestBytes = bytes({ other: true }); }],
  ["config bytes mismatch", f => { f.configBytes = bytes({ other: true }); }],
  ["config revision mismatch", f => { f.config.config.Labels["org.opencontainers.image.revision"] = "b".repeat(40); }],
  ["pulled inspect revision mismatch", f => { f.inspect[0].Config = { Labels: { "org.opencontainers.image.revision": "b".repeat(40) } }; }],
  ["pulled inspect platform mismatch", f => { f.inspect[0].Architecture = "arm64"; }],
  ["pulled RepoDigest wrong object", f => { f.inspect[0].RepoDigests = [`${f.policy.repository}@${f.policy.index_digest}`]; }],
  ["saved local config not approved", f => { f.entries[1].body = bytes({ os: "linux", architecture: "amd64", other: "wrong image" }); }],
  ["saved manifest has multiple images", f => { f.entries[0].body = bytes([{ Config: f.entries[1].name }, { Config: f.entries[1].name }]); }],
  ["saved duplicate config", f => { f.entries.push(f.entries[1]); }],
  ["saved config is symlink", f => { f.entries[1].type = "2"; }],
  ["archive traversal", f => { f.entries.push({ name: "../escape", body: Buffer.from("x") }); }],
  ["missing saved config", f => { f.entries.pop(); }],
  ["invalid saved JSON", f => { f.entries[0].body = Buffer.from("{"); }],
  ["oversize saved manifest", f => { f.entries[0].body = Buffer.alloc(1024 * 1024 + 1); }],
  ["unknown Docker API", f => { f.apiVersion = "1.47"; }],
  ["compose bytes not frozen", f => { f.composeBytes = Buffer.from("other compose"); }],
  ...services.map(s => [`${s} switches back to tag after verification`, f => { f.compose.services[s].image = `${f.policy.repository}:${f.request.image_tag}`; }]),
  ["worker points to another digest", f => { f.compose.services["generation-dispatch-worker"].image = `${f.policy.repository}@${hash("other")}`; }],
  ["compose requests wrong platform", f => { f.compose.services.cron.platform = "linux/arm64"; }],
  ["required service missing", f => { delete f.compose.services.cron; }],
  ["pull throws", f => { f.failCommand = "pull"; }],
  ["save throws", f => { f.failCommand = "image"; }],
]) {
  test(`fail closed: ${name}`, async () => {
    const f = fixture(change);
    await assert.rejects(verify(f));
    noWriters(f);
  });
}

test("CLI report is identity-only; failures cannot publish state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ia-release-test-"));
  try {
    const f = fixture();
    const output = join(dir, "identity.json");
    const env = Object.fromEntries(Object.entries(f.request).map(([k, v]) => [k === "image_tag" ? "REQUESTED_IMAGE_TAG" : k.toUpperCase(), v]));
    await main([output], env, f);
    assert.equal(JSON.parse(readFileSync(output)).deployment_permitted, false);
    await assert.rejects(main([output], { ...env, APPROVED_CONFIG_DIGEST: "" }, f));
    assert.throws(() => readFileSync(output), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actual workflow requires four explicit inputs, calls CLI and has no production capability in any step", () => {
  const job = workflow.jobs.deploy;
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(job.if, /github\.ref/);
  assert.equal(job.environment, "production");
  for (const key of ["image_tag", "approved_index_digest", "approved_manifest_digest", "approved_config_digest"]) {
    assert.equal(workflow.on.workflow_dispatch.inputs[key].required, true);
  }
  const gate = job.steps.find(s => s.id === "identity");
  assert.match(gate.run, /node ops\/aws\/security-release-gate\.mjs/);
  assert.equal(gate.env.APPROVED_INDEX_DIGEST, "${{ inputs.approved_index_digest }}");
  const allSteps = job.steps.map(s => JSON.stringify(s)).join("\n");
  assert.doesNotMatch(allSteps, /configure-aws|send-command|cancel-command|id-token|AWS_REGION|PROD_INSTANCE|docker (?:run|tag|compose.*(?:up|stop))/);
  assert.ok(job.steps.indexOf(gate) < job.steps.findIndex(s => s.id === "hold"));
});

for (const state of ["no rollback", "old vulnerable rollback", "concurrent maintenance", "drain timeout", "SSM unknown", "claimed lease", "ready", "identity verified"]) {
  test(`workflow unconditional hold cannot be unlocked by ${state}`, () => {
    const hold = workflow.jobs.deploy.steps.find(s => s.id === "hold");
    assert.equal(hold.if, "always()");
    const result = spawnSync("bash", ["-c", hold.run], {
      env: { PATH: process.env.PATH, SECURITY_DEPLOY_READY: "1", SAFE_ROLLBACK: state,
        MAINTENANCE_STATE: state, DRAIN_STATE: state, SSM_STATE: state, IDENTITY_VERIFIED: "1" }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /blocked/);
    assert.doesNotMatch(hold.run, /aws|docker|curl|\beval\b/);
  });
}

test("real CLI rejects missing input before Docker, registry or output", () => {
  const result = spawnSync(process.execPath, [join(root, "ops/aws/security-release-gate.mjs")], {
    env: { PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required|missing/i);
});

test("PR CI: real approved GHCR pull/inspect/save/compose gate, followed by immutable deployment hold", {
  skip: process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux" ? "Requires disposable Linux Actions runner with Docker; local mocks are not real pull evidence" : false,
  timeout: 300_000,
}, async () => {
  const policy = JSON.parse(readFileSync(policyPath));
  const dir = mkdtempSync(join(tmpdir(), "ia-release-integration-"));
  try {
    const gate = workflow.jobs.deploy.steps.find(s => s.id === "identity");
    const output = join(dir, "release-identity.json");
    await promisify(execFile)("bash", ["-c", gate.run], { cwd: root, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RUNNER_TEMP: dir, REQUESTED_IMAGE_TAG: `sha-${policy.revision}`, APPROVED_INDEX_DIGEST: policy.index_digest,
        APPROVED_MANIFEST_DIGEST: policy.manifest_digest, APPROVED_CONFIG_DIGEST: policy.config_digest } });
    const evidence = JSON.parse(readFileSync(output));
    assert.equal(evidence.immutable_image, `${policy.repository}@${policy.manifest_digest}`);
    assert.equal(evidence.deployment_permitted, false);
    console.log(JSON.stringify({ real_release_gate: "pass", ...evidence }));
    const hold = workflow.jobs.deploy.steps.find(s => s.id === "hold");
    assert.equal(spawnSync("bash", ["-c", hold.run], { encoding: "utf8" }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
