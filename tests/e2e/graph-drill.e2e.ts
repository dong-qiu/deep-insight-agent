import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveAnalysisBatch } from "../../src/lib/db/analysis.js";
import { openDb } from "../../src/lib/db/index.js";
import { insertTopic } from "../../src/lib/db/repos.js";
import { upsertUser } from "../../src/lib/db/users.js";
import type { AnalysisBatch, Insight, Topic } from "../../src/lib/types.js";

const tempRoot = mkdtempSync(join(tmpdir(), "insight-graph-drill-e2e-"));
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
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`graph drill e2e server did not become ready: ${String(lastError)}`);
}

async function signIn(email: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = new Map();
  const csrf = await fetch(`${baseUrl}/api/auth/csrf`);
  addCookies(jar, csrf);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  const response = await fetch(`${baseUrl}/api/auth/callback/credentials?json=true`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${baseUrl}/graph`, json: "true" }),
    redirect: "manual",
  });
  addCookies(jar, response);
  if (!cookieHeader(jar).includes("authjs.session-token")) throw new Error(`credentials login failed with ${response.status}`);
  return jar;
}

beforeAll(async () => {
  const db = openDb(dbPath);
  const topic: Topic = { id: "t1", name: "T", keywords: ["OpenAI"], language: "zh", brief_schedule: "daily", enabled: true };
  const occurrence = (id: string): Insight => ({
    id, topic_id: topic.id, type: "aggregation", event_id: id,
    statement: "OpenAI 发布了产品。", headline: "产品发布", importance: 4, importance_basis: "test",
    citations: [{ content_item_id: `ci-${id}`, quote: "OpenAI released a product", locator: { paragraph_index: 0, char_start: 0, char_end: 25 } }],
    source_count: 1, multi_source: false, time_window: { start: "2026-09-08", end: "2026-09-08" },
    confidence: null, language: "zh", is_followup: false, entities: [{ name: "OpenAI", type: "organization" }], tags: [],
  });
  const batch: AnalysisBatch = {
    id: "b1", topic_id: topic.id, time_window: { start: "2026-09-08", end: "2026-09-08" },
    status: "done", no_significant_event: false, insights: [occurrence("i1"), occurrence("i2")],
  };
  insertTopic(db, topic);
  upsertUser(db, "viewer@example.test", "viewer-password", "viewer");
  saveAnalysisBatch(db, batch);
  db.prepare(
    `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("r1", "brief", topic.id, "done", "2026-09-08T08:00:00Z", "R1", "/reports/r1", JSON.stringify(["i1"]), "[]", 1, "{}");
  db.prepare(
    `INSERT INTO report_index (report_id,type,topic_id,date,title,summary,importance) VALUES (?,?,?,?,?,?,?)`,
  ).run("r1", "brief", topic.id, "2026-09-08", "R1", "", 4);
  db.close();

  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "start", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, DB_PATH: dbPath, AUTH_SECRET: "e2e-auth-secret", ADMIN_EMAIL: "admin@example.test", ADMIN_PASSWORD: "admin-password" },
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

describe("graph drill live application", () => {
  it("returns one read-time strict group while preserving both raw occurrences", async () => {
    const viewer = await signIn("viewer@example.test", "viewer-password");
    const response = await fetch(`${baseUrl}/api/graph/drill?topic=t1&a=OpenAI`, { headers: { cookie: cookieHeader(viewer) } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [expect.objectContaining({
        statement: "OpenAI 发布了产品。", occurrence_count: 2,
        occurrences: expect.arrayContaining([
          expect.objectContaining({ id: "i1", report_links: [{ report_id: "r1", date: "2026-09-08" }] }),
          expect.objectContaining({ id: "i2", report_links: [] }),
        ]),
      })],
    });
  });
});
