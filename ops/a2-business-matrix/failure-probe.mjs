import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { assertHttpPath, assertStatus } from "./contracts.mjs";
import { dbAt, hash, bundleIdentity } from "./in-image.mjs";

const [operation, kind] = process.argv.slice(2);
const db = dbAt();
const preserved = () => ({ ledger: db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all(),
  topics: db.prepare("SELECT * FROM topic ORDER BY id").all(), runs: db.prepare("SELECT * FROM run ORDER BY id").all(),
  reports: db.prepare("SELECT * FROM report ORDER BY id").all() });
if (operation === "prepare") {
  if (kind === "checksum") db.prepare("UPDATE schema_migration SET checksum=? WHERE version='20261004_48_model_usage_attempt'").run("f".repeat(64));
  else if (kind === "record") db.prepare("UPDATE deployment_record SET image_digest=?").run(`sha256:${"f".repeat(64)}`);
  else assert.equal(kind, "unmigrated-v47");
  writeFileSync("/data/matrix-failure-before.json", JSON.stringify(preserved()));
  console.log(JSON.stringify({ operation, kind, preserved_sha256: hash(JSON.stringify(preserved())), bundle: bundleIdentity() }));
} else if (operation === "probe") {
  // A CSRF response proves the actual HTTP server is listening independently from DB initialization.
  let csrf;
  for (let n = 0; n < 45; n++) {
    try { assertHttpPath("GET", "/api/auth/csrf"); csrf = await fetch("http://127.0.0.1:3000/api/auth/csrf", { signal: AbortSignal.timeout(3000) }); if (csrf.status === 200) break; } catch { /* bounded startup */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assertStatus(csrf?.status, 200);
  assertHttpPath("GET", "/api/health");
  const health = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(5000) });
  assertStatus(health.status, 500); assert.deepEqual(await health.json(), { status: "error", error: "health check failed" });
  // Login opens the same strict getDb path. The error must not establish an authenticated writer.
  const jar = new Map();
  for (const raw of csrf.headers.getSetCookie()) { const pair = raw.split(";", 1)[0], at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  const csrfBody = await csrf.json(); assertHttpPath("POST", "/api/auth/callback/credentials");
  const signed = await fetch("http://127.0.0.1:3000/api/auth/callback/credentials", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: new URLSearchParams({ csrfToken: csrfBody.csrfToken, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
  assert.ok(!signed.headers.getSetCookie().some(raw => /^(?:__Secure-)?authjs\.session-token[^=]*=.+/.test(raw.split(";", 1)[0])), "failed initialization cannot authorize a session");
  assertHttpPath("GET", "/api/reports");
  const read = await fetch("http://127.0.0.1:3000/api/reports", { signal: AbortSignal.timeout(5000) }); assertStatus(read.status, 401);
  assert.deepEqual(preserved(), JSON.parse(readFileSync("/data/matrix-failure-before.json")));
  console.log(JSON.stringify({ operation, kind, http_listening: true, health: 500, authenticated_business: "unavailable-strict-initialization-failed", anonymous_reports: 401,
    data_preserved_sha256: hash(JSON.stringify(preserved())), bundle: bundleIdentity() }));
} else throw new Error("unknown failure operation");
db.close();
