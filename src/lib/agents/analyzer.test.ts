/**
 * analyzer 产出守卫的纯函数单测 —— 无需 API key，CI 可跑（npm test）。
 * 覆盖截断检测（结构化输出偶发把长 statement 提前收尾）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Citation, ContentItem, Insight, Topic } from "../types.js";
// callStructured mock 掉——repairCoverage 经 verifyCandidates 调它；无 API key、CI 可跑纯函数。
vi.mock("../runtime/llm.js", () => ({
  callStructured: vi.fn(),
  MODELS: { analyzer: "test-analyzer", validator: "test-validator" },
}));
import { callStructured } from "../runtime/llm.js";
import { ANALYZE_BODY_CHARS, ANALYZER_SYSTEM, CITATION_CLAUSE_AUDIT, QuoteCoverageRejectedError, REPAIR_QUOTE_MIN_PREFIX, SELECT_SEPARATOR, analyze, canonicalizeInsightEvents, carveQuote, chunkByChars, chunkWindows, coverageGaps, filterByQuoteCoverage, isCompleteStatement, quoteCoverageClauses, renderImportanceBasis, repairCitationSource, repairCoverage, repairQuote, selectForAnalyze, specificClaims, truncateForAnalyze } from "./analyzer.js";
import { AnalyzerOutputSchema } from "../types.js";

describe("AnalyzerOutputSchema 的原子 citation claim", () => {
  const base = {
    no_significant_event: false,
    insights: [{
      statement: "事实 A。", statement_citation_index: 1, headline: "事实 A", type: "aggregation", importance: 3,
      importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1], confidence: null,
      event_id: null, is_followup: false, entities: [], tags: [],
      citations: [{ content_item_id: "ci1", quote: "fact A", claim: "事实 A" }],
    }],
  };

  it("新 analyzer 输出要求每条 citation 给出原子 claim", () => {
    expect(AnalyzerOutputSchema.safeParse(base).success).toBe(true);
    const withoutClaim = structuredClone(base);
    delete (withoutClaim.insights[0].citations[0] as { claim?: string }).claim;
    expect(AnalyzerOutputSchema.safeParse(withoutClaim).success).toBe(false);
  });

  it("新 analyzer 输出要求 statement 显式绑定唯一 citation", () => {
    const withoutBinding = structuredClone(base);
    delete (withoutBinding.insights[0] as { statement_citation_index?: number }).statement_citation_index;
    expect(AnalyzerOutputSchema.safeParse(withoutBinding).success).toBe(false);
  });

  it("新 analyzer 输出拒绝自由文本 importance_basis，要求受控理由与 statement/headline 锚点", () => {
    const legacy = structuredClone(base);
    const row = legacy.insights[0] as Record<string, unknown>;
    delete row.importance_facts;
    delete row.importance_reason;
    delete row.importance_reason_claim_indexes;
    row.importance_basis = "该结果对生产 RAG 很重要";
    expect(AnalyzerOutputSchema.safeParse(legacy).success).toBe(false);
  });
});

describe("analyze 的展示覆盖审计投影", () => {
  it("将审计前候选 ID 映射到最终 insight ID，并生成可持久化的 citation_ref/audit", async () => {
    vi.mocked(callStructured).mockReset();
    vi.mocked(callStructured)
      .mockResolvedValueOnce({ data: {
        no_significant_event: false,
        insights: [{
          statement: "Fact is supported.", statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
          importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1],
          confidence: null, event_id: null, is_followup: false, entities: [], tags: [],
          citations: [{ content_item_id: "ci", claim: "Fact is supported", quote: "Fact is supported." }],
        }],
      } } as unknown as Awaited<ReturnType<typeof callStructured>>)
      .mockResolvedValueOnce({ data: { verdicts: [{
        index: 1, kind: "factual", supports: true, citation_indexes: [1],
        evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: "Fact is supported.".length, evidence_excerpt: "Fact is supported." }],
      }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    const topic: Topic = { id: "t", name: "T", keywords: [], language: "en", brief_schedule: "daily", enabled: true };
    const content: ContentItem = {
      id: "ci", source_id: "s", url: "https://example.test", title: "T", author: null, published_at: null,
      fetched_at: "2026-09-09T00:00:00.000Z", language: "en", topic_ids: ["t"], tags: [],
      body: "Fact is supported.", body_kind: "article", raw_ref: "", content_hash: "h", fetch_status: "ok",
    };

    const batch = await analyze(topic, [content], { start: "2026-09-09", end: "2026-09-09" });
    const [insight] = batch.insights;
    expect(insight.id).toMatch(/^ins_batch_/);
    expect(insight.citations[0].citation_ref).toMatch(/^cite_/);
    expect(batch.display_coverage_audits).toMatchObject([{
      insight_id: insight.id,
      candidate_id: expect.stringMatching(/^ins_/),
      terminal_reason: "kept",
      decision: { claims: expect.any(Array) },
    }]);
    expect(batch.display_coverage_state).toBe("audited");
    expect(batch.display_coverage_candidate_audits).toMatchObject([{
      candidate_id: expect.stringMatching(/^ins_/), insight_id: insight.id, terminal_reason: "kept",
    }]);
  });

  it("所有候选被核心 statement 覆盖门拒绝时失败，不伪装为 no_significant_event", async () => {
    vi.mocked(callStructured).mockReset();
    vi.mocked(callStructured)
      .mockResolvedValueOnce({ data: {
        no_significant_event: false,
        insights: [{
          statement: "Unsupported claim.", statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
          importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1],
          confidence: null, event_id: null, is_followup: false, entities: [], tags: [],
          citations: [{ content_item_id: "ci", claim: "different fact", quote: "Source quote." }],
        }],
      } } as unknown as Awaited<ReturnType<typeof callStructured>>)
      .mockResolvedValueOnce({ data: { verdicts: [{
        index: 1, kind: "factual", supports: false, citation_indexes: [], evidence_spans: [],
      }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    const topic: Topic = { id: "t", name: "T", keywords: [], language: "en", brief_schedule: "daily", enabled: true };
    const content = {
      id: "ci", source_id: "s", url: "https://example.test", title: "T", author: null, published_at: null,
      fetched_at: "2026-09-09T00:00:00.000Z", language: "en", topic_ids: ["t"], tags: [],
      body: "Source quote.", body_kind: "article", raw_ref: "", content_hash: "h", fetch_status: "ok",
    } satisfies ContentItem;

    await expect(analyze(topic, [content], { start: "2026-09-09", end: "2026-09-09" })).rejects.toBeInstanceOf(QuoteCoverageRejectedError);
  });

  it("一个分块全拒绝时保留同 topic 其他分块已通过覆盖门的洞察", async () => {
    vi.mocked(callStructured).mockReset();
    vi.mocked(callStructured)
      // 第一分块：可展示。
      .mockResolvedValueOnce({ data: {
        no_significant_event: false,
        insights: [{
          statement: "Supported fact.", statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
          importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1],
          confidence: null, event_id: null, is_followup: false, entities: [], tags: [],
          citations: [{ content_item_id: "ci_kept", claim: "Supported fact", quote: "Supported fact." }],
        }],
      } } as unknown as Awaited<ReturnType<typeof callStructured>>)
      .mockResolvedValueOnce({ data: { verdicts: [{
        index: 1, kind: "factual", supports: true, citation_indexes: [1],
        evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: "Supported fact.".length, evidence_excerpt: "Supported fact." }],
      }] } } as unknown as Awaited<ReturnType<typeof callStructured>>)
      // 第二分块：唯一候选应安全丢弃，不能让它抹掉上一分块。
      .mockResolvedValueOnce({ data: {
        no_significant_event: false,
        insights: [{
          statement: "Unsupported fact.", statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
          importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1],
          confidence: null, event_id: null, is_followup: false, entities: [], tags: [],
          citations: [{ content_item_id: "ci_dropped", claim: "different fact", quote: "Source quote." }],
        }],
      } } as unknown as Awaited<ReturnType<typeof callStructured>>)
      .mockResolvedValueOnce({ data: { verdicts: [{
        index: 1, kind: "factual", supports: false, citation_indexes: [], evidence_spans: [],
      }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);

    const topic: Topic = { id: "t", name: "T", keywords: [], language: "en", brief_schedule: "daily", enabled: true };
    const longTail = "x".repeat(30_000);
    const items: ContentItem[] = [
      { id: "ci_kept", source_id: "s", url: "https://example.test/kept", title: "Kept", author: null, published_at: null,
        fetched_at: "2026-09-09T00:00:00.000Z", language: "en", topic_ids: ["t"], tags: [], body: `Supported fact.${longTail}`,
        body_kind: "article", raw_ref: "", content_hash: "kept", fetch_status: "ok" },
      { id: "ci_dropped", source_id: "s", url: "https://example.test/dropped", title: "Dropped", author: null, published_at: null,
        fetched_at: "2026-09-09T00:00:00.000Z", language: "en", topic_ids: ["t"], tags: [], body: `Source quote.${longTail}`,
        body_kind: "article", raw_ref: "", content_hash: "dropped", fetch_status: "ok" },
    ];
    const decisions: Array<{ terminal_reason: string }> = [];

    const batch = await analyze(topic, items, { start: "2026-09-09", end: "2026-09-09" }, undefined, {
      onCoverageDecision: (decision) => decisions.push(decision),
    });

    expect(batch.insights.map((insight) => insight.statement)).toEqual(["Supported fact."]);
    expect(batch.no_significant_event).toBe(false);
    expect(decisions.map((decision) => decision.terminal_reason)).toEqual(["kept", "dropped_coverage"]);
  });
});

describe("canonicalizeInsightEvents", () => {
  const insight = (id: string, statement: string, event_id: string | null = null): Insight => ({
    id, topic_id: "t", type: "aggregation", event_id, statement, importance: 4, importance_basis: "x",
    citations: [{ content_item_id: id, quote: "q", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
    source_count: 1, multi_source: false, time_window: { start: "", end: "" }, confidence: null, language: "zh", is_followup: false,
  });
  it("合并同批严格相同表述，保留每条 occurrence 与 citation", () => {
    const rows = [insight("a", "OpenAI 发布了产品。", "evt_a"), insight("b", "OpenAI   发布了产品。")];
    const citations = rows.map((x) => x.citations);
    canonicalizeInsightEvents(rows, []);
    expect(rows.map((x) => x.event_id)).toEqual(["evt_a", "evt_a"]);
    expect(rows.map((x) => x.citations)).toEqual(citations);
  });
  it("唯一严格历史匹配覆盖模型 id 并标记 followup；多历史 id 冲突则 fail closed", () => {
    const matched = insight("a", "同一事件。", "wrong");
    canonicalizeInsightEvents([matched], [{ event_id: "old", statement: "同一事件。", type: "aggregation" }]);
    expect(matched).toMatchObject({ event_id: "old", is_followup: true });
    const ambiguous = [insight("b", "冲突事件。", "model-a"), insight("c", "冲突事件。", "model-b")];
    canonicalizeInsightEvents(ambiguous, [{ event_id: "old1", statement: "冲突事件。", type: "aggregation" }, { event_id: "old2", statement: "冲突事件。", type: "aggregation" }]);
    expect(ambiguous).toMatchObject([
      { event_id: "model-a", is_followup: false },
      { event_id: "model-b", is_followup: false },
    ]);
  });
  it("历史唯一匹配优先于先到的批内新 id，且 trend 不与 aggregation 互并", () => {
    const first = insight("first", "重复。", "new_event");
    const historical = insight("second", "重复。", null);
    canonicalizeInsightEvents([first, historical], [{ event_id: "old_event", statement: "重复。", type: "aggregation" }]);
    expect([first.event_id, historical.event_id]).toEqual(["old_event", "old_event"]);
    const trend = { ...insight("trend", "重复。", "trend_event"), type: "trend" as const };
    canonicalizeInsightEvents([trend], [{ event_id: "old_event", statement: "重复。", type: "aggregation" }]);
    expect(trend.event_id).toBe("trend_event");
  });
});

describe("逐子句引用审计（review queue 覆盖修复）", () => {
  it("将语义限定与数字/实体同等视为必须直接引用的事实", () => {
    expect(CITATION_CLAUSE_AUDIT).toContain("研究/来源数量、机制、比较对象、适用范围、时间、条件、因果和程度");
    expect(CITATION_CLAUSE_AUDIT).toContain("同一数字或实体就视为已覆盖");
    expect(CITATION_CLAUSE_AUDIT).toContain("两条来源写成“三项研究”");
    expect(ANALYZER_SYSTEM).toContain(CITATION_CLAUSE_AUDIT);
  });

  it("将单一最小可验证事实置于跨源综合偏好之前，不允许内部 ID 进入展示字段", () => {
    expect(CITATION_CLAUSE_AUDIT).toContain("P0 原子洞察契约");
    expect(CITATION_CLAUSE_AUDIT).toContain("一个独立、最小、可验证的事实");
    expect(CITATION_CLAUSE_AUDIT).toContain("content_item_id");
    expect(ANALYZER_SYSTEM).toContain("单源但直接、完整可引证的事实优先于不完整的“综合”");
  });
});

describe("selectForAnalyze（ADR-0007 决定② 话题制导选段）", () => {
  it("body ≤ budget：原样返回", () => {
    expect(selectForAnalyze("short text", ["k"], 100)).toBe("short text");
  });

  it("超 budget：取含关键词的段（非前缀），段间插分隔，且每段是 body 逐字切片", () => {
    const filler = "intro banter words here ".repeat(15); // 无关键词的开场
    const topical = "the codex benchmark scored high again ".repeat(4); // 含 codex
    const body = filler + topical;
    const out = selectForAnalyze(body, ["codex"], 120, 60); // 小窗口 → 多窗可选
    expect(out).toContain("codex"); // 取到了正题，而非只截前缀寒暄
    expect(out.length).toBeLessThanOrEqual(120); // 永不超 budget（含分隔符开销已精确计入）
    for (const seg of out.split(SELECT_SEPARATOR).map((s) => s.trim()).filter(Boolean)) {
      expect(body).toContain(seg); // 每段是 body 逐字切片 → 可达性成立
    }
    expect(SELECT_SEPARATOR).toContain("␟"); // 哨兵在位（防 fold 后与真实 [...] 碰撞）
  });

  it("无关键词命中：退化为前缀（与 truncate 同效）", () => {
    const body = "x".repeat(60) + " " + "y".repeat(60);
    const out = selectForAnalyze(body, ["zzz"], 50);
    expect(body.startsWith(out)).toBe(true); // 取最前的窗
  });

  it("chunkWindows：snap 到空格、不切词，每窗为原文子串", () => {
    const src = "alpha bravo charlie delta echo foxtrot";
    const ws = chunkWindows(src, 12);
    expect(ws.length).toBeGreaterThan(1);
    for (const w of ws) {
      expect(src).toContain(w);
      expect(w).not.toMatch(/^\s|\s$/); // 已 trim
    }
    expect(ws.join(" ")).toBe(src); // 无损重组（窗边界都在空格）
  });
});

function item(id: string, bodyLen: number): ContentItem {
  return {
    id, source_id: "s", url: `https://x/${id}`, title: "t", author: null, published_at: null,
    fetched_at: "2026-05-27T00:00:00Z", language: "en", topic_ids: ["t"], tags: [],
    body: "x".repeat(bodyLen), body_kind: "article", raw_ref: "", content_hash: `h_${id}`, fetch_status: "ok",
  };
}

describe("isCompleteStatement", () => {
  it("完整句（句末标点）→ true", () => {
    expect(isCompleteStatement("模型把回归率降低了 38%。")).toBe(true);
    expect(isCompleteStatement("This is a complete sentence.")).toBe(true);
    expect(isCompleteStatement("结论是否成立？")).toBe(true);
    expect(isCompleteStatement("某结论（详见原文）")).toBe(true);
  });

  it("以百分号收尾 → true（终值字符、非截断点；原白名单漏判误杀）", () => {
    expect(isCompleteStatement("当前顶级模型的全测试通过准确率为 0%")).toBe(true);
    expect(isCompleteStatement("缓存命中率达 96％")).toBe(true);
  });

  it("截断（非句末标点收尾）→ false", () => {
    // 三轮实跑里真实出现的截断尾巴
    expect(isCompleteStatement("一项针对高风险医疗问答场景的研究提出了")).toBe(false);
    expect(isCompleteStatement("…混淆样本与干净样本的嵌入最小间距仅为 1.02，存在显著的")).toBe(false);
    expect(isCompleteStatement("面向高风险医疗问答场景，研究者提出")).toBe(false);
  });

  it("忽略首尾空白", () => {
    expect(isCompleteStatement("  完整结论。  ")).toBe(true);
    expect(isCompleteStatement("半句结论 ")).toBe(false);
  });
});

describe("chunkByChars（F4 分批）", () => {
  it("小池不超预算 → 单批", () => {
    const items = [item("a", 5000), item("b", 5000)];
    const chunks = chunkByChars(items, 30_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("累计超预算 → 切多批，顺序保持", () => {
    const items = [item("a", 20_000), item("b", 20_000), item("c", 5_000)];
    const chunks = chunkByChars(items, 30_000);
    expect(chunks.map((c) => c.map((i) => i.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("单条超预算 → 独占一批（不丢）", () => {
    const items = [item("big", 50_000), item("small", 1_000)];
    const chunks = chunkByChars(items, 30_000);
    expect(chunks).toEqual([[items[0]], [items[1]]]);
  });

  it("空输入 → 空批列表", () => {
    expect(chunkByChars([], 30_000)).toEqual([]);
  });
});

describe("repairQuote（M3-6 引用对齐修复）", () => {
  it("起头逐字、后半漂移 → snap 回连续 verbatim 子串（变可达）", () => {
    const body = "Coding agents introduce tangled refactorings less frequently than human developers.";
    const quote = "Coding agents introduce tangled refactorings less often than humans"; // “often/humans”漂移
    const r = repairQuote(body, quote);
    expect(r).not.toBeNull();
    expect(body.includes(r!)).toBe(true); // F1：byte-verbatim 在 body 中（不靠 collapse 等价）
    expect(r!.length).toBeGreaterThanOrEqual(24);
    expect(r).not.toContain("often"); // 漂移部分被切掉
  });

  it("已逐字可达 → null（用原 quote）", () => {
    expect(repairQuote("The full sentence appears verbatim in the body.", "The full sentence appears verbatim")).toBeNull();
  });

  it("起头都不在正文（真改写）→ null（不造假，留给可达性闸门挡下）", () => {
    expect(repairQuote("The system records action accuracy of 0.92 on test.", "A totally unrelated claim sharing no prefix at all here.")).toBeNull();
  });

  it("太短 → null", () => {
    expect(repairQuote("some sufficiently long body text here", "short")).toBeNull();
  });

  it("短于 16 字符的共同前缀 → 不回切，避免把短语误当引用锚点", () => {
    const body = "0123456789abcdeX source-only continuation";
    const quote = "0123456789abcdeY fabricated continuation";
    expect(quote.slice(0, 15)).toBe("0123456789abcde");
    expect(repairQuote(body, quote)).toBeNull();
  });

  it("短于旧 24 字门槛的 GitHub release tag + 拼接状态 → 回切为正文中的真实 tag", () => {
    const body = "Releases rust-v0.154.0-alpha.6 0.154.0-alpha.6 Pre-release 33 commits to main.";
    const quote = "rust-v0.154.0-alpha.6 Pre-release";
    expect("rust-v0.154.0-alpha.6").toHaveLength(21);
    expect(REPAIR_QUOTE_MIN_PREFIX).toBeLessThanOrEqual(21);
    expect(repairQuote(body, quote)).toBe("rust-v0.154.0-alpha.6");
  });

  it("F1：smart-quote body + ASCII 模型 quote 后段漂移 → 返 body 原始字节切片（含 smart quote、含原始空白）", () => {
    // body 含 smart quote + 多空白；quote 模型产 ASCII 起头 + 后段漂移
    const body = "He’d  seen the “static” intro and remembered every detail of it precisely.";
    const quote = "He'd  seen the \"static\" intro and remembered every detail of HISTORY"; // 后段漂移 "of HISTORY"
    const r = repairQuote(body, quote);
    expect(r).not.toBeNull();
    // F1：返的是 body **原始字节**——含 smart quote ’ 和 “”，**不**是 ASCII 折叠形态
    expect(r).toContain("’");
    expect(r).toContain("“");
    expect(r).toContain("”");
    // F1：body **逐字**包含该切片（不需 collapse 也能命中 → 满足 byte-verbatim 承诺）
    expect(body.includes(r!)).toBe(true);
    // 后段漂移部分被切掉
    expect(r).not.toContain("HISTORY");
    expect(r!.length).toBeGreaterThanOrEqual(24);
  });

  it("F2：返切片可直接用 body.indexOf 命中（locator 不会再永远 -1）", () => {
    const body = "He’d seen the “static” intro that everyone remembers now.";
    const quote = "He'd seen the \"static\" intro that everyone REWRITE";
    const r = repairQuote(body, quote);
    expect(r).not.toBeNull();
    // F2：computeLocator 用 raw indexOf 即可命中（旧版返 nb.slice 时这里会 -1）
    expect(body.indexOf(r!)).toBeGreaterThanOrEqual(0);
  });

  it("大小写漂移 → 返回 body 中的原始连续切片", () => {
    const body = "Our results show that accuracy degrades significantly for multi-source reasoning.";
    const quote = "our results show that accuracy degrades significantly for multi-source reasoning.";
    const r = repairQuote(body, quote);
    expect(r).toBe(body);
    expect(body.includes(r!)).toBe(true);
  });

  it("起头多出限定词、但长末尾逐字相同 → 只回填 body 的字面后缀", () => {
    const body = "We present GS-QA, an extensible geospatial QA benchmark with 2,800 question-answer pairs across 28 templates on top of OpenStreetMap and Wikipedia data.";
    const quote = "a geospatial QA benchmark with 2,800 question-answer pairs across 28 templates on top of OpenStreetMap and Wikipedia data";
    const r = repairQuote(body, quote);
    expect(r).toBe("geospatial QA benchmark with 2,800 question-answer pairs across 28 templates on top of OpenStreetMap and Wikipedia data");
    expect(body.includes(r!)).toBe(true);
  });

  it("词形漂移、但长末尾逐字相同 → 只回填 body 的字面后缀", () => {
    const body = "We propose TIDE, a novel resource-efficient inference system that leverages the temporal stability of expert activations during the diffusion process.";
    const quote = "leveraging the temporal stability of expert activations during the diffusion process";
    const r = repairQuote(body, quote);
    expect(r).toBe("the temporal stability of expert activations during the diffusion process");
    expect(body.includes(r!)).toBe(true);
  });

  it("仅有共同短尾词或覆盖不足 → null，不能将无关文本伪装成引用", () => {
    const body = "This unrelated sentence ends with a familiar phrase used in every system deployment.";
    const quote = "A fabricated assertion about a completely different benchmark and its unsupported conclusion used in every system deployment";
    expect(repairQuote(body, quote)).toBeNull();
  });
});

describe("repairCitationSource（错误来源映射的保守修复）", () => {
  const mkItem = (id: string, body: string): ContentItem => ({
    id, source_id: id, url: `https://x/${id}`, title: id, author: null, published_at: null,
    fetched_at: "2026-06-01T00:00:00Z", language: "en", topic_ids: [], tags: [], body,
    body_kind: "article", raw_ref: "", content_hash: id, fetch_status: "ok",
  });

  it("quote 唯一命中另一条 body → 只重绑到该条", () => {
    const wrong = mkItem("wrong", "Unrelated source body.");
    const right = mkItem("right", "SpecBench shows a 28 percentage points gap for every tenfold increase in code size.");
    expect(repairCitationSource({ content_item_id: "wrong", quote: "28 percentage points gap for every tenfold increase" }, [wrong, right]))
      .toEqual({ content_item_id: "right", quote: "28 percentage points gap for every tenfold increase" });
  });

  it("quote 不是唯一命中 → 不猜测来源，保留原映射", () => {
    const first = mkItem("first", "Shared evidence appears in both sources.");
    const second = mkItem("second", "Shared evidence appears in both sources.");
    expect(repairCitationSource({ content_item_id: "missing", quote: "Shared evidence appears in both sources" }, [first, second]))
      .toEqual({ content_item_id: "missing", quote: "Shared evidence appears in both sources" });
  });
});

describe("truncateForAnalyze（M3-3 analyze body 上限）", () => {
  it("超上限 → 截到 ANALYZE_BODY_CHARS，且是原文前缀（保 reachability）", () => {
    const body = "x".repeat(ANALYZE_BODY_CHARS + 5000);
    const t = truncateForAnalyze(body);
    expect(t.length).toBe(ANALYZE_BODY_CHARS);
    expect(body.startsWith(t)).toBe(true); // 前缀 → quote 取自所见仍 ⊂ 全文
  });
  it("未超 → 原样", () => {
    expect(truncateForAnalyze("short body")).toBe("short body");
  });
});

describe("coverageGaps（覆盖度第三层·数字+实体引用覆盖检测）", () => {
  it("数字在引用里 → 无缺口", () => {
    expect(coverageGaps("仅 35.7% 的被拒 PR 是失误", [], ["only 35.7% of rejected PRs reflected failures"])).toEqual([]);
    expect(coverageGaps("可编译率提升至 38.33%", [], ["improves compilability from 19.34% to 38.33%"])).toEqual([]);
  });
  it("结论数字不在本条引用 → 报缺口", () => {
    expect(coverageGaps("八篇论文审计均分 0.38，经典基准 0.66", [], ["none of the eight papers disclose inference cost"]).sort()).toEqual(["0.38", "0.66"]);
  });
  it("纯整数 ≥3 位（dogfood #19/#8）报缺口；小整数/年份不报", () => {
    expect(coverageGaps("基于 900 份调查", [], ["a survey of developers"])).toEqual(["900"]); // #19
    expect(coverageGaps("Arena 得分 1507", [], ["topped the leaderboard"])).toEqual(["1507"]); // #8 四位分数 <1900 仍收
    expect(coverageGaps("2026 年发布的 8 个基准", [], ["a benchmark"])).toEqual([]); // 年份 + 个位整数都跳
    expect(coverageGaps("覆盖 1,240 万用户", [], ["reached many users"])).toEqual(["1240"]); // 去千分位后比较
    expect(coverageGaps("GS-QA 包含 2,800 个问答对", ["GS-QA"], ["GS-QA has 2,800 question-answer pairs"])).toEqual([]);
  });
  it("实体（来自 entities）未在 quote → 报缺口（dogfood #8/#10/#11）", () => {
    expect(coverageGaps("Chollet 提出新基准", ["Chollet"], ["proposed a new benchmark"])).toEqual(["Chollet"]);
    expect(coverageGaps("SpaceXAI 合作扩算力", ["SpaceXAI"], ["the partnership on compute, with SpaceXAI scaling"])).toEqual([]); // 实体在 quote 里 → 不报
    expect(coverageGaps("OpenAI 与 Anthropic 竞争", ["OpenAI", "Anthropic"], ["OpenAI announced"]).sort()).toEqual(["Anthropic"]); // 只报缺的那个
  });
  it("混合：覆盖的不报、未覆盖的报", () => {
    expect(coverageGaps("从 0.25 提升到 0.61，相对增益 99.9%", [], ["lifts score from 0.25 to 0.61 in a cycle"])).toEqual(["99.9%"]);
  });
  it("排除版本/型号标识 vX.Y（非定量声明、不报）", () => {
    expect(coverageGaps("加上 Opus 4.5 等强模型成为转折", [], ["the emergence of powerful models"])).toEqual([]);
    expect(coverageGaps("用 Gemini 2.5 与 GPT-4.1 双模型", [], ["a fast LLM in one terminal"])).toEqual([]);
    expect(coverageGaps("升级到 v5.1，再到 v5.6.2", [], ["upgraded the toolchain"])).toEqual([]);
  });
  it("版本号排除不误伤真实定量小数", () => {
    expect(coverageGaps("Opus 4.5 处理超过 3.2 千万亿 token", [], ["Opus 4.5 is powerful"])).toEqual(["3.2"]);
    expect(coverageGaps("about 0.5 ms 延迟", [], ["latency dropped"])).toEqual(["0.5"]);
  });
});

describe("specificClaims（覆盖率分母 + 边界）", () => {
  it("尾随句点剥离（Y5）：'900.' 与 quote 里 '900' 对齐、不误报", () => {
    expect(coverageGaps("共有 900.", [], ["a survey of 900 developers"])).toEqual([]); // body 写 900，statement 末尾 900. 应对齐
    expect(specificClaims("覆盖 900 项与 35.7%", [])).toEqual(["900", "35.7%"]); // 小数/整数都收
  });
  it("specificClaims 返回全部具体声明（不论是否覆盖）——供覆盖率分母", () => {
    expect(specificClaims("OpenAI 与 Chollet 在 1507 分基准", ["OpenAI", "Chollet"]).sort()).toEqual(["1507", "Chollet", "OpenAI"].sort());
  });
});

describe("carveQuote（补引候选句抽取）", () => {
  it("以 token 为锚切逐字短句、扩到句末标点、受上限约束", () => {
    const body = "Intro here. A survey of 900 developers found burnout. Next part.";
    const q = carveQuote(body, "900")!;
    expect(body.includes(q)).toBe(true); // 逐字（body 字面子串）
    expect(q.includes("900")).toBe(true);
    expect(q.length).toBeLessThanOrEqual(45);
  });
  it("token 不在 body → null", () => {
    expect(carveQuote("no number here", "900")).toBeNull();
  });
});

describe("repairCoverage（真正补引：候选 → Opus 校验 → 仅 support 才补）", () => {
  const mkItem = (id: string, body: string): ContentItem => ({
    id, source_id: "s1", url: `https://x/${id}`, title: "T", author: null, published_at: "2026-06-01",
    fetched_at: "2026-06-01T00:00:00Z", language: "en", topic_ids: ["t1"], tags: [], body, body_kind: "article",
    raw_ref: "", content_hash: `h_${id}`, fetch_status: "ok",
  });
  const mkInsight = (statement: string, cits: Citation[], entities: { name: string; type: "organization" }[] = []): Insight => ({
    id: "i1", topic_id: "t1", type: "aggregation", event_id: null, statement, headline: "", importance: 4,
    importance_basis: "x", citations: cits, source_count: 1, multi_source: false,
    time_window: { start: "", end: "" }, confidence: null, language: "zh", is_followup: false, entities, tags: [],
  });
  const verdicts = (...v: boolean[]) =>
    ({ data: { verdicts: v.map((supports, i) => ({ index: i + 1, supports })) } }) as unknown as Awaited<ReturnType<typeof callStructured>>;

  beforeEach(() => { vi.mocked(callStructured).mockReset(); delete process.env.COVERAGE_BACKFILL; });

  it("缺口候选经校验 support → 补成逐字 citation", async () => {
    const it1 = mkItem("it1", "The report covers topics. A survey of 900 developers found rising burnout. End.");
    const ins = mkInsight("基于 900 份调查显示倦怠上升", [{ content_item_id: "it1", quote: "rising burnout", locator: { paragraph_index: 0, char_start: 0, char_end: 0 } }]);
    vi.mocked(callStructured).mockResolvedValue(verdicts(true));
    await repairCoverage([ins], new Map([["it1", it1]]));
    expect(ins.citations.length).toBe(2); // 补了一条
    const added = ins.citations[1];
    expect(it1.body.includes(added.quote)).toBe(true); // 逐字可达
    expect(added.quote.includes("900")).toBe(true);
    expect(added.claim).toBe(added.quote); // 补引不再产生 claim=null 的契约破口
  });

  it("候选校验 not support（同形不同义）→ 不补、留残差", async () => {
    const it1 = mkItem("it1", "The CEO mentioned 350 parking spots. The survey covered other ground.");
    const ins = mkInsight("调查覆盖 350 家公司", [{ content_item_id: "it1", quote: "The survey covered other ground", locator: { paragraph_index: 0, char_start: 0, char_end: 0 } }]);
    vi.mocked(callStructured).mockResolvedValue(verdicts(false)); // Opus 判停车位的 350 ≠ 公司
    await repairCoverage([ins], new Map([["it1", it1]]));
    expect(ins.citations.length).toBe(1); // 没补
    expect(coverageGaps(ins.statement, [], ins.citations.map((c) => c.quote))).toEqual(["350"]); // 仍是残差
  });

  it("缺项校验结果默认 false（绝不默认补）", async () => {
    const it1 = mkItem("it1", "A survey of 900 developers. End.");
    const ins = mkInsight("基于 900 份调查", [{ content_item_id: "it1", quote: "End", locator: { paragraph_index: 0, char_start: 0, char_end: 0 } }]);
    vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    await repairCoverage([ins], new Map([["it1", it1]]));
    expect(ins.citations.length).toBe(1); // 缺判定 → 不补
  });

  it("COVERAGE_BACKFILL=0 → 完全跳过、不调 LLM", async () => {
    process.env.COVERAGE_BACKFILL = "0";
    const it1 = mkItem("it1", "A survey of 900 developers found burnout.");
    const ins = mkInsight("基于 900 份调查", [{ content_item_id: "it1", quote: "burnout", locator: { paragraph_index: 0, char_start: 0, char_end: 0 } }]);
    await repairCoverage([ins], new Map([["it1", it1]]));
    expect(ins.citations.length).toBe(1);
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("无缺口的洞察 → 不调 LLM", async () => {
    const ins = mkInsight("覆盖率 38.33%", [{ content_item_id: "it1", quote: "improves to 38.33% overall", locator: { paragraph_index: 0, char_start: 0, char_end: 0 } }]);
    await repairCoverage([ins], new Map([["it1", mkItem("it1", "improves to 38.33% overall")]]));
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("verifyCandidates 抛错 → 跳过补引、不抛出（防被 analyzeWithSplit 误判拒答拆批）", async () => {
    const it1 = mkItem("it1", "A survey of 900 developers found burnout. End.");
    const ins = mkInsight("基于 900 份调查", [{ content_item_id: "it1", quote: "End", locator: { paragraph_index: 0, char_start: 0, char_end: 0 } }]);
    vi.mocked(callStructured).mockRejectedValue(new Error("parse failed"));
    await expect(repairCoverage([ins], new Map([["it1", it1]]))).resolves.toBeUndefined(); // 不抛
    expect(ins.citations.length).toBe(1); // 没补
  });

  it("多候选按 index 对齐：只补 supports=true 的那条", async () => {
    const it1 = mkItem("it1", "A survey of 900 developers. Score reached 1507 on Arena.");
    const ins = mkInsight("基于 900 份调查，Arena 得分 1507", [{ content_item_id: "it1", quote: "developers", locator: { paragraph_index: 0, char_start: 0, char_end: 0 } }]);
    vi.mocked(callStructured).mockResolvedValue(verdicts(true, false)); // 候选1(900) support、候选2(1507) not
    await repairCoverage([ins], new Map([["it1", it1]]));
    expect(ins.citations.length).toBe(2); // 只补了 1 条
    expect(ins.citations[1].quote.includes("900")).toBe(true); // 补的是候选1（900）
    expect(coverageGaps(ins.statement, [], ins.citations.map((c) => c.quote))).toEqual(["1507"]); // 1507 仍残差
  });
});

describe("filterByQuoteCoverage（展示 quote 覆盖门）", () => {
  const insight = (statement: string, citations?: Citation[]): Insight => ({
    id: "i", topic_id: "t", type: "aggregation", event_id: null, statement, statement_citation_index: 1, headline: "", importance: 3, importance_basis: "",
    citations: citations ?? [{ content_item_id: "ci", claim: statement, quote: "展示的直接证据", locator: { paragraph_index: 0, char_start: 0, char_end: 8 } }],
    source_count: 1, multi_source: false, time_window: { start: "", end: "" }, confidence: null, language: "zh", is_followup: false,
  });

  beforeEach(() => vi.mocked(callStructured).mockReset());

  const coverageVerdicts = (...supports: boolean[]) => coverageVerdictsFor("展示的直接证据", ...supports);
  const coverageVerdictsFor = (quoteSpan: string, ...supports: boolean[]) => ({
    data: {
      verdicts: supports.map((supports, i) => ({
        index: i + 1,
        kind: "factual",
        supports,
        citation_indexes: supports ? [1] : [],
        evidence_spans: supports ? [{ citation_index: 1, quote_start: 0, quote_end: quoteSpan.length, evidence_excerpt: quoteSpan }] : [],
      })),
    },
  }) as unknown as Awaited<ReturnType<typeof callStructured>>;

  it("联合 quotes 不能完整覆盖 statement 时保守丢弃", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdicts(false));
    await expect(filterByQuoteCoverage([insight("含未引条件的结论。")])).resolves.toEqual([]);
    expect(vi.mocked(callStructured).mock.calls[0][0].system).toContain("不得假设原始全文还有其他证据");
    expect(vi.mocked(callStructured).mock.calls[0][0].system).toContain("每一个");
  });

  it("联合 quotes 直接覆盖 statement 时保留", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdicts(true));
    const row = insight("被完整覆盖的结论。");
    await expect(filterByQuoteCoverage([row])).resolves.toEqual([row]);
  });

  it("statement 仅插入一个未绑定的程度词时在调用 judge 前拒绝", async () => {
    const audits: Array<{ claims: Array<{ reason: string }> }> = [];
    const row = insight("候选由临时 worker 重放验证，并带健康检查门控的自动回滚。", [{
      content_item_id: "ci",
      claim: "候选由临时 worker 重放验证，并带健康检查门控的回滚",
      quote: "候选由临时 worker 重放验证，并带健康检查门控的回滚。",
      locator: { paragraph_index: 0, char_start: 0, char_end: 28 },
    }]);

    await expect(filterByQuoteCoverage([row], undefined, undefined, (decision) => audits.push(decision))).resolves.toEqual([]);
    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
    expect(audits[0]?.claims[0]?.reason).toBe("statement_not_bound_to_citation_claim");
  });

  it("statement 与 claim 相等仍必须经过 claim→quote 语义审计", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdicts(false));
    const audits: Array<{ claims: Array<{ reason: string }> }> = [];
    const row = insight("The exemplification technique targets black-box chatbots.", [{
      content_item_id: "ci",
      claim: "The exemplification technique targets black-box chatbots",
      quote: "We evaluate a prompt-injection technique using a bridge in external content.",
      locator: { paragraph_index: 0, char_start: 0, char_end: 73 },
    }]);

    await expect(filterByQuoteCoverage([row], undefined, undefined, (decision) => audits.push(decision))).resolves.toEqual([]);
    expect(vi.mocked(callStructured)).toHaveBeenCalledTimes(1);
    expect(audits[0]?.claims[0]?.reason).toBe("judge_not_supported");
  });

  it("把复合 statement 拆为可审计的实质 clause，跳过纯引导语", () => {
    expect(quoteCoverageClauses("该研究还发现，在被合并的 Agentic Pull Requests 中，15.4%需要审阅者通过反馈或直接提交进行明确介入；其机制在受控环境验证。"))
      .toEqual([
        "在被合并的 Agentic Pull Requests 中，15.4%需要审阅者通过反馈或直接提交进行明确介入",
        "其机制在受控环境验证",
      ]);
  });

  it("不按逗号或小数点拆开范围、条件与数值关系，防止 evidence stitching", () => {
    expect(quoteCoverageClauses("在受控环境中，15.4% 的样本通过反馈完成修复。"))
      .toEqual(["在受控环境中，15.4% 的样本通过反馈完成修复"]);
  });

  it("多个 statement 实质 clause 在调用 judge 前 fail-closed，不能以第一项 support 放行整条", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdictsFor("validity metric", true));
    const row = insight("已被引用的结果；未被引用的机制和适用范围。", [{
      content_item_id: "ci", claim: "结果", quote: "quoted result", locator: { paragraph_index: 0, char_start: 0, char_end: 13 },
    }]);

    await expect(filterByQuoteCoverage([row])).resolves.toEqual([]);
    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
  });

  it("不可定位的标题 quote 不得作为展示证据；剩余 quote 不足则丢弃", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdicts(false));
    const row = insight("SynAE 的框架同时衡量有效性、保真度和多样性。", [
      { content_item_id: "ci", claim: "框架名称", quote: "SynAE: a Framework for Measuring", locator: { paragraph_index: -1, char_start: -1, char_end: -1 } },
      { content_item_id: "ci", claim: "SynAE 的框架同时衡量有效性、保真度和多样性", quote: "validity", locator: { paragraph_index: 2, char_start: 24, char_end: 32 } },
    ]);
    row.statement_citation_index = 2;

    await expect(filterByQuoteCoverage([row])).resolves.toEqual([]);
    const user = vi.mocked(callStructured).mock.calls[0][0].user;
    expect(user).toContain("validity");
    expect(user).not.toContain("SynAE: a Framework");
    expect(row.citations.map((citation) => citation.quote)).toEqual(["validity"]);
  });

  it("其余 quote 覆盖时仍剔除不可定位 citation，避免后续 reachability 阻断", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdictsFor("validity metric", true));
    const row = insight("有效性指标。", [
      { content_item_id: "ci", claim: "无效标题", quote: "Only a title", locator: { paragraph_index: -1, char_start: -1, char_end: -1 } },
      { content_item_id: "ci", claim: "有效性指标", quote: "validity metric", locator: { paragraph_index: 2, char_start: 24, char_end: 39 } },
    ]);
    row.statement_citation_index = 2;

    await expect(filterByQuoteCoverage([row])).resolves.toEqual([row]);
    expect(row.citations.map((citation) => citation.quote)).toEqual(["validity metric"]);
    expect(row.statement_citation_index).toBe(1);
  });

  it("缺原子 claim 的 citation 不能作为展示证据或虚高多源标签", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdictsFor("validity metric", true));
    const row = insight("有效性指标。", [
      { content_item_id: "ci_no_claim", quote: "validity metric", locator: { paragraph_index: 0, char_start: 0, char_end: 15 } },
      { content_item_id: "ci_good", claim: "有效性指标", quote: "validity metric", locator: { paragraph_index: 1, char_start: 0, char_end: 15 } },
    ]);
    row.statement_citation_index = 2;
    row.source_count = 2;
    row.multi_source = true;
    const itemsById = new Map<string, ContentItem>([
      ["ci_no_claim", { id: "ci_no_claim", source_id: "source_no_claim" } as ContentItem],
      ["ci_good", { id: "ci_good", source_id: "source_good" } as ContentItem],
    ]);

    await expect(filterByQuoteCoverage([row], undefined, itemsById)).resolves.toEqual([row]);
    expect(row.citations.map((citation) => citation.content_item_id)).toEqual(["ci_good"]);
    expect(row).toMatchObject({ source_count: 1, multi_source: false });
  });

  it("剔除第二个来源的无效 citation 后重算 source_count 与 multi_source", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdictsFor("validity metric", true));
    const row = insight("有效性指标。", [
      { content_item_id: "ci_bad", claim: "无效标题", quote: "Only a title", locator: { paragraph_index: -1, char_start: -1, char_end: -1 } },
      { content_item_id: "ci_good", claim: "有效性指标", quote: "validity metric", locator: { paragraph_index: 2, char_start: 24, char_end: 39 } },
    ]);
    row.statement_citation_index = 2;
    row.source_count = 2;
    row.multi_source = true;
    const itemsById = new Map<string, ContentItem>([
      ["ci_bad", { id: "ci_bad", source_id: "source_bad" } as ContentItem],
      ["ci_good", { id: "ci_good", source_id: "source_good" } as ContentItem],
    ]);

    await expect(filterByQuoteCoverage([row], undefined, itemsById)).resolves.toEqual([row]);
    expect(row).toMatchObject({ source_count: 1, multi_source: false });
  });

  it("headline 及 importance_basis 中新增的事实也必须逐项有 citation claim/quote 覆盖", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdicts(true, false, true));
    const row = {
      ...insight("Mem-pi 论文提出了一种记忆方法。", [{
        content_item_id: "ci", claim: "Mem-pi 论文提出了一种记忆方法", quote: "We present Mem-pi", locator: { paragraph_index: 0, char_start: 0, char_end: 17 },
      }]),
      headline: "Mem-pi 已上线",
      importance_basis: "该论文提出了 Mem-pi",
    };

    await expect(filterByQuoteCoverage([row])).resolves.toEqual([]);
    const user = vi.mocked(callStructured).mock.calls[0][0].user;
    expect(user).toContain("[statement] Mem-pi 论文提出了一种记忆方法");
    expect(user).toContain("[headline] Mem-pi 已上线");
    expect(user).toContain("[importance_basis] 该论文提出了 Mem-pi");
    expect(user).toContain("<citation_evidence>");
    expect(user).toContain("citation_claim：Mem-pi 论文提出了一种记忆方法");
  });

  it("缺少能指向 citation claim/quote 的证据索引时 fail-closed", async () => {
    vi.mocked(callStructured).mockResolvedValue({
      data: { verdicts: [{ index: 1, kind: "factual", supports: true, citation_indexes: [] }] },
    } as unknown as Awaited<ReturnType<typeof callStructured>>);

    await expect(filterByQuoteCoverage([insight("有展示证据的结论。")])).resolves.toEqual([]);
  });

  it("不得用两个局部 quote 拼接同一个事实 claim", async () => {
    const first = "The system improves throughput.";
    const second = "The approach does not require retraining.";
    vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [{
      index: 1, kind: "factual", supports: true, citation_indexes: [1, 2], evidence_spans: [
        { citation_index: 1, quote_start: 0, quote_end: first.length, evidence_excerpt: first },
        { citation_index: 2, quote_start: 0, quote_end: second.length, evidence_excerpt: second },
      ],
    }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    const audits: Array<{ claims: Array<{ reason: string }> }> = [];
    const row = insight("The system improves throughput without retraining for mixture-of-experts models.", [
      { content_item_id: "ci1", claim: "The system improves throughput without retraining for mixture-of-experts models", quote: first, locator: { paragraph_index: 0, char_start: 0, char_end: first.length } },
      { content_item_id: "ci2", claim: "no retraining", quote: second, locator: { paragraph_index: 0, char_start: 0, char_end: second.length } },
    ]);

    await expect(filterByQuoteCoverage([row], undefined, undefined, (decision) => audits.push(decision))).resolves.toEqual([]);
    expect(audits[0]?.claims[0]?.reason).toBe("invalid_citation_indexes");
  });

  it("缺少可定位 evidence span 时 fail-closed，不能以相关 quote 放行范围扩大", async () => {
    vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [{
      index: 1, kind: "factual", supports: true, citation_indexes: [1], evidence_spans: [],
    }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    await expect(filterByQuoteCoverage([insight("黑盒聊天机器人中的注入。", [{
      content_item_id: "ci", claim: "外部内容中的桥接", quote: "a bridge in the external content", locator: { paragraph_index: 0, char_start: 0, char_end: 32 },
    }])])).resolves.toEqual([]);
  });

  it("evidence span 的偏移和摘录不一致时 fail-closed，不能只凭 quote 包含任意片段", async () => {
    vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [{
      index: 1, kind: "factual", supports: true, citation_indexes: [1],
      evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: 2, evidence_excerpt: "不存在" }],
    }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    await expect(filterByQuoteCoverage([insight("完整关系声明。")])).resolves.toEqual([]);
  });

  it("唯一逐字 evidence excerpt 的错误坐标会规范化为 quote 的 UTF-16 偏移", async () => {
    const quote = "前缀：完整关系声明。后缀";
    const excerpt = "完整关系声明";
    vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [{
      index: 1, kind: "factual", supports: true, citation_indexes: [1],
      // Deliberately wrong: the excerpt starts after the UTF-16 code units in "前缀：".
      evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: excerpt.length, evidence_excerpt: excerpt }],
    }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    const row = insight("完整关系声明。", [{
      content_item_id: "ci", claim: "完整关系声明", quote,
      locator: { paragraph_index: 0, char_start: 0, char_end: quote.length },
    }]);
    const audits: Array<{ claims: Array<{ evidence_spans: Array<{ quote_start: number; quote_end: number }> }> }> = [];

    await expect(filterByQuoteCoverage([row], undefined, undefined, (decision) => audits.push(decision))).resolves.toEqual([row]);
    expect(audits[0]?.claims[0]?.evidence_spans).toMatchObject([{
      quote_start: quote.indexOf(excerpt),
      quote_end: quote.indexOf(excerpt) + excerpt.length,
    }]);
  });

  it("重复的 evidence excerpt 没有唯一定位，仍然 fail-closed", async () => {
    const quote = "重复证据；重复证据";
    vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [{
      index: 1, kind: "factual", supports: true, citation_indexes: [1],
      evidence_spans: [{ citation_index: 1, quote_start: 1, quote_end: 5, evidence_excerpt: "重复证据" }],
    }] } } as unknown as Awaited<ReturnType<typeof callStructured>>);
    await expect(filterByQuoteCoverage([insight("重复证据。", [{
      content_item_id: "ci", claim: "重复证据", quote,
      locator: { paragraph_index: 0, char_start: 0, char_end: quote.length },
    }])])).resolves.toEqual([]);
  });

  it("importance_basis 只作已覆盖事实的评价、没有新增可核验事实时可以保留", async () => {
    vi.mocked(callStructured).mockResolvedValue({
      data: { verdicts: [
        { index: 1, kind: "factual", supports: true, citation_indexes: [1], evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: "Recursive chunking performs best".length, evidence_excerpt: "Recursive chunking performs best" }] },
      ] },
    } as unknown as Awaited<ReturnType<typeof callStructured>>);
    const row = {
      ...insight("Recursive 分块在 Khmer RAG 评测中表现最佳。", [{
        content_item_id: "ci", claim: "Recursive 分块在 Khmer RAG 评测中表现最佳", quote: "Recursive chunking performs best", locator: { paragraph_index: 0, char_start: 0, char_end: 32 },
      }]),
      importance_facts: [],
      importance_reason: "engineering_decision" as const,
      importance_reason_claim_indexes: [1],
      importance_basis: renderImportanceBasis([], "engineering_decision"),
    };

    await expect(filterByQuoteCoverage([row])).resolves.toEqual([row]);
  });

  it("受控系统重要性判断不依赖关键词正则；只接受已通过 statement/headline 锚点", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdictsFor("展示的直接证据", true));
    const row = {
      ...insight("评测结果显示该方案优于基线。"),
      importance_facts: [],
      importance_reason: "evaluation_interpretation" as const,
      importance_reason_claim_indexes: [1],
      importance_basis: renderImportanceBasis([], "evaluation_interpretation"),
    };
    await expect(filterByQuoteCoverage([row])).resolves.toEqual([row]);
  });

  it("受控系统重要性判断不能锚定不存在或未通过的 statement/headline claim", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdictsFor("展示的直接证据", true));
    const row = {
      ...insight("已被展示证据覆盖的结论。"),
      importance_facts: [],
      importance_reason: "research_tracking" as const,
      importance_reason_claim_indexes: [2],
      importance_basis: renderImportanceBasis([], "research_tracking"),
    };
    await expect(filterByQuoteCoverage([row])).resolves.toEqual([]);
  });

  it("受控重要性仅保留模型声明且已通过的锚点，不自行挑选新 claim", async () => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdictsFor("展示的直接证据", true));
    const row = {
      ...insight("已被展示证据覆盖的结论。"),
      importance_facts: [],
      importance_reason: "research_tracking" as const,
      // 1 is the model-declared statement anchor; 2 is out of range and may be discarded.
      importance_reason_claim_indexes: [1, 2],
      importance_basis: renderImportanceBasis([], "research_tracking"),
    };
    const audits: Array<{ claims: Array<{ kind: string; reason: string; based_on_display_claim_ids?: string[] }> }> = [];

    await expect(filterByQuoteCoverage([row], undefined, undefined, (decision) => audits.push(decision))).resolves.toEqual([row]);
    expect(row.importance_reason_claim_indexes).toEqual([1]);
    expect(audits[0]?.claims.find((claim) => claim.kind === "evaluation")).toMatchObject({
      reason: "controlled_reason_pruned_anchor",
      based_on_display_claim_ids: ["statement:1"],
    });
  });

  it.each([
    ["代码 agent：closed PR 不能推出 rejected 结果显著夸大错误", "真实 11,048 个 closed PR 显示被拒结果显著夸大 agent 错误", "11,048 closed PR", "拒绝 PR 的三种归因比例"],
    ["SynAE：不能由质量指标推出工具调用 agent 评测框架", "SynAE 框架面向工具调用 agent 评测中的合成数据质量", "validity fidelity and diversity", "检测有效性、保真度和多样性"],
    ["PALS/TIDE：不能补入 KV cache、模型范围和专家卸载", "PALS 与 TIDE 将 KV 缓存、稠密与混合专家模型的资源控制转为专家卸载变量", "improves throughput without retraining", "利用专家激活的时间稳定性"],
    ["DASH：不能补入混合注意力适用范围或搜索成本结论", "DASH 在混合注意力架构中将搜索成本大幅压缩", "0.006%", "RULER 评测优于基线"],
    ["exemplification：受控 PoC 不能扩大为黑盒聊天机器人", "受控环境 PoC 证明黑盒聊天机器人隐私泄露", "in a controlled setting", "受控环境 PoC"],
    ["SpecBench：系统级任务不能扩大为长时程编码智能体普遍问题", "长时程编码智能体普遍奖励黑客", "30 systems-level programming tasks", "30 个系统级任务"],
    ["KV：认证机制不能写成非仅经验验证", "该机制而非仅经验验证", "local certification", "局部认证"],
    ["LlamaWeb：跨设备指标不能推导端侧性能可移植", "端侧浏览器推理的性能可移植后端", "across several combinations of device, browser, and operating system", "多设备浏览器组合"],
  ])("反例：%s 在调用语义 judge 前必须拒绝 statement 对 citation claim 的范围扩大", async (_name, statement, quote, claim) => {
    vi.mocked(callStructured).mockResolvedValue(coverageVerdicts(false));
    const audits: Array<{ claims: Array<{ reason: string }> }> = [];
    const row = insight(statement, [{
      content_item_id: "ci", claim, quote, locator: { paragraph_index: 0, char_start: 0, char_end: quote.length },
    }]);

    await expect(filterByQuoteCoverage([row], undefined, undefined, (decision) => audits.push(decision))).resolves.toEqual([]);
    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
    expect(audits[0]?.claims[0]?.reason).toBe("statement_not_bound_to_citation_claim");
  });
});
