/** C2g-only synthetic fixture. No real provider, credentials, source fetch or cron. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDb, type DB } from "../../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../../src/lib/db/provenance-migrations.js";
import { saveAnalysisBatch, saveValidationResult } from "../../src/lib/db/analysis.js";
import { insertContentItem, insertSource, insertTopic } from "../../src/lib/db/repos.js";
import { upsertUser } from "../../src/lib/db/users.js";
import { contentHash } from "../../src/lib/sources/normalize.js";
import type { AnalysisBatch, Report } from "../../src/lib/types.js";

export const admin = { email: "c2g-admin@example.test", password: "synthetic-c2g-admin-password" };
export const viewer = { email: "c2g-viewer@example.test", password: "synthetic-c2g-viewer-password" };
export const quote = "test-first 把回归缺陷降了 38%";
export const generated = { answerable: true, answer_md: "test-first 改善回归 [1]。", claims: [{ ref: 1, claim: "test-first 降低回归缺陷" }] };
export const supported = { consistency: "support", consistency_reason: "ok", rationale: "synthetic" };

export function fixtureRoot(label: string): string {
  const parent = process.env.C2G_EVIDENCE_DIR ?? tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, `c2g-${label}-`)); chmodSync(root, 0o700); return root;
}
export function seedFollowupDb(root: string): { db: DB; dbPath: string; report: Report } {
  const dbPath = join(root, "insight.db"); const db = openDb(dbPath); applyProvenanceMigrations(db);
  insertTopic(db, { id: "c2g-topic", name: "合成工程", keywords: [], language: "zh", brief_schedule: "daily", enabled: true });
  insertSource(db, { id: "c2g-source", name: "合成来源", type: "rss", endpoint: "https://example.test/feed", topic_ids: ["c2g-topic"], fetch_interval: "6h", backfill: null, enabled: true });
  const citations = [quote, "团队反馈良好", "不支持的合成引用"];
  for (const [i, body] of citations.entries()) insertContentItem(db, { id: `c2g-content-${i}`, source_id: "c2g-source", url: `https://example.test/${i}`, title: "合成工程", author: null,
    published_at: "2026-06-01T00:00:00Z", fetched_at: "2026-06-01T00:00:00Z", language: "zh", topic_ids: ["c2g-topic"], tags: [], body,
    body_kind: "article", raw_ref: "", content_hash: contentHash(body), fetch_status: "ok" });
  const batch: AnalysisBatch = { id: "c2g-batch", topic_id: "c2g-topic", time_window: { start: "2026-06-01", end: "2026-06-02" }, status: "done", no_significant_event: false,
    insights: [{ id: "c2g-insight", topic_id: "c2g-topic", type: "aggregation", event_id: null, statement: "test-first 降低回归缺陷", importance: 4, importance_basis: "synthetic",
      citations: citations.map((q, i) => ({ content_item_id: `c2g-content-${i}`, quote: q, locator: { paragraph_index: 0, char_start: 0, char_end: q.length } })),
      source_count: 1, multi_source: false, time_window: { start: "2026-06-01", end: "2026-06-02" }, confidence: null, language: "zh" }] };
  saveAnalysisBatch(db, batch);
  saveValidationResult(db, batch.id, { checks: citations.map((_, i) => ({ insight_id: "c2g-insight", citation_index: i, reachability: "pass", reachability_reason: "ok",
    consistency: i === 0 ? "support" : i === 1 ? "uncertain" : "not_support", consistency_reason: i === 0 ? "ok" : i === 1 ? "uncertain" : "out_of_context", verdict: i === 0 ? "pass" : i === 1 ? "flagged" : "blocked" })),
    report: { total: 3, pass: 1, blocked: 1, flagged: 1, errored: 0, consistency_failure_rate: 0, flagged_rate: 1 / 3, insights_total: 1, insights_includable: 1, releasable: true } });
  const report: Report = { id: "c2g-report", type: "brief", topic_id: "c2g-topic", status: "done", generated_at: "2026-06-02T00:00:00Z", title: "合成追问报告",
    body_md: "# 合成追问报告\n\ntest-first 降低回归缺陷 [1]。\n", body_html: "<h1>合成追问报告</h1>", insight_ids: ["c2g-insight"], event_ids: [], prev_report_id: null, citation_count: 1, cost: { tokens: 0, amount: 0 } };
  // Historical synthetic reader fixture, not a signed publication/quality receipt.
  const bodyPath = join(root, report.id); writeFileSync(`${bodyPath}.md`, report.body_md, { mode: 0o600 }); writeFileSync(`${bodyPath}.html`, report.body_html, { mode: 0o600 });
  db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(report.id, report.type, report.topic_id, report.status, report.generated_at, report.title, bodyPath, JSON.stringify(report.insight_ids), "[]", 1, JSON.stringify(report.cost));
  upsertUser(db, viewer.email, viewer.password, "viewer"); chmodSync(dbPath, 0o600);
  return { db, dbPath, report };
}

export function structuredSse(input: unknown, model = "claude-sonnet-4-6"): string {
  return [
    { type: "message_start", message: { id: "c2g-synthetic", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c2g-tool", name: "respond_with_structured_output", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }, { type: "message_stop" },
  ].map(v => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`).join("");
}
export const structuredResponse = (input: unknown) => new Response(structuredSse(input), { headers: { "content-type": "text/event-stream" } });

export async function startC2gServer() {
  const root = fixtureRoot("http"); const { db, dbPath, report } = seedFollowupDb(root); db.close();
  const runtime = join(root, "runtime"); mkdirSync(runtime, { mode: 0o700 });
  const buildRoot = resolve(process.env.C2G_BUILD_ROOT ?? process.cwd());
  for (const entry of [".next", "node_modules", "public"]) {
    if (!existsSync(join(buildRoot, entry))) throw new Error("c2g_build_missing");
    symlinkSync(join(buildRoot, entry), join(runtime, entry), "dir");
  }
  if (readdirSync(runtime).some(name => name.startsWith(".env"))) throw new Error("c2g_runtime_env_file_present");
  const calls: { model: string; body: string; response: ServerResponse }[] = [];
  let held = false; const pending: (() => void)[] = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") { res.writeHead(404).end(); return; }
    let body = ""; for await (const chunk of req) { body += String(chunk); if (body.length > 128 * 1024) { res.writeHead(413).end(); return; } }
    const { model } = JSON.parse(body) as { model: string }; calls.push({ model, body, response: res });
    const reply = () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(structuredSse(model.includes("opus") ? supported : generated, model)); };
    if (held) pending.push(reply); else reply();
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("c2g_provider_address");
  const port = Number(process.env.C2G_PORT ?? 0);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", DB_PATH: dbPath, DATA_DIR: root,
    AUTH_SECRET: "synthetic-c2g-auth-secret-with-no-production-authority", ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: admin.password,
    ANTHROPIC_API_KEY: "synthetic-c2g-provider-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, LLM_PROVIDER: "anthropic", LLM_MAX_RETRIES: "0", LLM_TRANSIENT_RETRIES: "0",
    VALIDATOR_RETRIES: "0", VALIDATOR_THINKING: "0", LOG_LEVEL: "info" };
  let logs = ""; const child = spawn(process.execPath, [join(buildRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: runtime, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", c => { logs += c.toString(); }); child.stderr.on("data", c => { logs += c.toString(); });
  const stop = async (): Promise<void> => {
    for (const reply of pending.splice(0)) reply();
    try { await stopChild(child); } finally {
      provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r()));
      writeFileSync(join(root, "next-sanitized.log"), logs, { mode: 0o600 });
    }
    // Retain these owned synthetic fixtures/logs; never remove prior archives.
  };
  // Next's printed URL supplies its actual ephemeral port, without a reservation race.
  let url = "";
  try {
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error("c2g_next_start_failed");
      const found = logs.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (found) {
        url = `http://127.0.0.1:${found[1]}`;
        try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(200) })).ok) break; } catch { /* bounded startup */ }
      }
      await delay(100); if (i === 299) throw new Error("c2g_next_start_timeout");
    }
    return { root, url, dbPath, report, calls, hold() { held = true; }, release() { held = false; for (const reply of pending.splice(0)) reply(); },
      stop };
  } catch (error) { await stop(); throw error; }
}
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("c2g_stop_timeout")), 5000); })]); }
  catch { child.kill("SIGKILL"); await exited; } finally { if (timer) clearTimeout(timer); }
}
export async function loginCookie(url: string, user = admin): Promise<string> {
  const jar = new Map<string, string>();
  const remember = (r: Response) => { for (const cookie of r.headers.getSetCookie()) { const pair = cookie.split(";")[0]!; const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); } };
  const csrfResponse = await fetch(`${url}/api/auth/csrf`); remember(csrfResponse); const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const r = await fetch(`${url}/api/auth/callback/credentials`, { method: "POST", headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken, email: user.email, password: user.password, callbackUrl: url }), redirect: "manual" }); remember(r);
  const session = await fetch(`${url}/api/auth/session`, { headers: { cookie: cookie() } });
  if ((await session.json() as { user?: { email?: string } }).user?.email !== user.email) throw new Error("c2g_login_failed");
  return cookie();
}
