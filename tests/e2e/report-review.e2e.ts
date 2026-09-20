import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../../src/lib/db/provenance-migrations.js";
import { canonicalHash, captureRevision, entityKey, appendGenerationEvent, type EntityRef } from "../../src/lib/db/provenance-facts.js";
import { persistReportReviewPackage, publishReviewPackage, REPORT_SELECTION_RULE_VERSION } from "../../src/lib/db/report-review.js";
import { upsertUser } from "../../src/lib/db/users.js";

const tempRoot = mkdtempSync(join(tmpdir(), "insight-report-review-e2e-"));
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
  throw new Error(`report review e2e server did not become ready: ${String(lastError)}`);
}

async function signIn(email: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = new Map();
  const csrf = await fetch(`${baseUrl}/api/auth/csrf`);
  addCookies(jar, csrf);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  const response = await fetch(`${baseUrl}/api/auth/callback/credentials?json=true`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${baseUrl}/admin/reports/report-review/review`, json: "true" }),
    redirect: "manual",
  });
  addCookies(jar, response);
  if (!cookieHeader(jar).includes("authjs.session-token")) throw new Error(`credentials login failed with ${response.status}`);
  return jar;
}

function seedPublishedReview(): void {
  const db = openDb(dbPath);
  applyProvenanceMigrations(db);
  db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t_review','Review','[]','en','daily',1)").run();
  db.prepare("INSERT INTO analysis_batch(id,topic_id,time_window,status,display_coverage_state,display_projection_version) VALUES ('batch_review','t_review','{}','done','audited','source_quote_v1')").run();
  for (let index = 1; index <= 51; index += 1) {
    const insightId = `insight_${index}`;
    db.prepare(`INSERT INTO insight(id,batch_id,topic_id,type,statement,importance,importance_basis,source_count,multi_source,time_window,language)
      VALUES (?,?,?,'aggregation',?,3,'系统重要性判断：该结果可为工程选型提供参考。',1,0,'{}','en')`).run(
      insightId, "batch_review", "t_review", `Verified statement ${index}.`,
    );
    db.prepare("INSERT INTO citation(insight_id,citation_index,content_item_id,quote,locator) VALUES (?,0,'content_review',?,'{}')")
      .run(insightId, `Verified statement ${index}.`);
    db.prepare("INSERT INTO citation_check(batch_id,insight_id,citation_index,reachability,reachability_reason,consistency,consistency_reason,verdict) VALUES ('batch_review',?,0,'pass','ok','support','ok','pass')")
      .run(insightId);
  }
  db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
    VALUES ('report-review','brief','t_review','done','2026-09-20T00:00:00.000Z','Review report','/reports/report-review','["insight_1"]','[]',NULL,1,'{"tokens":0,"amount":0}',NULL)`).run();
  db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
    VALUES ('legacy-review','brief','t_review','done','2026-09-20T00:00:00.000Z','Legacy report','/reports/legacy-review','[]','[]',NULL,0,'{"tokens":0,"amount":0}',NULL)`).run();
  db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
    VALUES ('trace_review','topic_pipeline','api','completed','{}','complete','{}','{}','2026-09-20T00:00:00.000Z')`).run();

  const contentSnapshot = { url: "https://example.test/review", source_id: "source_review", title: "Review input", published_at: null, fetched_at: "2026-09-20T00:00:00.000Z", body_kind: "article", fetch_status: "ok", body_length: 0, content_hash: "review-content-hash" };
  const content: EntityRef = { type: "content_item", locator: { kind: "id", id: "content_review" }, revision: `content-v4:${canonicalHash(contentSnapshot)}`, role: "input" };
  const batch: EntityRef = { type: "analysis_batch", locator: { kind: "id", id: "batch_review" }, revision: "batch_review", role: "input" };
  const validation: EntityRef = { type: "validation_result", locator: { kind: "composite", key: { batch_id: "batch_review" } }, revision: "batch_review", role: "input" };
  captureRevision(db, { entity_type: content.type, entity_key: entityKey(content), revision: content.revision, snapshot: contentSnapshot });
  const analyzerContext = { analyzer_model: "analyzer", analyzer_prompt_hash: "a".repeat(64), analyzer_output_version: "v1", analyzer_cache_mode: "write_only", coverage_model: "coverage", coverage_prompt_hash: "b".repeat(64), coverage_thinking: "off", coverage_thinking_source: "explicit" };
  const validatorContext = { validator_model: "validator", validator_prompt_hash: "c".repeat(64), validator_thinking: "off", validator_cache_mode: "on" };
  const reportContext = { report_selection_rule: REPORT_SELECTION_RULE_VERSION, report_renderer: REPORT_SELECTION_RULE_VERSION };
  const analyzeStarted = appendGenerationEvent(db, { trace_id: "trace_review", stage: "analyze", event_type: "started", input_refs: [content], version_context: analyzerContext, context_completeness: "complete" });
  const analyzeCompleted = appendGenerationEvent(db, { trace_id: "trace_review", stage: "analyze", event_type: "completed", input_refs: [content], output_refs: [{ ...batch, role: "output" }] });
  const validateStarted = appendGenerationEvent(db, { trace_id: "trace_review", stage: "validate", event_type: "started", input_refs: [batch, content], version_context: validatorContext, context_completeness: "complete" });
  const validateCompleted = appendGenerationEvent(db, { trace_id: "trace_review", stage: "validate", event_type: "completed", input_refs: [batch, content], output_refs: [{ ...validation, role: "output" }], version_context: validatorContext, context_completeness: "complete" });
  const reportStarted = appendGenerationEvent(db, { trace_id: "trace_review", stage: "generate_report", event_type: "started", input_refs: [batch, validation], version_context: reportContext, context_completeness: "complete" });
  persistReportReviewPackage(db, {
    report_id: "report-review", trace_id: "trace_review", analysis_batch_id: "batch_review",
    analyze_started_event_id: analyzeStarted.id, analyze_completed_event_id: analyzeCompleted.id,
    validate_started_event_id: validateStarted.id, validate_completed_event_id: validateCompleted.id,
    generate_report_started_event_id: reportStarted.id, selection_rule_version: REPORT_SELECTION_RULE_VERSION,
    decisions: Array.from({ length: 51 }, (_, offset) => ({
      insight_id: `insight_${offset + 1}`, decision: "published" as const, reason_code: "selected_by_rule",
      published_rank: offset + 1, supporting_citation_indices: [0],
    })),
  });
  publishReviewPackage(db, "report-review");
  upsertUser(db, "viewer@example.test", "viewer-password", "viewer");
  db.close();
}

beforeAll(async () => {
  seedPublishedReview();
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

describe("report quality review live application", () => {
  it("rejects unauthenticated and viewer reads, and lets an admin follow the report link to a paginated published snapshot", async () => {
    const reviewPath = "/admin/reports/report-review/review";
    const anonymous = await fetch(`${baseUrl}${reviewPath}`, { redirect: "manual" });
    expect(anonymous.status).toBe(307);
    expect(anonymous.headers.get("location")).toContain("/login?from=");
    const viewer = await signIn("viewer@example.test", "viewer-password");
    const viewerDenied = await fetch(`${baseUrl}${reviewPath}`, { headers: { cookie: cookieHeader(viewer) }, redirect: "manual" });
    expect(viewerDenied.status).toBe(307);
    expect(viewerDenied.headers.get("location")).toBe("/");

    const admin = await signIn("admin@example.test", "admin-password");
    const headers = { cookie: cookieHeader(admin) };
    const report = await fetch(`${baseUrl}/reports/report-review`, { headers });
    expect(report.status).toBe(200);
    expect(await report.text()).toContain('href="/admin/reports/report-review/review"');

    const firstPage = await fetch(`${baseUrl}${reviewPath}`, { headers });
    const firstBody = await firstPage.text();
    expect(firstPage.status).toBe(200);
    expect(firstBody).toContain("报告质量复盘");
    const secondPage = await fetch(`${baseUrl}${reviewPath}?decisions_page=2`, { headers });
    expect(secondPage.status).toBe(200);
    const secondBody = await secondPage.text();
    // React's streamed HTML may separate text nodes with comment markers.
    expect(secondBody.replace(/<!--.*?-->/g, "")).toContain("第 2 / 2 页（共 51 条）");
    expect(secondBody).toContain("insight_51");

    await expect(fetch(`${baseUrl}/admin/reports/legacy-review/review`, { headers })).resolves.toMatchObject({ status: 404 });
  });
});
