/** followup 追问管线单测——mock callStructured（无 API key，CI 可跑），真 in-memory DB。
 *  覆盖：约束生成 + ref-in-pool + 一致性（support/not_support）+ answerable=false + judge 失败优雅降级。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 整模块 mock：followup 直接调 callStructured（role=followup），validator.judgeConsistency 也调它（role=validator）。
// consistencyCacheVersion 读 MODELS.validator，故 mock 须带 MODELS。
vi.mock("../runtime/llm.js", () => ({
  callStructured: vi.fn(),
  MODELS: { analyzer: "claude-sonnet-4-6", validator: "claude-opus-4-7", followup: "claude-sonnet-4-6" },
}));

import { callStructured } from "../runtime/llm.js";
import { saveAnalysisBatch } from "../db/analysis.js";
import { closeDb, openDb, type DB } from "../db/index.js";
import { insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import type { AnalysisBatch, ContentItem, Report, Source, Topic } from "../types.js";
import { answerFollowup } from "./followup.js";

const QUOTE = "test-first 把回归缺陷降了 38%";
const BODY = `一篇关于工程实践的文章。${QUOTE}，团队反馈良好。`;

function source(): Source {
  return {
    id: "src1", name: "机器之心", type: "rss", endpoint: "https://x.com/feed",
    industry: "ai-swe", topic_ids: ["t1"], fetch_interval: "6h", backfill: null, enabled: true,
  };
}
function topic(): Topic {
  return {
    id: "t1", name: "AI 工程", keywords: [], industry: "ai-swe", language: "zh",
    brief_schedule: "daily", enabled: true,
  };
}
function contentItem(): ContentItem {
  return {
    id: "ci_1", source_id: "src1", url: "https://x.com/a", title: "t", author: null,
    published_at: "2026-06-01T00:00:00Z", fetched_at: "2026-06-01T00:00:00Z", language: "zh",
    topic_ids: ["t1"], tags: ["test"], body: BODY, raw_ref: "raw://ci_1",
    content_hash: "h1", fetch_status: "ok",
  };
}
function batch(): AnalysisBatch {
  return {
    id: "ab_1", topic_id: "t1", time_window: { start: "2026-06-01T00:00:00Z", end: "2026-06-02T00:00:00Z" },
    status: "done", no_significant_event: false,
    insights: [
      {
        id: "ins_1", topic_id: "t1", type: "aggregation", event_id: null,
        statement: "test-first 降低回归缺陷", importance: 4, importance_basis: "多源",
        citations: [{ content_item_id: "ci_1", quote: QUOTE, locator: { paragraph_index: 0, char_start: 0, char_end: 10 } }],
        source_count: 1, multi_source: false,
        time_window: { start: "2026-06-01T00:00:00Z", end: "2026-06-02T00:00:00Z" },
        confidence: null, language: "zh",
      },
    ],
  };
}
function report(): Report {
  return {
    id: "rep_1", type: "brief", topic_id: "t1", status: "done", generated_at: "2026-06-02T00:00:00Z",
    title: "AI 工程 · brief", body_md: "# AI 工程 · brief\n\n## 1. test-first 降低回归缺陷 [1]\n",
    body_html: "", insight_ids: ["ins_1"], event_ids: [], prev_report_id: null,
    citation_count: 1, cost: { tokens: 0, amount: 0 },
  };
}

/** 生成调用（role=followup）的返回。 */
const gen = (data: unknown) =>
  ({ data, usage: {}, cost: { tokens: 100, amount: 0.001 } }) as unknown as Awaited<ReturnType<typeof callStructured>>;
/** 一致性调用（role=validator）的返回。 */
const judge = (consistency: string, reason = "ok") =>
  ({ data: { consistency, consistency_reason: reason, rationale: "r" }, usage: {}, cost: { tokens: 50, amount: 0.0005 } }) as unknown as Awaited<ReturnType<typeof callStructured>>;

let db: DB;
beforeEach(() => {
  process.env.VALIDATOR_RETRY_BACKOFF_MS = "0"; // 测试不等退避
  db = openDb(":memory:");
  insertSource(db, source());
  insertTopic(db, topic());
  insertContentItem(db, contentItem());
  saveAnalysisBatch(db, batch());
  vi.mocked(callStructured).mockReset();
});
afterEach(() => closeDb());

/** 按 role 分派 mock：followup → 生成；validator → 一致性。 */
function wire(genData: unknown, consistency: string, reason = "ok"): void {
  vi.mocked(callStructured).mockImplementation(async (opts: { role: string }) => {
    if (opts.role === "followup") return gen(genData);
    return judge(consistency, reason);
  });
}

describe("answerFollowup", () => {
  it("happy path：support → 引用保留 + 追加引用列表 + consistent 计数", async () => {
    wire(
      { answerable: true, answer_md: "根据报告，test-first 降低回归 [1]。", claims: [{ ref: 1, claim: "test-first 降低回归缺陷" }] },
      "support",
    );
    const r = await answerFollowup(db, report(), "test-first 效果如何？");
    expect(r.answerable).toBe(true);
    expect(r.citations_used).toHaveLength(1);
    expect(r.citations_used[0]).toMatchObject({ ref: 1, content_item_id: "ci_1", source_name: "机器之心" });
    expect(r.validation).toMatchObject({ total: 1, reachable: 1, consistent: 1, blocked: 0, errored: 0 });
    expect(r.answer_md).toContain("引用（1）：");
    expect(r.answer_md).toContain(`[1] [「${QUOTE}」](https://x.com/a)`);
    expect(r.cost.amount).toBeCloseTo(0.0015); // 生成 0.001 + 一致性 0.0005
  });

  it("not_support → 引用剔除 + 行内 [n] 从正文剥离 + blocked 计数", async () => {
    wire(
      { answerable: true, answer_md: "报告称效果显著 [1]。", claims: [{ ref: 1, claim: "效果显著到能消除所有缺陷" }] },
      "not_support",
      "exaggeration",
    );
    const r = await answerFollowup(db, report(), "效果如何？");
    expect(r.citations_used).toHaveLength(0);
    expect(r.validation).toMatchObject({ total: 1, reachable: 1, blocked: 1 });
    expect(r.answer_md).not.toContain("[1]"); // 落选 ref 已剥离
    expect(r.answer_md).not.toContain("引用（");
  });

  it("ref 不在池 → 结构性剔除（blocked），不打一致性", async () => {
    wire(
      { answerable: true, answer_md: "据称如此 [9]。", claims: [{ ref: 9, claim: "无中生有" }] },
      "support",
    );
    const r = await answerFollowup(db, report(), "?");
    expect(r.citations_used).toHaveLength(0);
    expect(r.validation).toMatchObject({ total: 1, reachable: 0, blocked: 1 });
    // 只调了生成一次，未调一致性（ref 不在池短路）
    expect(callStructured).toHaveBeenCalledTimes(1);
  });

  it("answerable=false → 原样返回，不校验、无引用", async () => {
    vi.mocked(callStructured).mockImplementation(async () =>
      gen({ answerable: false, answer_md: "本报告未涵盖该问题。", claims: [] }),
    );
    const r = await answerFollowup(db, report(), "天气如何？");
    expect(r.answerable).toBe(false);
    expect(r.citations_used).toHaveLength(0);
    expect(r.answer_md).toBe("本报告未涵盖该问题。");
    expect(callStructured).toHaveBeenCalledTimes(1); // 仅生成
  });

  it("judge 失败 → 优雅降级：引用保留 + errored 计数（非 blocked）", async () => {
    vi.mocked(callStructured).mockImplementation(async (opts: { role: string }) => {
      if (opts.role === "followup")
        return gen({ answerable: true, answer_md: "结论 [1]。", claims: [{ ref: 1, claim: "test-first 降低回归缺陷" }] });
      throw new Error("relay 5xx");
    });
    const r = await answerFollowup(db, report(), "?");
    expect(r.citations_used).toHaveLength(1); // 不因抖动剔除
    expect(r.validation).toMatchObject({ reachable: 1, errored: 1, blocked: 0, consistent: 0 });
  });
});
