import { beforeEach, describe, expect, it } from "vitest";
import type { AnalysisBatch, Entity, Insight, Topic, ValidationResult } from "../types.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { buildTopicGraph, groupDrillInsights, insightsCooccurring, insightsMentioningEntity, loadTopicInsights, reportLinkMap, reportLinksByInsight } from "./graph.js";
import { type DB, openDb } from "./index.js";
import { insertTopic } from "./repos.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../utils/source-quote-projection.js";

let db: DB;
const topic: Topic = {
  id: "t1", name: "T", keywords: ["k"], language: "zh", brief_schedule: "daily", enabled: true,
};
const org = (name: string): Entity => ({ name, type: "organization" });

function mkInsight(id: string, entities: Entity[]): Insight {
  const statement = `S-${id} ${entities.map((entity) => entity.name).join(" ")}`.trim();
  return {
    id, topic_id: "t1", type: "aggregation", event_id: null, statement, headline: "",
    statement_citation_index: 1,
    importance: 3, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
    citations: [{ content_item_id: `ci-${id}`, citation_ref: `cite-${id}-1`, quote: statement, locator: { paragraph_index: 0, char_start: 0, char_end: statement.length } }],
    source_count: 1, multi_source: false, time_window: { start: "2026-05-01", end: "2026-05-07" },
    confidence: "high", language: "zh", is_followup: false, entities, tags: [],
  };
}
type ReaderVisibility = "visible" | "legacy" | "audit_rejected" | "bound_blocked";

function validAuditDecision(insight: Insight) {
  const index = insight.statement_citation_index!;
  return {
    statement_citation_index: index,
    statement_citation_ref: insight.citations[index - 1]?.citation_ref,
    display_projection_version: DISPLAY_PROJECTION_VERSION,
    statement_sha256: sourceQuoteHash(insight.statement),
    quote_sha256: sourceQuoteHash(insight.citations[index - 1]!.quote),
    claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [index], countercheck: { supports: true } }],
  };
}

function saveBatch(id: string, insights: Insight[], visibility: ReaderVisibility = "visible") {
  const batch: AnalysisBatch = {
    id, topic_id: "t1", time_window: { start: "2026-05-01", end: "2026-05-07" },
    status: "done", no_significant_event: false, insights,
  };
  if (visibility !== "legacy") {
    batch.display_coverage_state = "audited";
    batch.display_projection_version = DISPLAY_PROJECTION_VERSION;
    batch.display_coverage_audits = insights.map((insight) => ({
      insight_id: insight.id, candidate_id: `candidate_${insight.id}`, gate_version: "display-coverage-v6",
      terminal_reason: visibility === "audit_rejected" ? "dropped_coverage" : "kept",
      prompt_version: "display-coverage-v6", input_hash: `hash_${insight.id}`, validator_model: "validator",
      decision: validAuditDecision(insight), created_at: "2026-09-09T00:00:00.000Z",
    }));
  }
  saveAnalysisBatch(db, batch);
  if (visibility === "legacy" || visibility === "audit_rejected") return;
  const checks = insights.map((insight) => ({
    insight_id: insight.id, citation_index: insight.statement_citation_index! - 1,
    reachability: "pass" as const, reachability_reason: "ok" as const,
    consistency: visibility === "bound_blocked" ? "not_support" as const : "support" as const,
    consistency_reason: visibility === "bound_blocked" ? "exaggeration" as const : "ok" as const,
    verdict: visibility === "bound_blocked" ? "blocked" as const : "pass" as const,
  }));
  const validation: ValidationResult = {
    checks,
    report: {
      total: checks.length, pass: checks.filter((check) => check.verdict === "pass").length,
      blocked: checks.filter((check) => check.verdict === "blocked").length, flagged: 0, errored: 0,
      consistency_failure_rate: visibility === "bound_blocked" ? 1 : 0, flagged_rate: 0,
      insights_total: insights.length, insights_includable: visibility === "bound_blocked" ? 0 : insights.length,
      releasable: visibility !== "bound_blocked",
    },
  };
  saveValidationResult(db, id, validation);
}

beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
});

describe("buildTopicGraph", () => {
  it("共现 2 条 → 边 + 计数（自适应阈值=2）", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    saveBatch("b2", [mkInsight("i2", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1");
    expect(r.insightCount).toBe(2);
    expect(r.withEntities).toBe(2);
    expect(r.minEdgeWeight).toBe(2);
    expect(r.graph.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 2, strength: 1 }]);
  });

  it("withEntities 排除无实体洞察", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")]), mkInsight("i2", [])]);
    saveBatch("b2", [mkInsight("i3", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1");
    expect(r.insightCount).toBe(3);
    expect(r.withEntities).toBe(2);
  });

  it("显式 minEdgeWeight 覆盖自适应", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1", { minEdgeWeight: 1 });
    expect(r.minEdgeWeight).toBe(1);
    expect(r.graph.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 1, strength: 1 }]);
  });

  it("metric=association：返回 metric、支持度下限固定 2、边带 strength", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    saveBatch("b2", [mkInsight("i2", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1", { metric: "association" });
    expect(r.metric).toBe("association");
    expect(r.minEdgeWeight).toBe(2);
    expect(r.graph.edges[0].strength).toBe(1);
  });

  it("since 限定时间窗：旧 batch 的洞察被排除", () => {
    saveBatch("bold", [mkInsight("iold", [org("OpenAI"), org("Cursor")])]);
    saveBatch("bnew", [mkInsight("inew", [org("OpenAI"), org("Cursor")])]);
    db.prepare("UPDATE analysis_batch SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:00", "bold");
    const r = buildTopicGraph(db, "t1", { since: "2026-05-01" });
    expect(r.insightCount).toBe(1); // 只剩 bnew
  });

  it("图节点、边和 drill 只使用 audited-kept 且绑定引用通过 validator 的洞察", () => {
    saveBatch("legacy", [mkInsight("legacy", [org("Legacy"), org("Unsafe")])], "legacy");
    saveBatch("rejected", [mkInsight("rejected", [org("Rejected"), org("Unsafe")])], "audit_rejected");
    saveBatch("blocked", [mkInsight("blocked", [org("Blocked"), org("Unsafe")])], "bound_blocked");
    saveBatch("visible", [mkInsight("visible", [org("OpenAI"), org("Cursor")])]);
    const entityDetached = mkInsight("entity-detached", [org("OpenAI"), org("Cursor")]);
    entityDetached.statement = "S-entity-detached MOSS";
    entityDetached.citations[0]!.quote = entityDetached.statement;
    entityDetached.citations[0]!.locator.char_end = entityDetached.statement.length;
    saveBatch("entity-detached", [entityDetached]);

    const graph = buildTopicGraph(db, "t1", { minEdgeWeight: 1 });
    expect(graph.insightCount).toBe(2); // the safe MOSS statement is still a reader-visible insight, just not a graph relation
    expect(graph.withEntities).toBe(1);
    expect(graph.graph.nodes.map((node) => node.name).sort()).toEqual(["Cursor", "OpenAI"]);
    expect(loadTopicInsights(db, "t1").map((insight) => insight.id)).toEqual(["visible", "entity-detached"]);
    expect(loadTopicInsights(db, "t1").find((insight) => insight.id === "entity-detached")?.entities).toEqual([]);
    expect(insightsMentioningEntity(db, "t1", "Unsafe")).toEqual([]);
    expect(insightsMentioningEntity(db, "t1", "OpenAI").map((insight) => insight.id)).toEqual(["visible"]);
    expect(insightsCooccurring(db, "t1", "OpenAI", "Cursor").map((insight) => insight.id)).toEqual(["visible"]);
  });

  it("绑定审计仍有效时，历史 headline 或自由重要性元数据也会让图与 drill fail-closed", () => {
    saveBatch("unsafe-meta", [mkInsight("unsafe-meta", [org("OpenAI"), org("Cursor")])]);
    db.prepare("UPDATE insight SET headline='未审计标题' WHERE id='unsafe-meta'").run();
    expect(loadTopicInsights(db, "t1")).toEqual([]);
    expect(buildTopicGraph(db, "t1", { minEdgeWeight: 1 }).insightCount).toBe(0);
  });
});

describe("溯源查询", () => {
  beforeEach(() => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    saveBatch("b2", [mkInsight("i2", [org("OpenAI"), org("Anthropic")])]);
  });

  it("loadTopicInsights 带 citations 锚回原文", () => {
    const ins = loadTopicInsights(db, "t1");
    expect(ins.length).toBe(2);
    expect(ins[0].citations[0].content_item_id).toBe("ci-i1");
  });

  it("insightsMentioningEntity：提及该实体的全部洞察", () => {
    expect(insightsMentioningEntity(db, "t1", "OpenAI").map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    expect(insightsMentioningEntity(db, "t1", "Cursor").map((i) => i.id)).toEqual(["i1"]);
  });

  it("insightsCooccurring：只返两实体同条共现的洞察", () => {
    expect(insightsCooccurring(db, "t1", "OpenAI", "Cursor").map((i) => i.id)).toEqual(["i1"]);
    expect(insightsCooccurring(db, "t1", "Cursor", "Anthropic")).toEqual([]); // 从未同条
  });
});

describe("reportLinkMap", () => {
  /** 直插一份已发布报告（report + report_index）含给定 insight_ids */
  function saveReport(rid: string, date: string, insightIds: string[]) {
    db.prepare(
      `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(rid, "brief", "t1", "done", date, `R-${rid}`, `/p/${rid}`, JSON.stringify(insightIds), "[]", 0, "{}");
    db.prepare(
      `INSERT INTO report_index (report_id,type,topic_id,date,title,summary,importance) VALUES (?,?,?,?,?,?,?)`,
    ).run(rid, "brief", "t1", date, `R-${rid}`, "", 3);
  }

  it("反查 insight_id → 报告；未入报告的洞察无链接", () => {
    saveReport("r1", "2026-06-01", ["i1", "i2"]);
    const m = reportLinkMap(db, "t1");
    expect(m.get("i1")).toEqual({ report_id: "r1", date: "2026-06-01" });
    expect(m.get("i2")?.report_id).toBe("r1");
    expect(m.get("i_blocked")).toBeUndefined(); // 未入任何报告 → 无链接
  });

  it("洞察在多份报告时取最新（date 升序覆盖取最新）", () => {
    saveReport("rOld", "2026-06-01", ["i1"]);
    saveReport("rNew", "2026-06-05", ["i1"]); // 续报再次包含 i1
    expect(reportLinkMap(db, "t1").get("i1")).toEqual({ report_id: "rNew", date: "2026-06-05" });
  });

  it("drill 同表述只折叠展示，展开保留每条原始 occurrence 与全部报告链接", () => {
    saveBatch("b_group", [mkInsight("i1", [org("OpenAI")])]);
    saveReport("rOld", "2026-06-01", ["i1"]);
    saveReport("rNew", "2026-06-05", ["i1"]);
    const first = loadTopicInsights(db, "t1")[0];
    const duplicate = { ...first, id: "i_dup", statement: first.statement, headline: first.headline, type: first.type };
    const grouped = groupDrillInsights([first, duplicate], reportLinksByInsight(db, "t1"));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].occurrence_count).toBe(2);
    expect(grouped[0].occurrences.map((x) => x.id).sort()).toEqual(["i1", "i_dup"]);
    expect(grouped[0].occurrences.find((x) => x.id === "i1")?.report_links).toEqual([
      { report_id: "rOld", date: "2026-06-01" }, { report_id: "rNew", date: "2026-06-05" },
    ]);
  });

  it("drill 只展示持久化的 statement 绑定 quote，并让卡片与默认 occurrence 对齐", () => {
    const bound = mkInsight("i_bound", [org("OpenAI")]);
    bound.statement_citation_index = 2;
    bound.citations = [
      { content_item_id: "ci-unrelated", citation_ref: "cite-bound-1", quote: "第一条无关引文", locator: { paragraph_index: 0, char_start: 0, char_end: 7 } },
      { content_item_id: "ci-bound", citation_ref: "cite-bound-2", quote: "第二条绑定引文", locator: { paragraph_index: 0, char_start: 0, char_end: 7 } },
    ];
    bound.statement = "第二条绑定引文";
    saveBatch("b_bound", [bound]);

    const roundTripped = loadTopicInsights(db, "t1").find((insight) => insight.id === "i_bound")!;
    const grouped = groupDrillInsights([roundTripped], new Map());
    expect(roundTripped.statement_citation_index).toBe(2);
    expect(grouped[0]?.occurrences[0]?.quotes).toEqual(["第二条绑定引文"]);
    expect(grouped[0]).toMatchObject({ headline: "第二条绑定引文", statement: "第二条绑定引文" });
  });

  it("空 audit 或与持久化 binding 错位时，图和 drill 均 fail-closed", () => {
    const empty = mkInsight("empty-audit", [org("Empty"), org("Unsafe")]);
    saveBatch("empty-audit", [empty]);
    db.prepare("UPDATE display_coverage_audit SET decision = '{}' WHERE batch_id = ?").run("empty-audit");

    const mismatched = mkInsight("mismatched-audit", [org("Mismatch"), org("Unsafe")]);
    mismatched.statement_citation_index = 2;
    mismatched.citations = [
      { content_item_id: "ci-mismatch-1", citation_ref: "cite-mismatch-1", quote: "无关", locator: { paragraph_index: 0, char_start: 0, char_end: 2 } },
      { content_item_id: "ci-mismatch-2", citation_ref: "cite-mismatch-2", quote: "绑定", locator: { paragraph_index: 0, char_start: 0, char_end: 2 } },
    ];
    saveBatch("mismatched-audit", [mismatched]);
    db.prepare("UPDATE display_coverage_audit SET decision = ? WHERE batch_id = ?")
      .run(JSON.stringify({ ...validAuditDecision(mismatched), statement_citation_index: 1, statement_citation_ref: "cite-mismatch-1", claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1] }] }), "mismatched-audit");

    const wrongRef = mkInsight("wrong-ref", [org("WrongRef"), org("Unsafe")]);
    saveBatch("wrong-ref", [wrongRef]);
    db.prepare("UPDATE display_coverage_audit SET decision = ? WHERE batch_id = ?")
      .run(JSON.stringify({ ...validAuditDecision(wrongRef), statement_citation_ref: "cite-not-the-bound-citation" }), "wrong-ref");

    expect(loadTopicInsights(db, "t1").map((insight) => insight.id)).toEqual([]);
    expect(buildTopicGraph(db, "t1", { minEdgeWeight: 1 }).insightCount).toBe(0);
    expect(insightsMentioningEntity(db, "t1", "Unsafe")).toEqual([]);
  });

  it("v6 读路径拒绝旧投影、statement/quote 不等或 audit hash 被篡改的记录", () => {
    const legacyProjection = mkInsight("legacy-projection", [org("LegacyV6")]);
    saveBatch("legacy-projection", [legacyProjection]);
    db.prepare("UPDATE analysis_batch SET display_projection_version = 'legacy' WHERE id = ?").run("legacy-projection");

    const mutatedText = mkInsight("mutated-text", [org("Mutated")]);
    saveBatch("mutated-text", [mutatedText]);
    db.prepare("UPDATE insight SET statement = ? WHERE id = ?").run("a rewritten reader statement", "mutated-text");

    const mutatedHash = mkInsight("mutated-hash", [org("Hash")]);
    saveBatch("mutated-hash", [mutatedHash]);
    db.prepare("UPDATE display_coverage_audit SET decision = json_set(decision, '$.quote_sha256', 'wrong') WHERE batch_id = ?").run("mutated-hash");

    expect(loadTopicInsights(db, "t1")).toEqual([]);
    expect(buildTopicGraph(db, "t1", { minEdgeWeight: 1 }).insightCount).toBe(0);
  });

  it("只算 status='done' 的报告", () => {
    db.prepare(
      `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
       VALUES ('rDraft','brief','t1','generating','2026-06-02','D','/p',?,'[]',0,'{}')`,
    ).run(JSON.stringify(["i9"]));
    db.prepare(
      `INSERT INTO report_index (report_id,type,topic_id,date,title,summary,importance) VALUES ('rDraft','brief','t1','2026-06-02','D','',3)`,
    ).run();
    expect(reportLinkMap(db, "t1").get("i9")).toBeUndefined(); // 非 done 不计
  });
});
