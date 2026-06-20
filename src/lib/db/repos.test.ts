/**
 * 持久层单测 —— 内存库（:memory:），无需 API key，CI 可跑（npm test）。
 * 验证 JSON 字段/bool 往返、去重判定、Run 状态机收尾。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ContentItem, Run, Source, Topic } from "../types.js";
import { type DB, openDb } from "./index.js";
import {
  contentExists, finishRun, getContentByUrl, getContentItem, getRun, getSource, getTopic,
  hasRunningRun, insertContentItem, insertRun, insertSource, insertTopic, listRuns,
  listRunsForTopicSince, listSources, recoverOrphanedRuns, sumRunCostSince, updateContentItem,
} from "./repos.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

const sampleSource: Source = {
  id: "src_arxiv_swe", name: "arXiv cs.SE", type: "arxiv",
  endpoint: "http://export.arxiv.org/api/query", industry: "ai-swe",
  topic_ids: ["t1", "t2"], fetch_interval: "6h",
  backfill: { depth: "90d", max_cost: 5 }, enabled: true,
};

it("Source 往返：JSON 数组 / backfill / bool", () => {
  insertSource(db, sampleSource);
  expect(getSource(db, "src_arxiv_swe")).toEqual(sampleSource);
});

it("Topic 往返 + enabledOnly 过滤", () => {
  const t: Topic = {
    id: "t1", name: "Code Agent", keywords: ["coding agent", "swe"],
    industry: "ai-swe", language: "zh", brief_schedule: "daily", enabled: true,
  };
  insertTopic(db, t);
  insertTopic(db, { ...t, id: "t2", enabled: false });
  expect(getTopic(db, "t1")).toEqual(t);
  expect(getTopic(db, "t2")?.enabled).toBe(false);
});

describe("ContentItem", () => {
  const item: ContentItem = {
    id: "ci1", source_id: "src_arxiv_swe", url: "https://arxiv.org/abs/2605.1",
    title: "T", author: null, published_at: "2026-05-20", fetched_at: "2026-05-25T00:00:00Z",
    language: "en", topic_ids: ["t1"], tags: [], body: "hello", body_kind: "article", raw_ref: "raw://1",
    content_hash: "h1", fetch_status: "ok",
  };
  beforeEach(() => insertSource(db, sampleSource));

  it("往返：含 null author / 空 tags", () => {
    insertContentItem(db, item);
    expect(getContentItem(db, "ci1")).toEqual(item);
  });

  it("contentExists 按 url+hash 判重", () => {
    insertContentItem(db, item);
    expect(contentExists(db, item.url, "h1")).toBe(true);
    expect(contentExists(db, item.url, "h2")).toBe(false); // 内容更新（hash 变）
  });

  it("AC2 同 url 内容更新：原地更新、行数不增、id 不变", () => {
    insertContentItem(db, item);
    expect(getContentByUrl(db, item.url)).toEqual({ id: "ci1", content_hash: "h1", body_kind: "article" });
    const updated: ContentItem = { ...item, content_hash: "h2", body: "new body", fetched_at: "2026-05-26T01:00:00Z" };
    updateContentItem(db, updated);
    const after = getContentItem(db, "ci1")!;
    expect(after.id).toBe("ci1"); // id 不变
    expect(after.content_hash).toBe("h2");
    expect(after.body).toBe("new body");
    expect(after.fetched_at).toBe("2026-05-26T01:00:00Z");
    expect((db.prepare("SELECT COUNT(*) c FROM content_item").get() as { c: number }).c).toBe(1); // 不新增
  });

  it("body_kind 往返（CHECK 接受 transcript）+ 可更新（show_notes→transcript 场景铺路）", () => {
    const tr: ContentItem = { ...item, id: "ci_tr", url: "https://x/tr", body_kind: "transcript" };
    insertContentItem(db, tr);
    expect(getContentItem(db, "ci_tr")!.body_kind).toBe("transcript");
    updateContentItem(db, { ...tr, body_kind: "show_notes", content_hash: "h9" });
    expect(getContentItem(db, "ci_tr")!.body_kind).toBe("show_notes");
  });
});

describe("Run 状态机", () => {
  const run: Run = {
    id: "run1", kind: "ingest", target: { source_id: "src_arxiv_swe" }, status: "running",
    started_at: new Date(Date.now() - 1000).toISOString(), ended_at: null, duration_ms: null,
    cost: null, error: null, retry_of: null,
  };

  it("insert → finish(done) 写 ended_at/duration/cost", () => {
    insertRun(db, run);
    finishRun(db, "run1", { status: "done", cost: { tokens: 1200, amount: 0.05 } });
    const r = getRun(db, "run1")!;
    expect(r.status).toBe("done");
    expect(r.cost).toEqual({ tokens: 1200, amount: 0.05 });
    expect(r.ended_at).not.toBeNull();
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("finish(failed) 写 error；listRuns 按 status 过滤", () => {
    insertRun(db, run);
    insertRun(db, { ...run, id: "run2" });
    finishRun(db, "run2", { status: "failed", error: { type: "Timeout", message: "x" } });
    expect(getRun(db, "run2")?.error?.type).toBe("Timeout");
    expect(listRuns(db, { status: "running" }).map((r) => r.id)).toEqual(["run1"]);
  });

  it("listRuns 按 kind 过滤 + offset 分页（started_at DESC）", () => {
    // 三条 ingest + 一条 analyze，started_at 递增
    insertRun(db, { ...run, id: "a", kind: "ingest", started_at: "2026-06-19T01:00:00Z" });
    insertRun(db, { ...run, id: "b", kind: "ingest", started_at: "2026-06-19T02:00:00Z" });
    insertRun(db, { ...run, id: "c", kind: "ingest", started_at: "2026-06-19T03:00:00Z" });
    insertRun(db, { ...run, id: "d", kind: "analyze", started_at: "2026-06-19T04:00:00Z" });
    expect(listRuns(db, { kind: "ingest" }).map((r) => r.id)).toEqual(["c", "b", "a"]); // 仅 ingest，倒序
    expect(listRuns(db, { kind: "analyze" }).map((r) => r.id)).toEqual(["d"]);
    // 分页：每页 2 条
    expect(listRuns(db, { kind: "ingest", limit: 2, offset: 0 }).map((r) => r.id)).toEqual(["c", "b"]);
    expect(listRuns(db, { kind: "ingest", limit: 2, offset: 2 }).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("sumRunCostSince", () => {
  const mk = (id: string, startedAt: string, amount: number | null): Run => ({
    id, kind: "analyze", target: { topic_id: "t1" }, status: "done",
    started_at: startedAt, ended_at: startedAt, duration_ms: 1, cost: amount == null ? null : { tokens: 1, amount },
    error: null, retry_of: null,
  });

  it("按 started_at 窗口累计 cost.amount；无 cost 的 Run 记 0", () => {
    insertRun(db, mk("a", "2026-06-13T08:00:00.000Z", 5));
    insertRun(db, mk("b", "2026-06-05T08:00:00.000Z", 10));
    insertRun(db, mk("c", "2026-05-20T08:00:00.000Z", 100));
    insertRun(db, mk("d", "2026-06-13T09:00:00.000Z", null)); // 确定性段、无成本
    expect(sumRunCostSince(db, "2026-06-13T00:00:00.000Z")).toBeCloseTo(5); // 仅今日
    expect(sumRunCostSince(db, "2026-06-01T00:00:00.000Z")).toBeCloseTo(15); // 本月
    expect(sumRunCostSince(db, "2026-05-01T00:00:00.000Z")).toBeCloseTo(115); // 含上月
  });

  it("无任何 Run → 0（COALESCE 兜底，不返 null）", () => {
    expect(sumRunCostSince(db, "2026-01-01T00:00:00.000Z")).toBe(0);
  });
});

describe("listRunsForTopicSince（深挖进度 3.3）", () => {
  const T = "2026-06-14T10:00:00.000Z"; // 触发锚点
  const mk = (id: string, kind: Run["kind"], target: Run["target"], startedAt: string, status: Run["status"] = "done"): Run => ({
    id, kind, target, status, started_at: startedAt, ended_at: startedAt, duration_ms: 1, cost: null, error: null, retry_of: null,
  });
  const topic: Topic = {
    id: "t1", name: "Code Agent", keywords: ["swe"],
    industry: "ai-swe", language: "zh", brief_schedule: "daily", enabled: true,
  };
  beforeEach(() => {
    insertTopic(db, { ...topic, id: "t1" });
    insertTopic(db, { ...topic, id: "t2" });
    // 本次深挖：analyze(topic_id) → batch(topic_id) → validate(batch_id) → report-gen(topic_id)
    db.prepare("INSERT INTO analysis_batch (id,topic_id,time_window,status) VALUES (?,?,?,?)")
      .run("b1", "t1", "{}", "done");
  });

  it("把 analyze/report-gen(topic_id) 与 validate(batch_id→topic) 三段按时序归集", () => {
    insertRun(db, mk("r-an", "analyze", { topic_id: "t1" }, "2026-06-14T10:00:05.000Z"));
    insertRun(db, mk("r-va", "validate", { batch_id: "b1" }, "2026-06-14T10:02:00.000Z"));
    insertRun(db, mk("r-rg", "report-gen", { topic_id: "t1", batch_id: "b1" }, "2026-06-14T10:04:00.000Z"));
    const runs = listRunsForTopicSince(db, "t1", T);
    expect(runs.map((r) => r.kind)).toEqual(["analyze", "validate", "report-gen"]); // started_at 升序
  });

  it("隔离别的主题、别的批次、触发前的历史 Run", () => {
    insertRun(db, mk("old", "analyze", { topic_id: "t1" }, "2026-06-14T09:00:00.000Z")); // 触发前
    insertRun(db, mk("t2-an", "analyze", { topic_id: "t2" }, "2026-06-14T10:05:00.000Z")); // 别的主题
    db.prepare("INSERT INTO analysis_batch (id,topic_id,time_window,status) VALUES (?,?,?,?)").run("b2", "t2", "{}", "done");
    insertRun(db, mk("t2-va", "validate", { batch_id: "b2" }, "2026-06-14T10:06:00.000Z")); // 别批次的校验
    insertRun(db, mk("mine", "analyze", { topic_id: "t1" }, "2026-06-14T10:05:00.000Z"));
    expect(listRunsForTopicSince(db, "t1", T).map((r) => r.id)).toEqual(["mine"]);
  });
});

describe("recoverOrphanedRuns（review follow-up #1）", () => {
  function freshRunningRun(id: string, kind: Run["kind"], targetField: string, val: string, startMsAgo = 5000): Run {
    return {
      id, kind, target: { [targetField]: val } as Run["target"], status: "running",
      started_at: new Date(Date.now() - startMsAgo).toISOString(),
      ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null,
    };
  }

  it("running Run 一刀切 → failed + error.type=OrphanedOnRestart + duration 补", () => {
    insertRun(db, freshRunningRun("orph1", "ingest", "source_id", "s1"));
    insertRun(db, freshRunningRun("orph2", "analyze", "topic_id", "t1", 10_000));
    insertRun(db, { ...freshRunningRun("done_keep", "ingest", "source_id", "s2"), status: "done",
      ended_at: new Date().toISOString(), duration_ms: 100 });
    const n = recoverOrphanedRuns(db);
    expect(n).toBe(2);
    const r1 = getRun(db, "orph1")!;
    expect(r1.status).toBe("failed");
    expect(r1.error?.type).toBe("OrphanedOnRestart");
    expect(r1.duration_ms).toBeGreaterThanOrEqual(0);
    expect(getRun(db, "done_keep")?.status).toBe("done");
  });

  it("无 running → 返 0、幂等", () => {
    expect(recoverOrphanedRuns(db)).toBe(0);
  });
});

describe("hasRunningRun（review follow-up #2 防并发）", () => {
  function freshRunningRun(id: string, kind: Run["kind"], targetField: string, val: string): Run {
    return {
      id, kind, target: { [targetField]: val } as Run["target"], status: "running",
      started_at: new Date().toISOString(),
      ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null,
    };
  }

  it("同 kind + 同 target 字段值 → true；不同 source / 不同 kind → false", () => {
    insertRun(db, freshRunningRun("r1", "ingest", "source_id", "src_a"));
    expect(hasRunningRun(db, "ingest", "source_id", "src_a")).toBe(true);
    expect(hasRunningRun(db, "ingest", "source_id", "src_b")).toBe(false);
    expect(hasRunningRun(db, "analyze", "source_id", "src_a")).toBe(false);
  });

  it("已 done 不计入 running 判断（finishRun 之后）", () => {
    insertRun(db, freshRunningRun("r1", "analyze", "topic_id", "t1"));
    finishRun(db, "r1", { status: "done" });
    expect(hasRunningRun(db, "analyze", "topic_id", "t1")).toBe(false);
  });
});
