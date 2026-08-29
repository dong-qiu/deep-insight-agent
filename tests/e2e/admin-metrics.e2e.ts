import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/lib/db/index.js";
import { appendFunnelEvent } from "../../src/lib/db/p1-metrics-facts.js";
import { applyProvenanceMigrations } from "../../src/lib/db/provenance-migrations.js";
import { upsertUser } from "../../src/lib/db/users.js";
import { deterministicUuidV5 } from "../../src/lib/db/uuid.js";

const tempRoot = mkdtempSync(join(tmpdir(), "insight-metrics-e2e-"));
const dbPath = join(tempRoot, "insight.db");
let app: ChildProcess | undefined;
let baseUrl = "";

type CookieJar = Map<string, string>;

function addCookies(jar: CookieJar, response: Response): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  for (const value of values) {
    const match = /^([^=;]+)=([^;]*)/.exec(value);
    if (match) jar.set(match[1], match[2]);
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function unusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("unable_to_allocate_test_port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForApp(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`metrics e2e server did not become ready: ${String(lastError)}`);
}

async function signIn(email: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = new Map();
  const csrf = await fetch(`${baseUrl}/api/auth/csrf`);
  addCookies(jar, csrf);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  const response = await fetch(`${baseUrl}/api/auth/callback/credentials?json=true`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${baseUrl}/admin/metrics`, json: "true" }),
    redirect: "manual",
  });
  addCookies(jar, response);
  if (!cookieHeader(jar).includes("authjs.session-token")) throw new Error(`credentials login failed with ${response.status}`);
  return jar;
}

beforeAll(async () => {
  const now = Date.now();
  const db = openDb(dbPath);
  applyProvenanceMigrations(db);
  upsertUser(db, "viewer@example.test", "viewer-password", "viewer");
  for (const [event_id, trace_id, offset] of [["event_older", "trace_older", 120_000], ["event_newer", "trace_newer", 60_000]] as const) {
    const occurred_at = new Date(now - offset).toISOString();
    appendFunnelEvent(db, { event_id: deterministicUuidV5(`admin-metrics-e2e:${event_id}`), trace_id, stage: "received", pipeline_version: "e2e-v1", occurred_at, ingested_at: new Date(now).toISOString() });
  }
  db.close();

  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "start", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, DB_PATH: dbPath, AUTH_SECRET: "e2e-auth-secret", ADMIN_EMAIL: "admin@example.test", ADMIN_PASSWORD: "admin-password", P1_DASHBOARD_ENABLED: "true" },
    stdio: "pipe",
  });
  await waitForApp();
});

afterAll(async () => {
  if (app && !app.killed) {
    app.kill("SIGTERM");
    await new Promise<void>((resolve) => app!.once("exit", () => resolve()));
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("admin metrics live application", () => {
  it("enforces access, validates API inputs, paginates details, and links the dashboard to detail UI", async () => {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const details = `/api/admin/metrics/details?kind=funnel&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    await expect(fetch(`${baseUrl}/api/admin/metrics`)).resolves.toMatchObject({ status: 404 });
    await expect(fetch(`${baseUrl}${details}`)).resolves.toMatchObject({ status: 404 });

    const viewer = await signIn("viewer@example.test", "viewer-password");
    await expect(fetch(`${baseUrl}/api/admin/metrics`, { headers: { cookie: cookieHeader(viewer) } })).resolves.toMatchObject({ status: 404 });
    await expect(fetch(`${baseUrl}${details}`, { headers: { cookie: cookieHeader(viewer) } })).resolves.toMatchObject({ status: 404 });

    const admin = await signIn("admin@example.test", "admin-password");
    const adminHeaders = { cookie: cookieHeader(admin) };
    const dashboard = await fetch(`${baseUrl}/api/admin/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: adminHeaders });
    expect(dashboard.status).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({ window: { from, to }, diagnostics: { metrics: "available", integrity: "available" } });

    const invalidRange = await fetch(`${baseUrl}/api/admin/metrics?from=not-a-date&to=${encodeURIComponent(to)}`, { headers: adminHeaders });
    expect(invalidRange.status).toBe(400);
    const firstPage = await fetch(`${baseUrl}${details}&limit=1`, { headers: adminHeaders });
    expect(firstPage.status).toBe(200);
    const firstBody = await firstPage.json() as { items: Array<{ event_id: string }>; next_cursor: string | null };
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.next_cursor).toEqual(expect.any(String));
    const nextPage = await fetch(`${baseUrl}${details}&limit=1&cursor=${encodeURIComponent(firstBody.next_cursor!)}`, { headers: adminHeaders });
    expect(nextPage.status).toBe(200);
    const nextBody = await nextPage.json() as { items: Array<{ event_id: string }> };
    expect(nextBody.items[0]?.event_id).not.toBe(firstBody.items[0]?.event_id);
    const invalidCursor = await fetch(`${baseUrl}${details}&cursor=not-a-cursor`, { headers: adminHeaders });
    expect(invalidCursor.status).toBe(400);

    const dashboardPage = await fetch(`${baseUrl}/admin/metrics`, { headers: adminHeaders });
    expect(dashboardPage.status).toBe(200);
    expect(await dashboardPage.text()).toContain('href="/admin/metrics/details"');
    const detailsPage = await fetch(`${baseUrl}/admin/metrics/details?kind=funnel`, { headers: adminHeaders });
    expect(detailsPage.status).toBe(200);
    expect(await detailsPage.text()).toContain("受控指标明细");

    const db = openDb(dbPath);
    const audits = db.prepare("SELECT action FROM audit_log WHERE action = 'dashboard_detail_read'").all() as Array<{ action: string }>;
    db.close();
    expect(audits).not.toHaveLength(0);
  });
});
