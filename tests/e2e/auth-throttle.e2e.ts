import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/lib/db/index.js";
import { upsertUser } from "../../src/lib/db/users.js";

const root = mkdtempSync(join(tmpdir(), "insight-auth-throttle-"));
let app: ChildProcess | undefined;
let base = "";
type Jar = Map<string, string>;
const cookie = (jar: Jar) => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
function collect(jar: Jar, response: Response) {
  for (const value of response.headers.getSetCookie()) {
    const match = /^([^=;]+)=([^;]*)/.exec(value);
    if (match) jar.set(match[1], match[2]);
  }
}

async function login(email: string, password: string, forwardedFor = "203.0.113.1") {
  const jar: Jar = new Map();
  const csrf = await fetch(`${base}/api/auth/csrf`);
  collect(jar, csrf);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  const response = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(jar),
      "x-auth-return-redirect": "1", "x-forwarded-for": forwardedFor },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: `${base}/` }),
  });
  collect(jar, response);
  const { url } = await response.json() as { url: string };
  return { jar, code: new URL(url).searchParams.get("code"),
    signedIn: [...jar.keys()].some((key) => key.includes("authjs.session-token")) };
}

beforeAll(async () => {
  const dbPath = join(root, "insight.db");
  const db = openDb(dbPath);
  try {
    upsertUser(db, "limited@example.test", "correct-password", "viewer");
    upsertUser(db, "reader@example.test", "reader-password", "viewer");
  } finally { db.close(); }
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "start", "--port", String(port)], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...process.env, DB_PATH: dbPath, DATA_DIR: root, AUTH_SECRET: "auth-throttle-test-secret",
      AUTH_URL: base, NEXTAUTH_URL: base, ADMIN_EMAIL: "admin@example.test", ADMIN_PASSWORD: "admin-password",
      ALERT_WEBHOOK: "", P1_DASHBOARD_ENABLED: "false", P1_ANCHOR_ENABLED: "false", P1_LIFECYCLE_ENABLED: "false" },
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (app.exitCode !== null) throw new Error("auth test app exited before readiness");
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("auth test app readiness timeout");
});

afterAll(async () => {
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM");
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("real Auth.js credential callback", () => {
  it("limits normalized accounts independently of headers, preserves sessions/roles, and also limits admin", async () => {
    const reader = await login("reader@example.test", "reader-password");
    const admin = await login("admin@example.test", "admin-password");
    expect(reader.signedIn && admin.signedIn).toBe(true);
    await expect(fetch(`${base}/api/admin/users`, { headers: { cookie: cookie(reader.jar) } })).resolves.toMatchObject({ status: 403 });
    await expect(fetch(`${base}/api/admin/users`, { headers: { cookie: cookie(admin.jar) } })).resolves.toMatchObject({ status: 200 });
    for (let i = 0; i < 5; i++) {
      const failed = await login(" LIMITED@EXAMPLE.TEST ", "wrong", `203.0.113.${i + 1}`);
      expect(failed).toMatchObject({ signedIn: false, code: "credentials" });
    }
    expect(await login("limited@example.test", "correct-password", "198.51.100.1"))
      .toMatchObject({ signedIn: false, code: "rate_limited" });
    expect((await login("reader@example.test", "reader-password")).signedIn).toBe(true);
    for (let i = 0; i < 5; i++) expect((await login("admin@example.test", "wrong")).signedIn).toBe(false);
    expect(await login("admin@example.test", "admin-password"))
      .toMatchObject({ signedIn: false, code: "rate_limited" });
    // Throttle only new authentication, not existing valid sessions.
    await expect(fetch(`${base}/api/admin/users`, { headers: { cookie: cookie(admin.jar) } })).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${base}/api/reports`, { headers: { cookie: cookie(reader.jar) } })).resolves.toMatchObject({ status: 200 });
  });
});
