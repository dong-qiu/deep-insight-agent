/**
 * analyzer 产出守卫的纯函数单测 —— 无需 API key，CI 可跑（npm test）。
 * 覆盖截断检测（结构化输出偶发把长 statement 提前收尾）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Citation, ContentItem, Insight } from "../types.js";
// callStructured mock 掉——repairCoverage 经 verifyCandidates 调它；无 API key、CI 可跑纯函数。
vi.mock("../runtime/llm.js", () => ({ callStructured: vi.fn() }));
import { callStructured } from "../runtime/llm.js";
import { ANALYZE_BODY_CHARS, carveQuote, chunkByChars, coverageGaps, isCompleteStatement, repairCoverage, repairQuote, specificClaims, truncateForAnalyze } from "./analyzer.js";

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
