/** P0b-1 生产路径回归：scheduler 必须把定时采集真正接入 source_collect trace，不能只在 collector 单测里成立。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DB, openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { getGenerationTraceStatus } from "../db/provenance.js";
import { insertSource } from "../db/repos.js";
import type { RawItem } from "../sources/types.js";
import type { Source } from "../types.js";

const { raws, sources } = vi.hoisted(() => ({
  raws: { value: [] as RawItem[] },
  sources: { value: [] as Source[] },
}));
vi.mock("../sources/index.js", () => ({ fetchFromSource: vi.fn(async () => raws.value) }));
vi.mock("../config/index.js", async (orig) => ({
  ...(await orig<typeof import("../config/index.js")>()),
  getEffectiveSources: vi.fn(() => sources.value),
  loadStaticConfig: vi.fn(() => ({})),
}));

const { runCollectionCycle } = await import("./scheduler.js");

const source: Source = {
  id: "source_sched", name: "Scheduled source", type: "rss", endpoint: "https://example.test/feed",
  topic_ids: [], fetch_interval: "1h", backfill: null, enabled: true,
};
let db: DB;

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "scheduler-provenance-test-"));
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertSource(db, source);
  sources.value = [source];
  raws.value = [{
    url: "https://example.test/article/1", title: "Collected through scheduler", author: null,
    published_at: "2026-08-11T00:00:00.000Z", body: "A normalized content item.", raw: "raw fixture",
  }];
});
afterEach(() => {
  delete process.env.DATA_DIR;
  sources.value = [];
  raws.value = [];
});

describe("scheduled source provenance", () => {
  it("creates, claims and completes a source_collect trace on the real collection path", async () => {
    const summary = await runCollectionCycle(db);
    expect(summary.errors).toEqual([]);
    expect(summary.collected).toHaveLength(1);
    expect(summary.collected[0]).toMatchObject({ source: source.id, status: "done", inserted: 1 });
    const traceId = summary.collected[0].traceId!;
    expect(getGenerationTraceStatus(db, traceId)).toMatchObject({
      scope_kind: "source_collect", source_id: source.id, status: "done",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM generation_entity_ref WHERE trace_id=? AND entity_type='content_item' AND role='output'").get(traceId))
      .toEqual({ count: 1 });
  });
});
