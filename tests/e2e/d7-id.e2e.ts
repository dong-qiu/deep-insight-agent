import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../../src/lib/db/provenance-migrations.js";
import { insertTopic } from "../../src/lib/db/repos.js";
import { saveReport } from "../../src/lib/db/reports.js";
import { saveFollowup } from "../../src/lib/db/followup.js";
import { newObjectId } from "../../src/lib/utils/object-id.js";
import type { Report } from "../../src/lib/types.js";

const root = mkdtempSync(join(tmpdir(), "insight-d7-http-"));
const data = join(root, "data");
const runtime = join(root, "runtime");
const oldId = "rep_12345678";
const newId = newObjectId("rep");
let app: ChildProcess | undefined;
let url = "";
const cookies = new Map<string, string>();
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
function collect(response: Response) {
  for (const value of response.headers.getSetCookie()) {
    const match = /^([^=;]+)=([^;]*)/.exec(value);
    if (match) cookies.set(match[1], match[2]);
  }
}

beforeAll(async () => {
  mkdirSync(data); mkdirSync(runtime);
  const dbPath = join(data, "insight.db");
  const db = openDb(dbPath); applyProvenanceMigrations(db);
  insertTopic(db, { id: "t_d7", name: "D7 synthetic", keywords: [], language: "en", brief_schedule: "daily", enabled: true });
  try {
    for (const [i, id] of [oldId, newId].entries()) {
      const report: Report = { id, type: "brief", topic_id: "t_d7", status: "done", generated_at: `2026-10-0${i + 1}T00:00:00Z`,
        title: `D7 report ${i}`, body_md: `# D7 report ${i}`, body_html: `<h1>D7 report ${i}</h1>`, insight_ids: [], event_ids: [],
        prev_report_id: i ? oldId : null, citation_count: 0, cost: { tokens: 0, amount: 0 } };
      await saveReport(db, report, { report_id: id, type: "brief", topic_id: "t_d7", date: report.generated_at.slice(0, 10), title: report.title,
        summary: "Synthetic", highlights: [], tags: [], source_ids: [], entity_names: [], importance: 0, event_ids: [], milestone_count: 0 }, { dir: join(data, "reports") });
      const qaId = i ? "fup_12345678" : newObjectId("fup");
      saveFollowup(db, { id: qaId, thread_id: qaId, report_id: id, turn_index: 0, question: "D7 synthetic question", answer_md: "D7 synthetic answer",
        citations_used: [], validation: { total: 0, reachable: 0, consistent: 0, blocked: 0, errored: 0 }, cost: { tokens: 0, amount: 0 }, status: "done", created_at: report.generated_at });
    }
  } finally { db.close(); }
  for (const path of [".next", "node_modules", "public"]) symlinkSync(resolve(path), join(runtime, path), "dir");
  const port = await new Promise<number>((done, reject) => {
    const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
      const address = server.address(); server.close(error => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("d7_port_missing"));
        else done(address.port);
      });
    });
  });
  url = `http://127.0.0.1:${port}`;
  // A clean cwd and explicit synthetic env prevent Next loading local secrets.
  app = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", runtime, "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: runtime, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      DATA_DIR: data, DB_PATH: dbPath, AUTH_SECRET: "d7-synthetic-http-secret", ADMIN_EMAIL: "admin@example.test", ADMIN_PASSWORD: "d7-synthetic-password" }, stdio: "ignore",
  });
  let failed = false; app.on("error", () => { failed = true; });
  for (let i = 0; i < 120; i++) {
    if (failed || app.exitCode !== null || app.signalCode !== null) throw new Error("d7_app_exited");
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Poll readiness. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error("d7_app_not_ready");
});
afterAll(async () => {
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    await new Promise<void>(done => {
      const timer = setTimeout(() => app!.kill("SIGKILL"), 5000);
      app!.once("exit", () => { clearTimeout(timer); done(); }); app!.kill("SIGTERM");
    });
  }
  rmSync(root, { recursive: true, force: true });
});

it("real HTTP routes preserve mixed IDs, auth, report navigation, list and QA/thread associations", async () => {
  expect(newId).toMatch(/^rep_[a-f0-9]{32}$/);
  for (const id of [oldId, newId]) {
    const anonymous = await fetch(`${url}/reports/${id}`, { redirect: "manual" });
    expect(anonymous.status).toBe(307); expect(anonymous.headers.get("location")).toContain("/login");
    expect((await fetch(`${url}/api/reports/${id}/followup`, { redirect: "manual" })).status).toBe(401);
  }
  const csrf = await fetch(`${url}/api/auth/csrf`); collect(csrf);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  collect(await fetch(`${url}/api/auth/callback/credentials?json=true`, { method: "POST", redirect: "manual",
    headers: { cookie: cookieHeader(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: "admin@example.test", password: "d7-synthetic-password", callbackUrl: `${url}/reports`, json: "true" }) }));
  expect(cookieHeader()).toContain("authjs.session-token");
  const headers = { cookie: cookieHeader() };
  for (const [i, id] of [oldId, newId].entries()) {
    const response = await fetch(`${url}/reports/${id}`, { headers }); expect(response.status).toBe(200);
    const html = await response.text(); expect(html).toContain(`D7 report ${i}`);
    expect(html).toContain(`href="/reports/${i ? oldId : newId}"`);
    const followup = await fetch(`${url}/api/reports/${id}/followup`, { headers }); expect(followup.status).toBe(200);
    const { followups } = await followup.json(); expect(followups).toHaveLength(1);
    expect(followups[0].report_id).toBe(id); expect(followups[0].thread_id).toBe(followups[0].id);
  }
  const list = await fetch(`${url}/api/reports?topic=t_d7`, { headers }); expect(list.status).toBe(200);
  expect((await list.json()).items.map((value: { report_id: string }) => value.report_id)).toEqual(expect.arrayContaining([oldId, newId]));
  expect((await fetch(`${url}/reports/${newId}_wrong`, { headers })).status).toBe(404);
  expect((await fetch(`${url}/api/reports/${newId}%2Fescape/followup`, { headers })).status).toBe(404);
});
