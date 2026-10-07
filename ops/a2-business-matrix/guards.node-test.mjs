import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertPolicy, assertContainer, assertHttpPath, assertStatus, assertVisible, assertWriter, assertBusinessReady, revision, manifest, config, image } from "./contracts.mjs";

const policy = JSON.parse(readFileSync(new URL("../aws/security-release-policy.json", import.meta.url)));
test("freeze all policy identities and preserve null rollback", () => {
  assertPolicy(policy);
  for (const key of ["revision", "index_digest", "manifest_digest", "config_digest", "compose_sha256", "repository", "platform"]) {
    assert.throws(() => assertPolicy({ ...policy, [key]: "wrong" }));
  }
  assert.throws(() => assertPolicy({ ...policy, deployment: { ...policy.deployment, safe_rollback: {} } }));
});
const binding = { owner: "synthetic-owner", volume: "synthetic-volume", harness: "/synthetic/harness" };
function inspect() {
  const env = ["PROVENANCE_SCHEMA_REQUIRED=1", "PROVENANCE_DEPLOYMENT_REQUIRED=1", `GIT_SHA=${revision}`, `INSIGHT_IMAGE_DIGEST=${manifest}`, "HOSTNAME=127.0.0.1", "STALENESS_ALERT_HOURS=1000000"];
  return { Id: "synthetic-id", Image: config, Config: { Image: image, Cmd: ["node", "server.js"], Entrypoint: ["docker-entrypoint.sh"], User: "app", Env: env,
    Labels: { "org.opencontainers.image.revision": revision, "org.insight-agent.a2-business-owner": binding.owner } },
  HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Privileged: false, PortBindings: {} },
  Mounts: [{ Type: "volume", Destination: "/data", Name: binding.volume, RW: true }, { Type: "bind", Destination: "/matrix", Source: binding.harness, RW: false }] };
}
function check(value) { return assertContainer(value, { ...binding, envKeys: inspect().Config.Env.map(pair => pair.split("=", 1)[0]) }); }
test("valid isolated inspect is sanitized", () => { assert.equal(check(inspect()).network, "none"); assert.ok(!("env" in check(inspect()))); });
for (const [name, mutation] of [
  ["entrypoint substitution", x => { x.Config.Entrypoint = null; }],
  ["wrong config", x => { x.Image = "sha256:wrong"; }], ["mutable tag", x => { x.Config.Image = `${image.split("@")[0]}:latest`; }],
  ["wrong revision", x => { x.Config.Labels["org.opencontainers.image.revision"] = "wrong"; }],
  ["source replacement", x => { x.Mounts.push({ Type: "bind", Destination: "/app/server.js", Source: "/local/server.js", RW: false }); }],
  ["external network", x => { x.HostConfig.NetworkMode = "bridge"; }], ["Docker socket", x => { x.Mounts.push({ Type: "bind", Destination: "/var/run/docker.sock" }); }],
  ["public port", x => { x.HostConfig.PortBindings = { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] }; }],
  ["writable bundle", x => { x.HostConfig.ReadonlyRootfs = false; }], ["root", x => { x.Config.User = "0"; }],
  ["ambient cloud credential", x => { x.Config.Env.push("AWS_ACCESS_KEY_ID=synthetic-rejected"); }],
  ["ambient model credential", x => { x.Config.Env.push("LLM_API_KEY=synthetic-rejected"); }],
  ["deployment writer bypass", x => { x.Config.Env.push("PROVENANCE_DEPLOYMENT_WRITER=1"); }],
  ["strict disabled", x => { x.Config.Env[0] = "PROVENANCE_SCHEMA_REQUIRED=0"; }],
]) test(`inspect refuses ${name}`, () => { const x = inspect(); mutation(x); assert.throws(() => check(x)); });
test("all costly/external routes and remote origins are rejected before fetch", () => {
  for (const p of ["/api/cron", "/api/internal/generation-dispatch", "/api/topics/t/brief", "/api/topics/t/deep-dive", "/api/reports/r/followup", "/api/admin/sources/s/collect", "/api/admin/runs/r/retry", "/api/admin/generation-traces/t/retry", "https://example.test/api/reports", "//example.test/api/reports"]) {
    for (const method of ["GET", "POST"]) assert.throws(() => assertHttpPath(method, p));
  }
  assertHttpPath("POST", "/api/leads/lead_exact"); assertHttpPath("GET", "/reports/rep_exact");
});
test("SQL fixture cannot claim actual HTTP business writer", () => {
  const good = { origin: "http", response_status: 200, trace_id: "t", requested_status: "watching", persisted_status: "watching", persisted_trace_id: "t", events: 2, released_lease: true };
  assertWriter(good);
  for (const patch of [{ origin: "sql" }, { persisted_trace_id: "other" }, { events: 0 }, { persisted_status: "recommended" }, { released_lease: false }]) assert.throws(() => assertWriter({ ...good, ...patch }));
});
test("permission bypass and broadened reader projection fail the actual probe assertions", () => {
  for (const expected of [401, 403, 404, 409, 422]) assert.throws(() => assertStatus(200, expected));
  assertVisible(["good"], ["good"]);
  for (const ids of [["good", "blocked"], ["good", "unchecked"], []]) assert.throws(() => assertVisible(ids, ["good"]));
});
test("health cannot mask business failure or notification eligibility", () => {
  const health = { status: 200, body: { status: "ok", data: { stale: false, staleDailyTopicCount: 0 } } };
  assertBusinessReady(health, { status: 200 });
  assert.throws(() => assertBusinessReady(health, { status: 500 }));
  assert.throws(() => assertBusinessReady({ ...health, body: { ...health.body, data: { stale: true, staleDailyTopicCount: 1 } } }, { status: 200 }));
});
