import { beforeEach, expect, it } from "vitest";
import { type DB, openDb } from "../db/index.js";
import { listRuns } from "../db/repos.js";
import { retryJob, runJob } from "./jobs.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
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
  expect(r.error?.message).toBe("boom");
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
