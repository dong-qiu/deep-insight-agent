import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, type DB } from "../db/index.js";
import { listRuns } from "../db/repos.js";
import { runJob } from "./jobs.js";
vi.mock("./alert.js", () => ({ notifyFailure: vi.fn() }));
let db: DB;
beforeEach(() => { db = openDb(":memory:"); vi.useFakeTimers(); });
afterEach(() => { db.close(); vi.useRealTimers(); });
it("pre-cancelled Job does not invoke work and records a bounded terminal reason", async () => {
  const external = new AbortController(); external.abort(new Error("private-caller-token"));
  const work = vi.fn();
  await expect(runJob(db, { kind: "analyze", target: {}, signal: external.signal }, work)).rejects.toThrow("cancelled");
  expect(work).not.toHaveBeenCalled();
  expect(listRuns(db)[0]).toMatchObject({ status: "failed", error: { type: "cancelled", message: "cancelled" } });
  expect(vi.getTimerCount()).toBe(0);
});
it("deadline aborts the actual JobCtx signal and refuses a late successful result", async () => {
  let release!: (value: string) => void; let signal!: AbortSignal;
  const pending = runJob(db, { kind: "analyze", target: {}, deadlineAt: Date.now() + 10 }, async (ctx) => {
    signal = ctx.signal; return new Promise<string>((resolve) => { release = resolve; });
  });
  const rejected = expect(pending).rejects.toThrow("task_deadline_exceeded");
  await vi.advanceTimersByTimeAsync(10);
  expect(signal.aborted).toBe(true);
  release("late"); await rejected;
  expect(listRuns(db)[0]).toMatchObject({ status: "failed", error: { message: "task_deadline_exceeded" } });
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["external", "deadline"])("simultaneous cancellation keeps the first reason (%s)", async (first) => {
  const external = new AbortController(); let release!: () => void;
  const pending = runJob(db, { kind: "analyze", target: {}, signal: external.signal, deadlineAt: Date.now() + 10 }, async () => new Promise<void>((r) => { release = r; }));
  const rejected = expect(pending).rejects.toThrow(first === "external" ? "cancelled" : "task_deadline_exceeded");
  if (first === "external") external.abort();
  await vi.advanceTimersByTimeAsync(10);
  external.abort(); release(); await rejected;
  expect(listRuns(db)).toHaveLength(1);
  expect(listRuns(db)[0].status).toBe("failed");
  expect(vi.getTimerCount()).toBe(0);
});
it("fencing remains mandatory for cancellation failure cleanup", async () => {
  const external = new AbortController(); let owned = true;
  await expect(runJob(db, { kind: "analyze", target: {}, signal: external.signal, assertWrite: () => { if (!owned) throw new Error("generation_fence_lost"); } }, async () => {
    owned = false; external.abort(); return "late";
  })).rejects.toThrow("generation_fence_lost");
  expect(listRuns(db)[0].status).toBe("running");
  expect(vi.getTimerCount()).toBe(0);
});
it("success clears deadline and caller listener without changing output/cost", async () => {
  const external = new AbortController(); const add = vi.spyOn(external.signal, "addEventListener"); const remove = vi.spyOn(external.signal, "removeEventListener");
  const result = await runJob(db, { kind: "analyze", target: {}, signal: external.signal, deadlineAt: Date.now() + 100 }, async (ctx) => { ctx.recordCost({ tokens: 4, amount: 2 }); return 42; });
  expect(result).toMatchObject({ result: 42, run: { status: "done", cost: { tokens: 4, amount: 2 } } });
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([NaN, Infinity, -1, 1.5])("invalid deadline %s rejects before work or Run creation", async (deadlineAt) => {
  const work = vi.fn(); await expect(runJob(db, { kind: "analyze", target: {}, deadlineAt }, work)).rejects.toThrow("invalid_task_deadline");
  expect(work).not.toHaveBeenCalled(); expect(listRuns(db)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});
it("deadline checkpoint rejects after a blocked event loop even before timer callback runs", async () => {
  const deadlineAt = Date.now() + 10;
  await expect(runJob(db, { kind: "analyze", target: {}, deadlineAt }, async (ctx) => {
    vi.setSystemTime(deadlineAt); ctx.checkCancellation(); return "late";
  })).rejects.toThrow("task_deadline_exceeded");
  expect(listRuns(db)[0].status).toBe("failed"); expect(vi.getTimerCount()).toBe(0);
});
it("fencing insertion failure clears all owned deadline resources", async () => {
  const external = new AbortController(); const remove = vi.spyOn(external.signal, "removeEventListener");
  await expect(runJob(db, { kind: "analyze", target: {}, signal: external.signal, deadlineAt: Date.now() + 10, assertWrite: () => { throw new Error("generation_fence_lost"); } }, vi.fn())).rejects.toThrow("generation_fence_lost");
  expect(remove).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
