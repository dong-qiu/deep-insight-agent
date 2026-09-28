import { beforeEach, expect, it, vi } from "vitest";
import { type DB, openDb } from "../db/index.js";
import { listRuns } from "../db/repos.js";
import { notifyFailure } from "./alert.js";
import { retryJob, runJob } from "./jobs.js";

vi.mock("./alert.js", () => ({ notifyFailure: vi.fn() }));

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  vi.mocked(notifyFailure).mockClear();
});

it("runJob 失败 + silent → 不发 notifyFailure（半开探测，3b-2）", async () => {
  await expect(
    runJob(db, { kind: "ingest", target: { source_id: "s", probe: true }, silent: true }, async () => {
      throw new Error("probe fail");
    }),
  ).rejects.toThrow("probe fail");
  expect(notifyFailure).not.toHaveBeenCalled();
});

it("runJob 失败 + 非 silent → 发 notifyFailure", async () => {
  await expect(
    runJob(db, { kind: "ingest", target: { source_id: "s" } }, async () => {
      throw new Error("real fail");
    }),
  ).rejects.toThrow();
  expect(notifyFailure).toHaveBeenCalledTimes(1);
});

it("opaque provider payload never enters Run SQL or notification; original error is rethrown", async () => {
  const error = Object.assign(new Error("synthetic-private-response"), { status: 503, cause: new Error("synthetic-private-cause") });
  await expect(runJob(db, { kind: "analyze", target: { topic_id: "t1" } }, async () => { throw error; })).rejects.toBe(error);
  const row = db.prepare("SELECT error FROM run").get() as { error: string };
  expect(JSON.parse(row.error)).toEqual({ type: "Error", message: "http_error_503" });
  expect(row.error).not.toContain("synthetic-private");
  expect(JSON.stringify(vi.mocked(notifyFailure).mock.calls)).not.toContain("synthetic-private");
  expect(error.message).toBe("synthetic-private-response");
});

it("non-Error throws still record failed Run and preserve the thrown value", async () => {
  await expect(runJob(db, { kind: "ingest", target: {} }, async () => { throw "synthetic-private-string"; })).rejects.toBe("synthetic-private-string");
  expect(listRuns(db)[0].error).toEqual({ type: "Error", message: "operation_failed" });
});

it("runJob 成功：Run done + 累加成本", async () => {
  const { run, result } = await runJob(db, { kind: "analyze", target: { topic_id: "t1" } }, async (ctx) => {
    ctx.recordCost({ tokens: 100, amount: 1 });
    ctx.recordCost({ tokens: 50, amount: 2 });
    return 42;
  });
  expect(result).toBe(42);
  expect(run.status).toBe("done");
  expect(run.cost).toEqual({ tokens: 150, amount: 3 });
  expect(run.ended_at).not.toBeNull();
  expect(run.duration_ms).toBeGreaterThanOrEqual(0);
});

it("runJob 失败：Run failed + error，并 rethrow", async () => {
  await expect(
    runJob(db, { kind: "ingest", target: {} }, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const r = listRuns(db, { status: "failed" })[0];
  expect(r.error?.message).toBe("operation_failed");
  expect(r.kind).toBe("ingest");
  expect(r.cost).toBeNull();
});

it("retryJob：新 Run 的 retry_of 指向原失败 Run、kind 继承", async () => {
  let origId = "";
  await runJob(db, { kind: "validate", target: { batch_id: "b1" } }, async (ctx) => {
    origId = ctx.runId;
    throw new Error("x");
  }).catch(() => undefined);
  const { run } = await retryJob(db, origId, async () => "ok");
  expect(run.retry_of).toBe(origId);
  expect(run.kind).toBe("validate");
  expect(run.status).toBe("done");
});
