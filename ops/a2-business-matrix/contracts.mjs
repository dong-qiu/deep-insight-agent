import assert from "node:assert/strict";

export const revision = "4477412a3e2b1cb2764fb4357f2284e73952af67";
export const manifest = "sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c";
export const config = "sha256:d86150f47c0da31e3515e4848b2ed6aa346bfdc825ad718bef6a934370534749";
export const repository = "ghcr.io/dong-qiu/deep-insight-agent";
export const image = `${repository}@${manifest}`;
export function assertPolicy(policy) {
  assert.equal(policy.revision, revision); assert.equal(policy.manifest_digest, manifest);
  assert.equal(policy.config_digest, config); assert.equal(policy.repository, repository);
  assert.equal(policy.platform, "linux/amd64");
  assert.equal(policy.index_digest, "sha256:63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe");
  assert.equal(policy.compose_sha256, "984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd");
  assert.equal(policy.deployment.safe_rollback, null); assert.equal(policy.deployment.status, "blocked");
}
// Inspect is consumed before any Web process or fixture client runs. Never serialize Config.Env.
export function assertContainer(inspected, { owner, volume, harness, envKeys }) {
  assert.equal(inspected.Image, config); assert.equal(inspected.Config.Image, image);
  assert.equal(inspected.Config.Labels["org.opencontainers.image.revision"], revision);
  assert.equal(inspected.Config.Labels["org.insight-agent.a2-business-owner"], owner);
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.ok(inspected.HostConfig.CapDrop.includes("ALL"));
  assert.ok(inspected.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.equal(inspected.HostConfig.Privileged, false);
  assert.ok(["app", "1001", "1001:1001"].includes(inspected.Config.User));
  assert.deepEqual(inspected.HostConfig.PortBindings ?? {}, {});
  assert.deepEqual(inspected.Config.Cmd, ["node", "server.js"]);
  assert.deepEqual(inspected.Config.Entrypoint, ["docker-entrypoint.sh"]);
  assert.deepEqual(inspected.Mounts.map(m => [m.Type, m.Destination, m.Type === "volume" ? m.Name : m.Source, m.RW]).sort(), [
    ["bind", "/matrix", harness, false], ["volume", "/data", volume, true],
  ].sort());
  const keys = inspected.Config.Env.map(pair => pair.split("=", 1)[0]);
  assert.deepEqual([...new Set(keys)].sort(), [...envKeys].sort());
  for (const [key, value] of [["PROVENANCE_SCHEMA_REQUIRED", "1"], ["PROVENANCE_DEPLOYMENT_REQUIRED", "1"],
    ["GIT_SHA", revision], ["INSIGHT_IMAGE_DIGEST", manifest], ["HOSTNAME", "127.0.0.1"], ["STALENESS_ALERT_HOURS", "1000000"]]) {
    assert.ok(inspected.Config.Env.includes(`${key}=${value}`));
  }
  assert.ok(!keys.includes("PROVENANCE_DEPLOYMENT_WRITER"));
  return { id: inspected.Id, image: inspected.Image, requested_image: inspected.Config.Image,
    revision, network: "none", read_only_rootfs: true, user: inspected.Config.User,
    mounts: inspected.Mounts.map(m => ({ type: m.Type, destination: m.Destination, rw: m.RW, ...(m.Name ? { name: m.Name } : {}) })),
    published_ports: {}, command: inspected.Config.Cmd };
}

// This allowlist is used by every probe fetch, including authentication. No worker/generation seams.
export function assertHttpPath(method, path) {
  const url = new URL(path, "http://127.0.0.1:3000");
  assert.equal(url.origin, "http://127.0.0.1:3000"); assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const p = url.pathname;
  const id = "[A-Za-z0-9_-]+";
  const allowed = method === "GET" ? ["/api/health", "/api/auth/csrf", "/api/auth/session", "/api/reports", "/api/admin/users", "/api/leads", "/api/graph/drill", "/reports", "/settings",
    new RegExp(`^/reports/${id}$`), new RegExp(`^/topics/${id}$`), new RegExp(`^/api/leads/${id}$`)]
    : method === "POST" ? ["/api/auth/callback/credentials", "/api/auth/signout", "/api/admin/users", "/api/admin/topics", new RegExp(`^/api/leads/${id}$`)]
      : method === "PUT" ? [new RegExp(`^/api/admin/topics/${id}$`)]
        : method === "DELETE" ? ["/api/admin/users", new RegExp(`^/api/admin/topics/${id}$`)] : [];
  assert.ok(allowed.some(rule => typeof rule === "string" ? p === rule : rule.test(p)), "HTTP path outside zero-model matrix");
}
export function assertStatus(actual, expected) { assert.equal(actual, expected, "HTTP status diverged from matrix"); }
export function assertVisible(actual, expected) { assert.deepEqual([...actual].sort(), [...expected].sort(), "reader whitelist diverged"); }
export function assertWriter(evidence) {
  assert.equal(evidence.origin, "http"); assert.equal(evidence.response_status, 200);
  assert.ok(evidence.trace_id); assert.equal(evidence.persisted_status, evidence.requested_status);
  assert.equal(evidence.persisted_trace_id, evidence.trace_id);
  assert.equal(evidence.events, 2); assert.equal(evidence.released_lease, true);
}
export function assertBusinessReady(health, business) {
  assertStatus(health.status, 200); assert.equal(health.body.status, "ok");
  assert.equal(health.body.data.stale, false); assert.equal(health.body.data.staleDailyTopicCount, 0);
  assertStatus(business.status, 200);
}
