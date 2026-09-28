import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openDb } from "../../src/lib/db/index.js";

const root = mkdtempSync(join(tmpdir(), "insight-diagnostic-e2e-"));
const dbPath = join(root, "db.sqlite");
let app: ChildProcess | undefined, base = "", output = "";
beforeAll(async () => {
  openDb(dbPath).close();
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address(); if (!addr || typeof addr === "string") return reject(new Error("missing port"));
      server.close((err) => err ? reject(err) : resolve(addr.port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "start", "--port", String(port)], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DB_PATH: dbPath, DATA_DIR: root, AUTH_SECRET: "diagnostic-e2e-auth-secret",
      AUTH_URL: base, NEXTAUTH_URL: base, ADMIN_EMAIL: "admin@example.test", ADMIN_PASSWORD: "diagnostic-e2e-password",
      ALERT_WEBHOOK: "", PROVENANCE_SCHEMA_REQUIRED: "0", PROVENANCE_DEPLOYMENT_REQUIRED: "0",
      P1_DASHBOARD_ENABLED: "false", INTEGRITY_ANCHOR_ENABLED: "false", P1_LIFECYCLE: "dormant" },
  });
  app.stdout?.on("data", (chunk) => { output += String(chunk); });
  app.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error("diagnostic app exited before readiness");
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("diagnostic app readiness timeout");
});
afterAll(async () => {
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM"); await exited;
  }
  rmSync(root, { recursive: true, force: true });
});

it("real authenticated PPT failure exposes neither private SQL text nor stack in HTTP or server logs", async () => {
  const jar = new Map<string, string>();
  const collect = (response: Response) => {
    for (const value of response.headers.getSetCookie()) {
      const match = /^([^=;]+)=([^;]*)/.exec(value); if (match) jar.set(match[1], match[2]);
    }
  };
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  const csrf = await fetch(`${base}/api/auth/csrf`); collect(csrf);
  const { csrfToken } = await csrf.json();
  const login = await fetch(`${base}/api/auth/callback/credentials`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
    body: new URLSearchParams({ email: "admin@example.test", password: "diagnostic-e2e-password", csrfToken, callbackUrl: base }) });
  collect(login);
  expect((await fetch(`${base}/api/admin/users`, { headers: { cookie: cookie() } })).status).toBe(200);
  const writer = new Database(dbPath);
  try {
    writer.exec("ALTER TABLE report RENAME TO report_before_diagnostic_test; CREATE VIEW report AS SELECT synthetic_private_sql_payload");
    const response = await fetch(`${base}/api/reports/rep_test/pptx`, { headers: { cookie: cookie() }, redirect: "manual" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "operation_failed" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output).toContain("报告导出失败");
    expect(output).not.toContain("synthetic_private_sql_payload");
    const diagnostic = output.split("\n").find((line) => line.includes("报告导出失败"));
    expect(diagnostic).not.toContain('"stack"');
  } finally {
    writer.exec("DROP VIEW IF EXISTS report; ALTER TABLE report_before_diagnostic_test RENAME TO report");
    writer.close();
  }
});
