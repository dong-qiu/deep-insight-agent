import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { encode } from "next-auth/jwt";
import { openDb } from "../../src/lib/db/index.js";
import { upsertUser } from "../../src/lib/db/users.js";

const root = mkdtempSync(join(tmpdir(), "insight-session-revocation-"));
const dbPath = join(root, "db.sqlite"), secret = "session-revocation-test-secret";
let app: ChildProcess | undefined, base = "", port = 0;
type Jar = Map<string, string>;
const cookie = (jar: Jar) => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
function collect(jar: Jar, response: Response) {
  for (const value of response.headers.getSetCookie()) {
    const match = /^([^=;]+)=([^;]*)/.exec(value);
    if (match) jar.set(match[1], match[2]);
  }
}
async function csrf(jar: Jar) {
  const response = await fetch(`${base}/api/auth/csrf`, { headers: { cookie: cookie(jar) } });
  collect(jar, response);
  return (await response.json() as { csrfToken: string }).csrfToken;
}
async function login(email: string, password: string) {
  const jar: Jar = new Map();
  const csrfToken = await csrf(jar);
  const response = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(jar) },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: base }),
  });
  collect(jar, response);
  expect([...jar.keys()].some((key) => key.includes("authjs.session-token"))).toBe(true);
  return jar;
}
function request(path: string, jar: Jar, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, redirect: "manual", headers: { "content-type": "application/json", cookie: cookie(jar), ...init.headers } });
}
async function assertRevoked(jar: Jar) {
  expect((await request("/api/reports", jar)).status).toBe(401);
  const page = await request("/reports", jar);
  expect(page.status).toBe(307);
  expect(new URL(page.headers.get("location")!, base).pathname).toBe("/login");
  const session = await request("/api/auth/session", jar);
  expect((await session.json())?.user).toBeUndefined();
}
async function stop() {
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM"); await exited;
  }
}
async function start(adminPassword: string) {
  app = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "start", "--port", String(port)], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...process.env, DB_PATH: dbPath, DATA_DIR: root, AUTH_SECRET: secret, AUTH_URL: base, NEXTAUTH_URL: base,
      ADMIN_EMAIL: "admin@example.test", ADMIN_PASSWORD: adminPassword, ALERT_WEBHOOK: "",
      PROVENANCE_SCHEMA_REQUIRED: "0", PROVENANCE_DEPLOYMENT_REQUIRED: "0",
      P1_DASHBOARD_ENABLED: "false", P1_ANCHOR_ENABLED: "false", P1_LIFECYCLE_ENABLED: "false" },
  });
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error("session test app exited before readiness");
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("session test app readiness timeout");
}
beforeAll(async () => {
  const db = openDb(dbPath);
  try { upsertUser(db, "legacy-admin@example.test", "legacy-password", "admin"); }
  finally { db.close(); }
  port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  await start("admin-password");
});
afterAll(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });

describe("session revocation through real cookies and HTTP", () => {
  it("rejects changed/deleted/recreated users, role changes, legacy and client-forged session updates", async () => {
    const admin = await login("admin@example.test", "admin-password");
    const save = async (password: string) => {
      expect((await request("/api/admin/users", admin, { method: "POST", body: JSON.stringify({ email: "reader@example.test", password }) })).status).toBe(201);
    };
    await save("old-password");
    const original = await login("reader@example.test", "old-password");
    expect((await request("/api/reports", original)).status).toBe(200);
    const csrfToken = await csrf(original);
    const update = await request("/api/auth/session", original, { method: "POST", body: JSON.stringify({ csrfToken,
      data: { role: "admin", sessionVersion: "a".repeat(64), user: { role: "admin", email: "admin@example.test" } } }) });
    collect(original, update);
    const publicSession = await update.json();
    expect(publicSession.user.role).toBe("viewer");
    expect(publicSession.user.email).toBe("reader@example.test");
    expect(JSON.stringify(publicSession)).not.toMatch(/sessionVersion|password_hash|scrypt\$/);
    expect((await request("/api/admin/users", original)).status).toBe(403);
    await save("new-password");
    await assertRevoked(original);
    const changed = await login("reader@example.test", "new-password");
    expect((await request("/api/reports", changed)).status).toBe(200);
    expect((await request("/api/admin/users?email=reader%40example.test", admin, { method: "DELETE" })).status).toBe(200);
    await assertRevoked(changed);
    await save("new-password");
    await assertRevoked(changed); // same email AND password cannot resurrect its old salted version
    const recreated = await login("reader@example.test", "new-password");
    expect((await request("/api/reports", recreated)).status).toBe(200);

    const legacyAdmin = await login("legacy-admin@example.test", "legacy-password");
    expect((await request("/api/admin/users", legacyAdmin)).status).toBe(200);
    const writer = new Database(dbPath);
    try { writer.prepare("UPDATE app_user SET role='viewer' WHERE email=?").run("legacy-admin@example.test"); }
    finally { writer.close(); }
    await assertRevoked(legacyAdmin);
    expect((await request("/api/admin/users", legacyAdmin)).status).toBe(401);
    const demoted = await login("legacy-admin@example.test", "legacy-password");
    expect((await request("/api/admin/users", demoted)).status).toBe(403);
    expect((await request("/api/reports", demoted)).status).toBe(200);

    const legacyCookie = await encode({ secret, salt: "authjs.session-token",
      token: { sub: "admin", email: "admin@example.test", role: "admin" } });
    await assertRevoked(new Map([["authjs.session-token", legacyCookie]]));

    const unavailable = new Database(dbPath);
    try {
      unavailable.exec("ALTER TABLE app_user RENAME TO temporarily_unavailable_user");
      await assertRevoked(recreated);
      await assertRevoked(admin);
    } finally { unavailable.exec("ALTER TABLE temporarily_unavailable_user RENAME TO app_user"); unavailable.close(); }
    expect((await request("/api/reports", recreated)).status).toBe(200);
    expect((await request("/api/admin/users", admin)).status).toBe(200);
    // Keep AUTH_SECRET and DB unchanged: only the bootstrap credential changes across restart.
    await stop(); await start("rotated-admin-password");
    await assertRevoked(admin);
    const rotated = await login("admin@example.test", "rotated-admin-password");
    expect((await request("/api/admin/users", rotated)).status).toBe(200);
    expect((await request("/api/reports", recreated)).status).toBe(200);
  });
});
