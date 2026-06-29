/**
 * 持久层单测 —— 内存库（:memory:），无需 API key，CI 可跑（npm test）。
 * 验证 JSON 字段/bool 往返、去重判定、Run 状态机收尾。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ContentItem, Run, Source, Topic } from "../types.js";
import { type DB, openDb } from "./index.js";
import {
  clearCircuit, contentExists, finishRun, getContentByUrl, getContentItem, getRun, getSource,
  getSourceBodyKinds, getTopic, hasRunningRun, insertContentItem, insertRun, insertSource,
  insertTopic, listProbeCandidates, listRuns, listRunsForTopicSince, listSources, recoverOrphanedRuns,
  reviveSource, setCircuit, setLastProbe, setRunInserted, sumRunCostSince, updateContentItem, updateSource,
  updateTopic,
} from "./repos.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

const sampleSource: Source = {
  id: "src_arxiv_swe", name: "arXiv cs.SE", type: "arxiv",
  endpoint: "http://export.arxiv.org/api/query",
  topic_ids: ["t1", "t2"], fetch_interval: "6h",
  backfill: { depth: "90d", max_cost: 5 }, enabled: true,
  fetch_mode: "feed", content_container: null,
  disabled_reason: null, disabled_at: null, circuit_reset_at: null, last_probe_at: null,
};

describe("源熔断态（切片3b）", () => {
  beforeEach(() => insertSource(db, { ...sampleSource, id: "s1", topic_ids: [] }));

  it("setCircuit → enabled=0 + reason=circuit_open + 写 circuit_reset_at", () => {
    setCircuit(db, "s1");
    const s = getSource(db, "s1")!;
    expect(s.enabled).toBe(false);
    expect(s.disabled_reason).toBe("circuit_open");
    expect(s.disabled_at).toBeTruthy();
    expect(s.circuit_reset_at).toBeTruthy();
  });

  it("clearCircuit → 清 reason/disabled_at + 重写 circuit_reset_at（不强改 enabled）", () => {
    setCircuit(db, "s1");
    clearCircuit(db, "s1");
    const s = getSource(db, "s1")!;
    expect(s.disabled_reason).toBeNull();
    expect(s.disabled_at).toBeNull();
    expect(s.circuit_reset_at).toBeTruthy();
  });

  it("人工把熔断源拉回 enabled=1（updateSource）→ 自动 clearCircuit、不留脏态（评审🔴）", () => {
    setCircuit(db, "s1");
    updateSource(db, { ...sampleSource, id: "s1", topic_ids: [], enabled: true }); // 人工勾选启用保存
    const s = getSource(db, "s1")!;
    expect(s.enabled).toBe(true);
    expect(s.disabled_reason).toBeNull(); // 脏态已清
  });

  it("非熔断源的普通 updateSource → 不动熔断态（不误写 circuit_reset_at）", () => {
    updateSource(db, { ...sampleSource, id: "s1", topic_ids: [], name: "改名" });
    const s = getSource(db, "s1")!;
    expect(s.disabled_reason).toBeNull();
    expect(s.circuit_reset_at).toBeNull(); // 普通编辑不触发清态
  });

  // ── 半开自愈（3b-2）──
  it("listProbeCandidates：只选系统熔断源、节流过滤、按 last_probe_at 升序（NULL 最前）", () => {
    setCircuit(db, "s1"); // 系统熔断、last_probe_at NULL
    insertSource(db, { ...sampleSource, id: "s_manual", topic_ids: [], enabled: false }); // 人工停用（reason NULL）
    insertSource(db, { ...sampleSource, id: "s_probed", topic_ids: [] });
    setCircuit(db, "s_probed");
    setLastProbe(db, "s_probed"); // 刚探过 → 在 1 天节流内被过滤
    const now = new Date().toISOString();
    const cands = listProbeCandidates(db, now, 86_400_000, 5);
    expect(cands.map((c) => c.id)).toEqual(["s1"]); // s_manual 人工停用不入选；s_probed 节流内
  });

  it("setLastProbe → 记探测时间（节流锚点）", () => {
    setCircuit(db, "s1");
    setLastProbe(db, "s1");
    expect(getSource(db, "s1")!.last_probe_at).toBeTruthy();
  });

  it("reviveSource → enabled=1 + 清熔断态 + 清 last_probe_at", () => {
    setCircuit(db, "s1");
    setLastProbe(db, "s1");
    reviveSource(db, "s1");
    const s = getSource(db, "s1")!;
    expect(s.enabled).toBe(true);
    expect(s.disabled_reason).toBeNull();
    expect(s.last_probe_at).toBeNull();
  });
});

it("Source 往返：JSON 数组 / backfill / bool", () => {
  insertSource(db, sampleSource);
  expect(getSource(db, "src_arxiv_swe")).toEqual(sampleSource);
});

it("Topic 往返 + enabledOnly 过滤", () => {
  const t: Topic = {
    id: "t1", name: "Code Agent", keywords: ["coding agent", "swe"],
    language: "zh", brief_schedule: "daily", enabled: true,
    archetype: "deep_vertical", // ADR-0010：往返须含（insert 默认 deep_vertical，读回带它）
    facets: ["domain:software-engineering"], // ADR-0010：分类唯一维度，往返须含
  };
  insertTopic(db, t);
  insertTopic(db, { ...t, id: "t2", enabled: false });
  expect(getTopic(db, "t1")).toEqual(t);
  expect(getTopic(db, "t2")?.enabled).toBe(false);
});

it("Topic.facets 坏 JSON / 空数组读回 → []（Step2c：派生锚已退役，纯解析）", () => {
  const t: Topic = {
    id: "tf", name: "X", keywords: ["k"],
    language: "zh", brief_schedule: "daily", enabled: true, archetype: "deep_vertical",
    facets: ["domain:security"],
  };
  insertTopic(db, t);
  // 模拟存量坏值：直接把 facets 列写成非法 JSON 与空数组，读回都应是 []（不再从 industry 派生）
  for (const bad of ["not json", "[]"]) {
    db.prepare("UPDATE topic SET facets=? WHERE id='tf'").run(bad);
    expect(getTopic(db, "tf")?.facets).toEqual([]);
  }
});

it("updateTopic / updateSource 会 bump updated_at（审计可区分 seed 与人改；旧版漏写致时间戳骗人）", () => {
  const t: Topic = {
    id: "tu", name: "X", keywords: ["k"],
    language: "zh", brief_schedule: "daily", enabled: true, archetype: "deep_vertical", facets: [],
  };
  insertTopic(db, t);
  insertSource(db, { ...sampleSource, id: "su", topic_ids: [] });
  // 把两行 updated_at 强写成久远值，模拟 seed 时刻
  const OLD = "2000-01-01 00:00:00";
  db.prepare("UPDATE topic SET updated_at=? WHERE id='tu'").run(OLD);
  db.prepare("UPDATE source SET updated_at=? WHERE id='su'").run(OLD);

  updateTopic(db, { ...t, name: "改名" });
  updateSource(db, { ...sampleSource, id: "su", topic_ids: [], name: "改名" });

  const tu = db.prepare("SELECT updated_at FROM topic WHERE id='tu'").get() as { updated_at: string };
  const su = db.prepare("SELECT updated_at FROM source WHERE id='su'").get() as { updated_at: string };
  expect(tu.updated_at).not.toBe(OLD);
  expect(su.updated_at).not.toBe(OLD);
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

  it("getSourceBodyKinds 按 source_id 聚合去重形态（设置页标转写用）", () => {
    insertSource(db, { ...sampleSource, id: "src_pod" });
    insertContentItem(db, { ...item, id: "a", url: "https://x/a", body_kind: "article" });
    insertContentItem(db, { ...item, id: "b", url: "https://x/b", body_kind: "show_notes" });
    insertContentItem(db, { ...item, id: "c", url: "https://x/c", body_kind: "show_notes" }); // 重复形态去重
    insertContentItem(db, { ...item, id: "d", url: "https://x/d", source_id: "src_pod", body_kind: "transcript" });
    const map = getSourceBodyKinds(db);
    expect(map.get("src_arxiv_swe")).toEqual(new Set(["article", "show_notes"]));
    expect(map.get("src_pod")?.has("transcript")).toBe(true);
    expect(map.get("src_pod")?.has("article")).toBe(false);
    expect(map.has("src_nonexistent")).toBe(false); // 无内容的源不在 map 里
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

  it("setRunInserted 回填本轮入库数（切片3b-3）；新 run 默认 inserted=null", () => {
    insertRun(db, run);
    expect(getRun(db, "run1")!.inserted).toBeNull(); // 未回填 = NULL
    setRunInserted(db, "run1", 7);
    expect(getRun(db, "run1")!.inserted).toBe(7);
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
    language: "zh", brief_schedule: "daily", enabled: true,
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

  it("超 stale 阈值的 running → failed + OrphanedOnRestart + duration 补；新鲜并发 run 不动（Q2）", () => {
    insertRun(db, freshRunningRun("old_orphan", "ingest", "source_id", "s1", 60_000)); // 60s 前，超阈
    insertRun(db, freshRunningRun("fresh_live", "analyze", "topic_id", "t1", 2_000)); // 2s 前，新鲜并发
    insertRun(db, { ...freshRunningRun("done_keep", "ingest", "source_id", "s2"), status: "done",
      ended_at: new Date().toISOString(), duration_ms: 100 });
    const n = recoverOrphanedRuns(db, 30_000); // stale=30s
    expect(n).toBe(1); // 只回收孤儿，不误杀并发
    const r1 = getRun(db, "old_orphan")!;
    expect(r1.status).toBe("failed");
    expect(r1.error?.type).toBe("OrphanedOnRestart");
    expect(r1.duration_ms).toBeGreaterThanOrEqual(0);
    expect(getRun(db, "fresh_live")?.status).toBe("running"); // 关键：另一进程的并发 run 保留
    expect(getRun(db, "done_keep")?.status).toBe("done");
  });

  it("无超阈 running → 返 0、幂等（新鲜的不动）", () => {
    insertRun(db, freshRunningRun("fresh", "ingest", "source_id", "s1", 2_000));
    expect(recoverOrphanedRuns(db, 30_000)).toBe(0);
    expect(getRun(db, "fresh")?.status).toBe("running");
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
