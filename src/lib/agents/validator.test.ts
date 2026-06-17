/**
 * validator 纯函数单测 —— 不需要 API key，CI 可跑（npm test）。
 * 覆盖可达性校验与 verdict 处置矩阵（确定性逻辑）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// callStructured mock 掉——validateBatch 经 judgeConsistency 调它；无 API key、CI 可跑
vi.mock("../runtime/llm.js", () => ({
  callStructured: vi.fn(),
  MODELS: { analyzer: "claude-sonnet-4-6", validator: "claude-opus-4-7" }, // consistencyCacheVersion 读 MODELS.validator
}));

import { callStructured } from "../runtime/llm.js";
import { checkReachability, consistencyCacheVersion, insightInclusion, isValidationDegraded, summarize, validateBatch, verdictFor } from "./validator.js";
import type { CitationCheck, ContentItem, Insight } from "../types.js";

function item(id: string, body: string): ContentItem {
  return {
    id,
    source_id: "src",
    url: "https://example.com",
    title: "t",
    author: null,
    published_at: null,
    fetched_at: "2026-05-25T00:00:00Z",
    language: "en",
    topic_ids: [],
    tags: [],
    body,
    raw_ref: `raw://${id}`,
    content_hash: `h_${id}`,
    fetch_status: "ok",
  };
}

const items = new Map<string, ContentItem>([
  ["ci_1", item("ci_1", "The test-first loop reduced regressions by 38%.")],
]);

describe("checkReachability", () => {
  it("逐字命中 → pass", () => {
    expect(
      checkReachability({ content_item_id: "ci_1", quote: "reduced regressions by 38%" }, items),
    ).toEqual({ reachability: "pass", reason: "ok" });
  });

  it("空白归一后命中 → pass", () => {
    expect(
      checkReachability(
        { content_item_id: "ci_1", quote: "reduced   regressions\nby 38%" },
        items,
      ).reachability,
    ).toBe("pass");
  });

  it("片段不在原文 → fail / quote_not_in_source", () => {
    expect(
      checkReachability({ content_item_id: "ci_1", quote: "eliminated all regressions" }, items),
    ).toEqual({ reachability: "fail", reason: "quote_not_in_source" });
  });

  it("来源不存在 → fail / source_not_found", () => {
    expect(
      checkReachability({ content_item_id: "ci_missing", quote: "x" }, items),
    ).toEqual({ reachability: "fail", reason: "source_not_found" });
  });

  it("typography 等价（smart quotes/dashes/ellipsis）→ pass —— rep_54ed154e 13/13 blocked 的根因", () => {
    const m = new Map<string, ContentItem>([
      // body 含 smart quotes（采集后真实形态）
      ["ci_a", item("ci_a", "He’d seen the “static” intro and knew it deserved more—even wait…")],
    ]);
    // 模型产出 ASCII 等价 quote，过去会 reachability=fail；fold 后 pass
    expect(checkReachability({ content_item_id: "ci_a", quote: "He'd seen the \"static\" intro" }, m).reachability).toBe("pass");
    expect(checkReachability({ content_item_id: "ci_a", quote: "deserved more-even wait..." }, m).reachability).toBe("pass");
  });
});

describe("verdictFor（处置矩阵）", () => {
  it("可达性 fail → blocked", () => {
    expect(verdictFor("fail", "not_evaluated")).toBe("blocked");
  });
  it("pass + support → pass", () => {
    expect(verdictFor("pass", "support")).toBe("pass");
  });
  it("pass + not_support → blocked", () => {
    expect(verdictFor("pass", "not_support")).toBe("blocked");
  });
  it("pass + uncertain → flagged", () => {
    expect(verdictFor("pass", "uncertain")).toBe("flagged");
  });
});

/** 构造一条类型合法的 CitationCheck；summarize/insightInclusion 只关心 insight_id + verdict。 */
function check(insight_id: string, verdict: CitationCheck["verdict"]): CitationCheck {
  const base = { insight_id, citation_index: 0 };
  if (verdict === "pass") {
    return { ...base, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict };
  }
  if (verdict === "flagged") {
    return { ...base, reachability: "pass", reachability_reason: "ok", consistency: "uncertain", consistency_reason: "uncertain", verdict };
  }
  return { ...base, reachability: "fail", reachability_reason: "quote_not_in_source", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict };
}

describe("summarize（护栏与 releasable 对齐洞察级纳入判定）", () => {
  it("空批次 → releasable 诚实放行，洞察计数为 0", () => {
    const r = summarize([]);
    expect(r).toMatchObject({ total: 0, insights_total: 0, insights_includable: 0, releasable: true });
  });

  it("单洞察全 blocked → 不可纳入 → releasable=false", () => {
    const r = summarize([check("i1", "blocked"), check("i1", "blocked")]);
    expect(r.insights_total).toBe(1);
    expect(r.insights_includable).toBe(0);
    expect(r.releasable).toBe(false); // 引用级 pass=0；洞察级也 0 —— 两口径一致
  });

  it("混合：i1 含 1 pass（可纳入）、i2 全 blocked（排除）→ releasable=true 且纳入数=1", () => {
    const r = summarize([
      check("i1", "pass"),
      check("i1", "blocked"),
      check("i2", "blocked"),
    ]);
    expect(r.insights_total).toBe(2);
    expect(r.insights_includable).toBe(1); // 与 report-gen.selectInsights 纳入数一致
    expect(r.releasable).toBe(true);
  });

  it("flagged（待核实）也算可纳入", () => {
    const r = summarize([check("i1", "flagged")]);
    expect(r.insights_includable).toBe(1);
    expect(r.releasable).toBe(true);
  });

  it("insightInclusion 按 insight_id 分组、与 verdict 白名单一致", () => {
    expect(insightInclusion([check("a", "pass"), check("b", "blocked"), check("b", "flagged")])).toEqual({
      insights_total: 2,
      insights_includable: 2, // a 有 pass；b 有 genuine uncertain flagged
    });
  });

  it("#2：唯一引用「校验失败」(pass+not_evaluated) 的洞察不计入 includable，但计入 total", () => {
    // 校验失败 check：flagged 但 consistency=not_evaluated（与 genuine uncertain 区分）
    const errCheck: CitationCheck = {
      insight_id: "e1", citation_index: 0, reachability: "pass", reachability_reason: "ok",
      consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "flagged",
    };
    expect(insightInclusion([errCheck])).toEqual({ insights_total: 1, insights_includable: 0 });
    // 但同洞察若另有一条 pass → 可纳入
    expect(insightInclusion([errCheck, check("e1", "pass")])).toEqual({ insights_total: 1, insights_includable: 1 });
    // summarize 同源：纯校验失败批次 → releasable=false（不发零成功校验报告）
    const r = summarize([errCheck]);
    expect(r).toMatchObject({ flagged: 1, flagged_rate: 0, insights_includable: 0, releasable: false });
  });
});

/** 构造一条最小合法 Insight（validateBatch 只读 statement + citations）。 */
function insight(id: string, statement: string, cits: { content_item_id: string; quote: string }[]): Insight {
  return {
    id, topic_id: "t1", type: "aggregation", event_id: null, statement, importance: 4,
    importance_basis: "x",
    citations: cits.map((c) => ({ ...c, locator: { paragraph_index: 0, char_start: 0, char_end: 1 } })),
    source_count: 1, multi_source: false,
    time_window: { start: "2026-05-01", end: "2026-05-07" }, confidence: null, language: "en",
  };
}
const judgeData = (consistency: "support" | "not_support" | "uncertain", reason: string) =>
  ({ data: { consistency, consistency_reason: reason, rationale: "r" } }) as unknown as Awaited<ReturnType<typeof callStructured>>;
/** 批量判定 mock 返回（judgments 数组，挂 index）。 */
const batchJudgeData = (judgments: { index: number; consistency: string; consistency_reason: string }[]) =>
  ({ data: { judgments: judgments.map((j) => ({ ...j, rationale: "r" })) } }) as unknown as Awaited<ReturnType<typeof callStructured>>;

describe("consistencyCacheVersion", () => {
  afterEach(() => { delete process.env.VALIDATOR_THINKING; });
  it("含校验模型；翻转 VALIDATOR_THINKING → 版本变（精度旋钮纳入隔离）", () => {
    delete process.env.VALIDATOR_THINKING; // 默认 thinking on
    const on = consistencyCacheVersion();
    expect(on).toContain("claude-opus-4-7"); // 默认校验模型
    expect(on.endsWith("|t1")).toBe(true);
    process.env.VALIDATOR_THINKING = "0";
    const off = consistencyCacheVersion();
    expect(off.endsWith("|t0")).toBe(true);
    expect(off).not.toBe(on); // thinking 档位变 → 版本变 → 旧判定不命中
  });
});

describe("validateBatch（A 去重 + C 校验失败分账）", () => {
  // 默认关掉应用层重试 + 退避，让这些测试的"每源判一次"调用计数确定（重试单独测）。
  beforeEach(() => { process.env.VALIDATOR_RETRIES = "0"; process.env.VALIDATOR_RETRY_BACKOFF_MS = "0"; });
  // 用 afterEach + restoreAllMocks 而非 beforeEach+mockReset：后者在「先 resolve 的测试 →
  // 再 reject 的测试」序列下会让 vitest 的未处理拒绝追踪误把已 catch 的拒绝算到测试头上。
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VALIDATOR_RETRIES;
    delete process.env.VALIDATOR_RETRY_BACKOFF_MS;
  });

  it("A：同洞察多引用指向同一源 → 一致性只判一次、复用结果", async () => {
    const items = [item("ci_x", "Membrane pairs blocking and permitting. Highest F1 on six attacks. Benign refusal 7-14%.")];
    const ins = insight("i1", "Membrane 在六种攻击上最高 F1", [
      { content_item_id: "ci_x", quote: "Membrane pairs blocking" },
      { content_item_id: "ci_x", quote: "Highest F1 on six attacks" },
      { content_item_id: "ci_x", quote: "Benign refusal 7-14%" },
    ]);
    vi.mocked(callStructured).mockResolvedValue(judgeData("support", "ok"));

    const { checks } = await validateBatch([ins], items);
    expect(callStructured).toHaveBeenCalledTimes(1); // 3 引用同源 → 判 1 次
    expect(checks.map((c) => c.verdict)).toEqual(["pass", "pass", "pass"]); // 复用同一结果，无相互矛盾
  });

  it("A：不同源各判一次", async () => {
    const items = [item("ci_a", "alpha body text"), item("ci_b", "beta body text")];
    const ins = insight("i2", "S", [
      { content_item_id: "ci_a", quote: "alpha body" },
      { content_item_id: "ci_b", quote: "beta body" },
    ]);
    vi.mocked(callStructured).mockResolvedValue(judgeData("support", "ok"));
    await validateBatch([ins], items);
    expect(callStructured).toHaveBeenCalledTimes(2);
  });

  it("C：一致性调用抛错 → reachability=pass + consistency=not_evaluated + verdict=flagged（与 genuine uncertain 区分）", async () => {
    const items = [item("ci_y", "some reachable body content")];
    const ins = insight("i3", "S", [{ content_item_id: "ci_y", quote: "reachable body" }]);
    vi.mocked(callStructured).mockImplementation(async () => { throw new Error("timeout"); });

    const { checks } = await validateBatch([ins], items);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      reachability: "pass", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "flagged",
    });
  });

  it("C：失败结果同样按源去重复用（不重复重试同一源）", async () => {
    const items = [item("ci_z", "shared reachable body here")];
    const ins = insight("i4", "S", [
      { content_item_id: "ci_z", quote: "shared reachable" },
      { content_item_id: "ci_z", quote: "reachable body" },
    ]);
    vi.mocked(callStructured).mockImplementation(async () => { throw new Error("rate limit"); });
    const { checks } = await validateBatch([ins], items);
    expect(callStructured).toHaveBeenCalledTimes(1); // 失败也只调一次
    expect(checks.every((c) => c.verdict === "flagged" && c.consistency === "not_evaluated")).toBe(true);
  });

  it("缓存命中 → 跳过 Opus（0 次调用）、复用判定、不计 onCost", async () => {
    const items = [item("ci_c1", "cached body content here")];
    const ins = insight("ic1", "S", [{ content_item_id: "ci_c1", quote: "cached body" }]);
    const cache = { get: () => ({ consistency: "support" as const, consistency_reason: "ok" as const, rationale: "(cached)" }), set: vi.fn() };
    const onCost = vi.fn();
    const { checks } = await validateBatch([ins], items, onCost, cache);
    expect(callStructured).not.toHaveBeenCalled(); // 命中 → 不打 LLM
    expect(checks[0].verdict).toBe("pass");
    expect(cache.set).not.toHaveBeenCalled(); // 命中不回写
    expect(onCost).not.toHaveBeenCalled(); // 命中不计成本（缓存的本职）
  });

  it("uncertain 判定不回写缓存（边界判定每次重判，不冻结待核实）", async () => {
    const items = [item("ci_cu", "uncertain body content here")];
    const ins = insight("icu", "S", [{ content_item_id: "ci_cu", quote: "uncertain body" }]);
    const cache = { get: () => undefined, set: vi.fn() };
    vi.mocked(callStructured).mockResolvedValue(judgeData("uncertain", "uncertain"));
    const { checks } = await validateBatch([ins], items, undefined, cache);
    expect(cache.set).not.toHaveBeenCalled(); // uncertain 不缓存
    expect(checks[0].verdict).toBe("flagged");
  });

  it("缓存 set 抛错 → 不污染已成功的判定（仍 pass，不降级为校验失败）", async () => {
    const items = [item("ci_cs", "body for set-throw case")];
    const ins = insight("ics", "S", [{ content_item_id: "ci_cs", quote: "body for set" }]);
    const cache = { get: () => undefined, set: vi.fn(() => { throw new Error("SQLITE_BUSY"); }) };
    vi.mocked(callStructured).mockResolvedValue(judgeData("support", "ok"));
    const { checks } = await validateBatch([ins], items, undefined, cache);
    expect(cache.set).toHaveBeenCalledTimes(1); // 试图写
    expect(checks[0].verdict).toBe("pass"); // 写失败被吞，判定不回退
    expect(checks[0].consistency).toBe("support");
  });

  it("缓存未命中 + 成功 → 调 Opus 1 次并回写缓存", async () => {
    const items = [item("ci_c2", "fresh body content here")];
    const ins = insight("ic2", "Sx", [{ content_item_id: "ci_c2", quote: "fresh body" }]);
    const store = new Map<string, unknown>();
    const cache = { get: () => undefined, set: vi.fn((s: string, b: string) => store.set(s + b, 1)) };
    vi.mocked(callStructured).mockResolvedValue(judgeData("support", "ok"));
    await validateBatch([ins], items, undefined, cache);
    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1); // 成功 → 回写
  });

  it("缓存未命中 + 调用失败 → 绝不回写缓存（瞬时抖动须重试）", async () => {
    const items = [item("ci_c3", "erroring body content here")];
    const ins = insight("ic3", "Sy", [{ content_item_id: "ci_c3", quote: "erroring body" }]);
    const cache = { get: () => undefined, set: vi.fn() };
    vi.mocked(callStructured).mockImplementation(async () => { throw new Error("relay 5xx"); });
    const { checks } = await validateBatch([ins], items, undefined, cache);
    expect(cache.set).not.toHaveBeenCalled(); // 失败绝不缓存
    expect(checks[0]).toMatchObject({ consistency: "not_evaluated", verdict: "flagged" });
  });

  it("抗抖：瞬时失败一次后重试成功 → pass（不记校验失败）", async () => {
    process.env.VALIDATOR_RETRIES = "2"; // 覆盖 beforeEach 的 0
    const items = [item("ci_r", "retry body content here")];
    const ins = insight("ir", "S", [{ content_item_id: "ci_r", quote: "retry body" }]);
    let n = 0;
    vi.mocked(callStructured).mockImplementation(async () => {
      if (n++ === 0) throw new Error("transient blip");
      return judgeData("support", "ok");
    });
    const { checks } = await validateBatch([ins], items);
    expect(callStructured).toHaveBeenCalledTimes(2); // 1 失败 + 1 重试成功
    expect(checks[0].verdict).toBe("pass");
  });

  it("抗抖：重试耗尽仍失败 → 记校验失败（not_evaluated），调用 1+retries 次", async () => {
    process.env.VALIDATOR_RETRIES = "2";
    const items = [item("ci_r2", "body content here")];
    const ins = insight("ir2", "S", [{ content_item_id: "ci_r2", quote: "body content" }]);
    vi.mocked(callStructured).mockImplementation(async () => { throw new Error("relay down"); });
    const { checks } = await validateBatch([ins], items);
    expect(callStructured).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(checks[0]).toMatchObject({ consistency: "not_evaluated", verdict: "flagged" });
  });
});

describe("validateBatch（B 按源归并批量判定 · 成本最大杠杆）", () => {
  beforeEach(() => { process.env.VALIDATOR_RETRIES = "0"; process.env.VALIDATOR_RETRY_BACKOFF_MS = "0"; });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VALIDATOR_RETRIES;
    delete process.env.VALIDATOR_RETRY_BACKOFF_MS;
    delete process.env.VALIDATOR_BATCH;
    delete process.env.CONSISTENCY_BATCH_MAX;
  });

  it("两洞察引同一源、缓存未命中 → 合并 1 次批量调用，各得对应判定", async () => {
    const items = [item("ci_b", "Shared source body that supports both claims about X and Y.")];
    const ins1 = insight("ib1", "结论 X", [{ content_item_id: "ci_b", quote: "supports both" }]);
    const ins2 = insight("ib2", "结论 Y", [{ content_item_id: "ci_b", quote: "claims about X" }]);
    vi.mocked(callStructured).mockResolvedValue(batchJudgeData([
      { index: 1, consistency: "support", consistency_reason: "ok" },
      { index: 2, consistency: "not_support", consistency_reason: "exaggeration" },
    ]));
    const { checks } = await validateBatch([ins1, ins2], items);
    expect(callStructured).toHaveBeenCalledTimes(1); // 两条同源 → 一次批量（body 只发一遍）
    expect(checks.map((c) => c.verdict)).toEqual(["pass", "blocked"]); // 按 index 对齐回 ins1/ins2
  });

  it("批量判定按 index 对齐回各结论（返回乱序也对）", async () => {
    const items = [item("ci_o", "Body mentions alpha clearly but not beta.")];
    const ins1 = insight("io1", "alpha 成立", [{ content_item_id: "ci_o", quote: "alpha clearly" }]);
    const ins2 = insight("io2", "beta 成立", [{ content_item_id: "ci_o", quote: "not beta" }]);
    vi.mocked(callStructured).mockResolvedValue(batchJudgeData([
      { index: 2, consistency: "not_support", consistency_reason: "out_of_context" }, // 乱序：先 2 后 1
      { index: 1, consistency: "support", consistency_reason: "ok" },
    ]));
    const { checks } = await validateBatch([ins1, ins2], items);
    expect(checks[0]).toMatchObject({ consistency: "support", verdict: "pass" }); // ins1 = index 1
    expect(checks[1]).toMatchObject({ consistency: "not_support", verdict: "blocked" }); // ins2 = index 2
  });

  it("批量产出残缺（少一条）→ 整组记校验失败，绝不把缺项默认成 support", async () => {
    const items = [item("ci_p", "Body for partial output case alpha beta.")];
    const ins1 = insight("ip1", "A", [{ content_item_id: "ci_p", quote: "alpha" }]);
    const ins2 = insight("ip2", "B", [{ content_item_id: "ci_p", quote: "beta" }]);
    vi.mocked(callStructured).mockResolvedValue(batchJudgeData([
      { index: 1, consistency: "support", consistency_reason: "ok" }, // 缺 index 2
    ]));
    const { checks } = await validateBatch([ins1, ins2], items);
    expect(checks.every((c) => c.consistency === "not_evaluated" && c.verdict === "flagged")).toBe(true);
  });

  it("VALIDATOR_BATCH=0 → 退回逐条判定（两洞察同源 → 2 次单条调用）", async () => {
    process.env.VALIDATOR_BATCH = "0";
    const items = [item("ci_k", "Kill switch body alpha beta gamma.")];
    const ins1 = insight("ik1", "A", [{ content_item_id: "ci_k", quote: "alpha" }]);
    const ins2 = insight("ik2", "B", [{ content_item_id: "ci_k", quote: "beta" }]);
    vi.mocked(callStructured).mockResolvedValue(judgeData("support", "ok"));
    await validateBatch([ins1, ins2], items);
    expect(callStructured).toHaveBeenCalledTimes(2); // 关批量 → 每条各打一次
  });

  it("超 CONSISTENCY_BATCH_MAX → 拆多次批量调用（源文各发一遍，仍省于逐条）", async () => {
    process.env.CONSISTENCY_BATCH_MAX = "2";
    const items = [item("ci_s", "Split body a1 a2 a3 a4 here.")];
    const inss = ["a1", "a2", "a3", "a4"].map((q, i) => insight(`is${i}`, `S${i}`, [{ content_item_id: "ci_s", quote: q }]));
    vi.mocked(callStructured).mockResolvedValue(batchJudgeData([
      { index: 1, consistency: "support", consistency_reason: "ok" },
      { index: 2, consistency: "support", consistency_reason: "ok" },
    ]));
    await validateBatch(inss, items);
    expect(callStructured).toHaveBeenCalledTimes(2); // 4 条同源、max=2 → [2,2] 两次批量
  });

  it("批量里 success 回写缓存、uncertain 不回写", async () => {
    const items = [item("ci_u", "Body uncertain-mix alpha beta.")];
    const ins1 = insight("iu1", "A", [{ content_item_id: "ci_u", quote: "alpha" }]);
    const ins2 = insight("iu2", "B", [{ content_item_id: "ci_u", quote: "beta" }]);
    const cache = { get: () => undefined, set: vi.fn() };
    vi.mocked(callStructured).mockResolvedValue(batchJudgeData([
      { index: 1, consistency: "support", consistency_reason: "ok" },
      { index: 2, consistency: "uncertain", consistency_reason: "uncertain" },
    ]));
    await validateBatch([ins1, ins2], items, undefined, cache);
    expect(cache.set).toHaveBeenCalledTimes(1); // 只 support 回写、uncertain 不冻结待核实
  });

  it("部分缓存命中 → 仅未命中的结论进调用", async () => {
    const items = [item("ci_h", "Body partial cache alpha beta.")];
    const ins1 = insight("ih1", "结论A", [{ content_item_id: "ci_h", quote: "alpha" }]);
    const ins2 = insight("ih2", "结论B", [{ content_item_id: "ci_h", quote: "beta" }]);
    const cache = {
      get: (s: string) => (s === "结论A" ? { consistency: "support" as const, consistency_reason: "ok" as const, rationale: "(cached)" } : undefined),
      set: vi.fn(),
    };
    vi.mocked(callStructured).mockResolvedValue(judgeData("not_support", "exaggeration")); // 剩 1 条 → 逐条 shape
    const { checks } = await validateBatch([ins1, ins2], items, undefined, cache);
    expect(callStructured).toHaveBeenCalledTimes(1); // 仅 结论B 打 LLM
    expect(checks[0]).toMatchObject({ consistency: "support", verdict: "pass" }); // A 来自缓存
    expect(checks[1]).toMatchObject({ consistency: "not_support", verdict: "blocked" }); // B 来自 LLM
  });
});

describe("summarize.errored + isValidationDegraded（抗抖可观测/告警）", () => {
  const mk = (verdict: CitationCheck["verdict"], consistency: CitationCheck["consistency"], reachability: CitationCheck["reachability"] = "pass"): CitationCheck => ({
    insight_id: "i", citation_index: 0, reachability,
    reachability_reason: reachability === "fail" ? "quote_not_in_source" : "ok",
    consistency, consistency_reason: consistency === "uncertain" ? "uncertain" : consistency === "support" ? "ok" : "not_evaluated",
    verdict,
  });

  it("errored 只计 reachability=pass + not_evaluated（校验失败），不污染 flagged_rate", () => {
    const r = summarize([mk("flagged", "not_evaluated"), mk("flagged", "uncertain"), mk("pass", "support")]);
    expect(r.errored).toBe(1);       // 仅校验失败那条
    expect(r.flagged).toBe(2);       // verdict=flagged 两条（校验失败 + genuine uncertain）
    expect(r.flagged_rate).toBeCloseTo(1 / 3); // 仅 consistency=uncertain 计入
  });

  it("可达引用过半校验失败 → degraded=true（达阈值告警）", () => {
    expect(isValidationDegraded([mk("flagged", "not_evaluated"), mk("flagged", "not_evaluated"), mk("pass", "support")], 0.5)).toBe(true); // 2/3
  });
  it("少量失败 → degraded=false（不刷告警）", () => {
    expect(isValidationDegraded([mk("flagged", "not_evaluated"), mk("pass", "support"), mk("pass", "support")], 0.5)).toBe(false); // 1/3
  });
  it("无可达引用（全 blocked-unreachable）→ degraded=false（不误报）", () => {
    expect(isValidationDegraded([mk("blocked", "not_evaluated", "fail")], 0.5)).toBe(false);
  });
});
