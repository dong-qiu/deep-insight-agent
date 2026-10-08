/** Actual POST → followup → SDK → synthetic fetch → native SQLite.
 * Only auth/logger and named return/COMMIT gaps use limited caller seams. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { fixtureRoot, generated, quote, seedFollowupDb, structuredResponse, supported } from "../../../../../../tests/fixtures/c2g-followup-http.js";
import { closeDb, type DB } from "../../../../../lib/db/index.js";
import { TaskCancellationError } from "../../../../../lib/runtime/cancellation.js";
import { recordBudgetCost, withTaskBudget } from "../../../../../lib/runtime/task-budget.js";

const seam = vi.hoisted(() => ({
  denied: false, authError: undefined as unknown, dbError: undefined as unknown,
  reportNotReady: false, coreReturned: undefined as (() => void) | undefined, coreError: undefined as unknown,
  qaCommitted: undefined as (() => void) | undefined, auditCommitted: undefined as (() => void) | undefined,
  diagnosticsThrow: false, loggerCreationThrow: false,
  getDb: vi.fn(), core: vi.fn(), logger: vi.fn(), info: vi.fn(), error: vi.fn(), auth: vi.fn(),
}));
vi.mock("../../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: async () => { seam.auth(); if (seam.authError) throw seam.authError; return seam.denied ? NextResponse.json({ error: "forbidden" }, { status: 403 }) : null; } }));
vi.mock("../../../../../lib/db/index.js", async (original) => {
  const real = await original<typeof import("../../../../../lib/db/index.js")>();
  return { ...real, getDb: () => { seam.getDb(); if (seam.dbError) throw seam.dbError; return real.getDb(); } };
});
vi.mock("../../../../../lib/db/reports.js", async (original) => {
  const real = await original<typeof import("../../../../../lib/db/reports.js")>();
  return { ...real, getReport: (...args: Parameters<typeof real.getReport>) => { const r = real.getReport(...args); return r && seam.reportNotReady ? { ...r, status: "generating" } : r; } };
});
vi.mock("../../../../../lib/agents/followup.js", async (original) => {
  const real = await original<typeof import("../../../../../lib/agents/followup.js")>();
  return { ...real, answerFollowup: async (...args: Parameters<typeof real.answerFollowup>) => { seam.core(...args); if (seam.coreError) throw seam.coreError; const r = await real.answerFollowup(...args); seam.coreReturned?.(); return r; } };
});
vi.mock("../../../../../lib/db/followup.js", async (original) => {
  const real = await original<typeof import("../../../../../lib/db/followup.js")>();
  return { ...real, saveFollowup: (...args: Parameters<typeof real.saveFollowup>) => { real.saveFollowup(...args); seam.qaCommitted?.(); } };
});
vi.mock("../../../../../lib/db/audit.js", async (original) => {
  const real = await original<typeof import("../../../../../lib/db/audit.js")>();
  return { ...real, appendAudit: (...args: Parameters<typeof real.appendAudit>) => { if (seam.diagnosticsThrow && args[1].action === "followup_failed") throw new Error("secondary-audit"); const r = real.appendAudit(...args); if (args[1].action === "followup_asked") seam.auditCommitted?.(); return r; } };
});
vi.mock("../../../../../lib/runtime/logger.js", () => ({ runLogger: () => { seam.logger(); if (seam.loggerCreationThrow) throw new Error("early-logger"); return { info: seam.info, error: (...args: unknown[]) => { seam.error(...args); if (seam.diagnosticsThrow) throw new Error("secondary-log"); } }; } }));
vi.mock("../../../../../lib/runtime/alert.js", () => ({ notifyBudget: vi.fn() }));
import { POST, GET } from "./route.js";

let db: DB, controller: AbortController, ip = 0;
beforeEach(() => {
  closeDb(); controller = new AbortController(); const root = fixtureRoot("route"); const f = seedFollowupDb(root); f.db.close();
  vi.stubEnv("DB_PATH", f.dbPath); vi.stubEnv("DATA_DIR", root);
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-c2g"); vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1"); vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("LLM_MAX_RETRIES", "0"); vi.stubEnv("LLM_TRANSIENT_RETRIES", "0"); vi.stubEnv("VALIDATOR_RETRIES", "0"); vi.stubEnv("VALIDATOR_THINKING", "0");
  seam.denied = false; seam.authError = seam.dbError = seam.coreError = undefined; seam.reportNotReady = seam.diagnosticsThrow = seam.loggerCreationThrow = false;
  seam.coreReturned = seam.qaCommitted = seam.auditCommitted = undefined;
  for (const fn of [seam.auth, seam.getDb, seam.core, seam.logger, seam.info, seam.error]) fn.mockClear();
  transport();
});
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function database() { db = (await vi.importActual<typeof import("../../../../../lib/db/index.js")>("../../../../../lib/db/index.js")).getDb(); return db; }
function req(question: unknown = "?", key = `c2g-${++ip}`): Request {
  return new Request("http://localhost/api/reports/c2g-report/followup", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": key }, body: JSON.stringify({ question }), signal: controller.signal });
}
function post(request = req(), id = "c2g-report") { return POST(request, { params: Promise.resolve({ id }) }); }
function fakeFetch(handler: typeof fetch): void {
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") throw new Error("c2g_external_transport_forbidden");
    return handler(input, init);
  });
}
function transport(answer = generated, judgement = supported) {
  const fetcher = vi.fn(async (_url, init) => structuredResponse(JSON.parse(String(init?.body)).model.includes("opus") ? judgement : answer));
  fakeFetch(fetcher); return fetcher;
}
function count(table: string) { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
async function cancelled(r: Response, reason = "cancelled") { expect(r.status).toBe(500); expect(await r.json()).toEqual({ error: "followup_failed", message: reason }); }
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe("HTTP followup outer cancellation control", () => {
  it.each([undefined, null, 0, "opaque synthetic secret", new Error("private-first")])("auth denial keeps 403 for native preabort %s without DB/provider/diagnostics", async reason => {
    controller.abort(reason); seam.denied = true; const fetcher = transport(); expect((await post()).status).toBe(403);
    expect(seam.getDb).not.toHaveBeenCalled(); expect(seam.logger).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 0, "opaque synthetic secret", new Error("private-first"), new TaskCancellationError("task_deadline_exceeded")])("authorized preabort %s stops before params/DB/provider", async reason => {
    controller.abort(reason); const fetcher = transport(); await cancelled(await post(), reason instanceof TaskCancellationError ? reason.reasonCode : "cancelled");
    expect(seam.getDb).not.toHaveBeenCalled(); expect(seam.logger).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["missing", "not-ready", "empty", "long"])("observed params cancellation wins %s, without a diagnostic DB", async kind => {
    seam.reportNotReady = kind === "not-ready";
    const request = req(kind === "empty" ? "" : kind === "long" ? "x".repeat(501) : "?");
    const params = Promise.resolve().then(() => { controller.abort(null); return { id: kind === "missing" ? "absent" : "c2g-report" }; });
    await cancelled(await POST(request, { params })); expect(seam.getDb).not.toHaveBeenCalled();
  });
  it.each(["missing", "not-ready", "empty", "long"])("uncancelled %s retains its original gate despite parent zero budget", async kind => {
    await database(); seam.reportNotReady = kind === "not-ready"; const request = req(kind === "empty" ? "" : kind === "long" ? "x".repeat(501) : "?");
    const r = await withTaskBudget(db, { taskBudgetUsd: 0 }, () => post(request, kind === "missing" ? "absent" : "c2g-report"));
    expect(r.status).toBe(kind === "missing" ? 404 : kind === "not-ready" ? 409 : 400); expect(seam.core).not.toHaveBeenCalled();
  });
  it.each([false, true])("body reject cancellation=%s keeps correct reason", async abort => {
    const request = req(); Object.defineProperty(request, "json", { value: async () => { if (abort) controller.abort(0); throw new Error("body-read"); } });
    const r = await post(request); if (abort) await cancelled(r); else { expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: "empty_question" }); }
    expect(seam.core).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(501), "?"])("cancellation after body wins input/limiter for length %s", async q => {
    const request = req(); Object.defineProperty(request, "json", { value: async () => { controller.abort(); return { question: q }; } });
    await cancelled(await post(request)); expect(seam.core).not.toHaveBeenCalled(); expect(seam.info).not.toHaveBeenCalled();
  });
  it("real rate-limit 429 remains, and body cancellation wins exhausted limiter", async () => {
    await database(); transport({ answerable: false, answer_md: "not covered", claims: [] }); const key = `limited-${++ip}`;
    for (let i = 0; i < 30; i++) expect((await post(req("?", key))).status).toBe(200);
    const r = await withTaskBudget(db, { taskBudgetUsd: 0 }, () => post(req("?", key))); expect(r.status).toBe(429);
    const request = req("?", key); Object.defineProperty(request, "json", { value: async () => { controller.abort(); return { question: "?" }; } });
    await cancelled(await post(request));
  });
  it.each(["generation", "judge"])("actual SDK %s receives abort, late completion never writes QA/asked/cache", async stage => {
    await database(); let entered!: () => void, release!: (r: Response) => void; let signal: AbortSignal | undefined;
    const waiting = new Promise<void>(r => { entered = r; }); let calls = 0;
    const fetcher = vi.fn(async (_url, init) => { if (++calls === (stage === "generation" ? 1 : 2)) { signal = init?.signal; entered(); return new Promise<Response>(r => { release = r; }); } return structuredResponse(generated); });
    fakeFetch(fetcher); const work = post(); await waiting; controller.abort(null);
    // Release even old code, so the saved RED is a behavior assertion rather than a hanging test.
    await flush(); release(structuredResponse(stage === "generation" ? generated : supported)); await cancelled(await work); await flush();
    expect(signal?.aborted).toBe(true); expect(count("followup_qa")).toBe(0); expect(count("consistency_cache")).toBe(0);
    expect(db.prepare("SELECT action FROM audit_log WHERE action='followup_asked'").all()).toEqual([]); expect(seam.info).not.toHaveBeenCalled();
  });
  it("uncooperative actual SDK late rejection is consumed after canonical cancellation", async () => {
    await database(); let enter!: () => void, reject!: (e: Error) => void; const entered = new Promise<void>(r => { enter = r; });
    fakeFetch(vi.fn(() => { enter(); return new Promise<Response>((_, r) => { reject = r; }); }));
    const work = post(); await entered; controller.abort(new TaskCancellationError("task_deadline_exceeded")); await flush(); reject(new Error("late-transport"));
    await cancelled(await work, "task_deadline_exceeded"); await flush(); expect(count("followup_qa")).toBe(0);
  });
  it("core-return gap stops QA; core cache already committed is retained", async () => {
    await database(); transport(); seam.coreReturned = () => controller.abort(null); await cancelled(await post());
    expect(count("followup_qa")).toBe(0); expect(count("consistency_cache")).toBe(1); expect(seam.info).not.toHaveBeenCalled();
  });
  it("actual native QA COMMIT followed by abort preserves row, prevents asked/log/200", async () => {
    await database(); transport(); seam.qaCommitted = () => controller.abort(0); await cancelled(await post());
    expect(count("followup_qa")).toBe(1); expect(db.prepare("SELECT status,question FROM followup_qa").get()).toEqual({ status: "done", question: "?" });
    expect(db.prepare("SELECT action FROM audit_log WHERE action='followup_asked'").all()).toEqual([]); expect(seam.info).not.toHaveBeenCalled();
  });
  it("already committed asked audit stays when its return observes cancellation", async () => {
    await database(); transport(); seam.auditCommitted = () => controller.abort(); await cancelled(await post());
    expect(count("followup_qa")).toBe(1); expect(db.prepare("SELECT action FROM audit_log WHERE action='followup_asked'").all()).toHaveLength(1); expect(seam.info).not.toHaveBeenCalled();
  });
  it("late parent-budget exhaustion suppresses QA without converting network signal to abort", async () => {
    await database(); transport(); seam.coreReturned = () => recordBudgetCost("c2g-late", { tokens: 0, amount: 1 });
    await withTaskBudget(db, { taskBudgetUsd: 1 }, async () => { await cancelled(await post(), "task_budget_exceeded"); });
    expect(count("followup_qa")).toBe(0); expect(seam.core.mock.calls[0]?.[3].signal.aborted).toBe(false);
  });
  it("canonical first cancellation wins simultaneous parent-budget exhaustion", async () => {
    await database(); transport(); seam.coreReturned = () => { controller.abort(new TaskCancellationError("task_deadline_exceeded")); recordBudgetCost("c2g-late", { tokens: 0, amount: 1 }); };
    await withTaskBudget(db, { taskBudgetUsd: 1 }, async () => { await cancelled(await post(), "task_deadline_exceeded"); }); expect(count("followup_qa")).toBe(0);
  });
  it("cancelled failure diagnostics cannot overwrite first reason", async () => {
    await database(); seam.coreError = new TaskCancellationError("task_deadline_exceeded"); seam.diagnosticsThrow = true; controller.abort(new TaskCancellationError("task_deadline_exceeded"));
    await cancelled(await post(), "task_deadline_exceeded"); expect(seam.getDb).not.toHaveBeenCalled();
    // Authorized post-core cancellation with existing resources exercises both throwing diagnostics.
    controller = new AbortController(); transport(); seam.coreError = undefined; seam.coreReturned = () => controller.abort(new TaskCancellationError("task_deadline_exceeded"));
    await cancelled(await post(), "task_deadline_exceeded"); expect(seam.error).toHaveBeenCalled(); expect(count("followup_qa")).toBe(0);
  });
  it.each(["auth", "params", "db", "logger"])("ordinary early %s exception preserves rejection", async stage => {
    const error = new Error(`early-${stage}`); if (stage === "auth") seam.authError = error; if (stage === "db") seam.dbError = error; if (stage === "logger") seam.loggerCreationThrow = true;
    if (stage === "params") await expect(POST(req(), { params: Promise.reject(error) })).rejects.toBe(error);
    else await expect(post()).rejects.toThrow(`early-${stage}`);
  });
  it("ordinary provider error keeps safe 500 and ordinary diagnostic throw is not swallowed", async () => {
    await database(); fakeFetch(vi.fn(async () => { throw new Error("private-provider-message"); }));
    await cancelled(await post(), "operation_failed"); expect(count("followup_qa")).toBe(0);
    seam.diagnosticsThrow = true; await expect(post()).rejects.toThrow("secondary-log");
  });
  it("ordinary actual SDK judge failure keeps historical errored answer and committed QA", async () => {
    await database(); fakeFetch(vi.fn(async (_url, init) => JSON.parse(String(init?.body)).model.includes("opus")
      ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "synthetic" } }), { status: 400, headers: { "content-type": "application/json" } })
      : structuredResponse(generated)));
    const r = await post(); expect(r.status).toBe(200); const qa = await r.json(); expect(qa.validation.errored).toBe(1); expect(qa.citations_used).toHaveLength(1);
    expect(count("followup_qa")).toBe(1); expect(count("consistency_cache")).toBe(0);
  });
  it("zero parent budget dispatches no SDK, adequate/default golden excludes flagged/blocked citations", async () => {
    await database(); const fetcher = transport(); await withTaskBudget(db, { taskBudgetUsd: 0 }, async () => cancelled(await post(), "task_budget_exceeded")); expect(fetcher).not.toHaveBeenCalled();
    const normal = await (await post()).json(); expect(normal.answer_md).toContain(quote); expect(normal.citations_used).toHaveLength(1); expect(normal.citations_used[0].content_item_id).toBe("c2g-content-0");
    expect(normal.validation).toEqual({ total: 1, reachable: 1, consistent: 1, blocked: 0, errored: 0 }); expect(fetcher).toHaveBeenCalledTimes(2);
    const payloads = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(JSON.stringify(payloads[0])).not.toContain("团队反馈良好"); expect(JSON.stringify(payloads[0])).not.toContain("不支持的合成引用");
    db.prepare("DELETE FROM consistency_cache").run(); const adequateFetcher = transport();
    const adequate = await withTaskBudget(db, { taskBudgetUsd: 1 }, async () => (await post()).json());
    for (const key of ["answer_md", "citations_used", "validation", "cost", "status", "turn_index", "question"]) expect(adequate[key]).toEqual(normal[key]);
    expect(adequateFetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual(payloads);
    const history = await (await GET(req(), { params: Promise.resolve({ id: "c2g-report" }) })).json(); expect(history.followups).toHaveLength(2);
  });
  it("two in-flight requests own independent signals and the surviving request commits", async () => {
    await database(); const other = new AbortController(); let release!: (r: Response) => void, enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    let n = 0; fakeFetch(vi.fn(async () => { if (++n === 1) { enter(); return new Promise<Response>(r => { release = r; }); } return structuredResponse(n === 2 ? generated : supported); }));
    const a = post(); await entered; const original = controller; controller = other; const b = post(); original.abort(); release(structuredResponse(generated));
    const [ra, rb] = await Promise.all([a, b]); await cancelled(ra); expect(rb.status).toBe(200); expect(count("followup_qa")).toBe(1); expect(other.signal.aborted).toBe(false);
  });
  it.each(["403", "404", "409", "400", "429", "200", "500", "cancel", "auth-throw", "params-throw", "db-throw", "logger-throw"])("outer listener is disposed on %s", async exit => {
    transport(); const request = req(exit === "400" ? "" : "?"); const add = vi.spyOn(request.signal, "addEventListener"); const remove = vi.spyOn(request.signal, "removeEventListener");
    seam.denied = exit === "403"; if (exit === "500") seam.coreError = new Error("ordinary"); if (exit === "cancel") seam.coreReturned = () => controller.abort();
    seam.reportNotReady = exit === "409";
    if (exit === "429") {
      seam.coreError = new Error("ordinary"); const key = request.headers.get("x-forwarded-for")!;
      for (let i = 0; i < 30; i++) await post(req("?", key));
    }
    if (exit === "auth-throw") seam.authError = new Error("auth"); if (exit === "db-throw") seam.dbError = new Error("db"); if (exit === "logger-throw") seam.loggerCreationThrow = true;
    if (exit === "params-throw") await expect(POST(request, { params: Promise.reject(new Error("params")) })).rejects.toThrow("params");
    else if (exit.endsWith("-throw")) await expect(post(request)).rejects.toThrow();
    else expect((await post(request, exit === "404" ? "absent" : "c2g-report")).status).toBe(exit === "cancel" ? 500 : Number(exit));
    const abortListeners = add.mock.calls.filter(([kind]) => kind === "abort"); expect(abortListeners).toHaveLength(1);
    for (const [, listener] of abortListeners) expect(remove.mock.calls.some(([kind, removed]) => kind === "abort" && removed === listener)).toBe(true);
  });
});
