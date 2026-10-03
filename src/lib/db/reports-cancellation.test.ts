import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertTopic } from "./repos.js";
import { MemoryAnchorStore } from "./integrity-anchors.js";
import { saveReport } from "./reports.js";
import type { Report, ReportIndexEntry } from "../types.js";
let db: DB; let dir: string;
const keys = generateKeyPairSync("ed25519"); const signer = { key_id: "test-c2a", private_key: keys.privateKey };
const report: Report = { id: "r1", type: "brief", topic_id: "t1", status: "done", generated_at: "2026-10-04T00:00:00Z", title: "synthetic", body_md: "body", body_html: "<p>body</p>", insight_ids: [], event_ids: [], prev_report_id: null, citation_count: 0, cost: { tokens: 0, amount: 0 } };
const index: ReportIndexEntry = { report_id: "r1", type: "brief", topic_id: "t1", facets: [], date: "2026-10-04", source_ids: [], title: "synthetic", summary: "", highlights: [], tags: [], entity_names: [], importance: 1, event_ids: [], milestone_count: 0 };
beforeEach(() => { db = openDb(":memory:"); applyProvenanceMigrations(db); insertTopic(db, { id: "t1", name: "t", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true }); dir = mkdtempSync(join(tmpdir(), "ia-c2a-report-")); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
it.each(["cancel", "lease"])("late immutable anchor result after %s does not commit publication or bypass cleanup guard", async (kind) => {
  const store = new MemoryAnchorStore(); let owned = true; const cancellation = new AbortController(); let release!: () => void; let entered!: () => void;
  const enteredPut = new Promise<void>((r) => { entered = r; }); const deferred = new Promise<void>((r) => { release = r; });
  const realPut = store.putIfAbsent.bind(store);
  vi.spyOn(store, "putIfAbsent").mockImplementation(async (...args) => { entered(); await deferred; return realPut(...args); });
  const assertWrite = (): void => { if (!owned) throw new Error("generation_fence_lost"); };
  const assertPublish = (): void => { assertWrite(); if (cancellation.signal.aborted) throw cancellation.signal.reason; };
  const pending = saveReport(db, report, index, { dir, assertWrite, assertPublish, signal: cancellation.signal, anchor: { signer, store, issuedAt: "2026-10-04T00:00:00Z", retainUntil: "2027-10-04T00:00:00Z", retentionEnds: ["2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z"] } });
  const rejected = expect(pending).rejects.toThrow(kind === "lease" ? "generation_fence_lost" : "cancelled");
  await enteredPut;
  const before = db.prepare("SELECT * FROM generation_anchor_effect ORDER BY id").all();
  if (kind === "lease") owned = false; else cancellation.abort(new Error("cancelled"));
  release(); await rejected;
  // Await the peer publication too, to catch writes after Promise.all's early rejection.
  await Promise.resolve(); await Promise.resolve();
  expect(db.prepare("SELECT * FROM generation_anchor_effect ORDER BY id").all()).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) n FROM report_index").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM artifact_manifest").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT status FROM report WHERE id='r1'").get()).toEqual({ status: kind === "lease" ? "generating" : "failed" });
});
it("lease loss while signing prevents signed-plan DB writes and later remote requests", async () => {
  const store = new MemoryAnchorStore(); let owned = true; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; }); const waiting = new Promise<void>((r) => { release = r; });
  const { sign } = await import("node:crypto");
  const signing = vi.fn(async (bytes: Uint8Array) => { entered(); await waiting; return sign(null, bytes, keys.privateKey); });
  const put = vi.spyOn(store, "putIfAbsent");
  const pending = saveReport(db, report, index, { dir, assertWrite: () => { if (!owned) throw new Error("generation_fence_lost"); }, anchor: { store, signer: { key_id: "test-c2a-managed", public_key: keys.publicKey, sign: signing }, issuedAt: "2026-10-04T00:00:00Z", retainUntil: "2027-10-04T00:00:00Z", retentionEnds: ["2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z"] } });
  const rejected = expect(pending).rejects.toThrow("generation_fence_lost"); await started; owned = false; release(); await rejected;
  await Promise.resolve(); await Promise.resolve();
  expect(signing).toHaveBeenCalledTimes(2); // one first-sign call per pre-started artifact, no second-sign call
  expect(put).not.toHaveBeenCalled(); expect(db.prepare("SELECT COUNT(*) n FROM generation_anchor_effect").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT status FROM report").get()).toEqual({ status: "generating" });
});
it("synchronous Job deadline checkpoint stops later signing/anchor I/O before the timer runs", async () => {
  vi.useFakeTimers();
  try {
    const { runJob } = await import("../runtime/jobs.js"); const { sign } = await import("node:crypto");
    const deadlineAt = Date.now() + 10; const store = new MemoryAnchorStore(); const put = vi.spyOn(store, "putIfAbsent");
    const signing = vi.fn(async (bytes: Uint8Array) => { vi.setSystemTime(deadlineAt); return sign(null, bytes, keys.privateKey); });
    await expect(runJob(db, { kind: "report-gen", target: {}, deadlineAt, silent: true }, async (ctx) => {
      await saveReport(db, report, index, { dir, signal: ctx.signal, checkCancellation: ctx.checkCancellation, anchor: { store, signer: { key_id: "test-c2a-managed", public_key: keys.publicKey, sign: signing }, issuedAt: "2026-10-04T00:00:00Z", retainUntil: "2027-10-04T00:00:00Z", retentionEnds: ["2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z"] } });
    })).rejects.toThrow("task_deadline_exceeded");
    expect(signing).toHaveBeenCalledOnce(); expect(put).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM generation_anchor_effect").get()).toEqual({ n: 0 }); expect(db.prepare("SELECT COUNT(*) n FROM report_index").get()).toEqual({ n: 0 }); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
