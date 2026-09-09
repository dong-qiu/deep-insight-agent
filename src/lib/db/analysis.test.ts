import { beforeEach, expect, it } from "vitest";
import type { AnalysisBatch, Topic, ValidationResult } from "../types.js";
import { getAnalysisBatch, getValidationResult, saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { type DB, openDb } from "./index.js";
import { insertTopic } from "./repos.js";

let db: DB;
const topic: Topic = {
  id: "t1", name: "T", keywords: ["k"], language: "zh",
  brief_schedule: "daily", enabled: true,
};
beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
});

const batch: AnalysisBatch = {
  id: "b1", topic_id: "t1", time_window: { start: "2026-05-01", end: "2026-05-07" },
  status: "done", no_significant_event: false,
  insights: [
    {
      id: "i1", topic_id: "t1", type: "aggregation", event_id: null, statement: "S1", headline: "H1",
      statement_citation_index: 1,
      importance: 4, importance_basis: "basis",
      citations: [{ content_item_id: "ci1", quote: "q1", locator: { paragraph_index: 0, char_start: 0, char_end: 2 } }],
      source_count: 1, multi_source: false, time_window: { start: "2026-05-01", end: "2026-05-07" },
      confidence: null, language: "zh", is_followup: false,
      entities: [{ name: "OpenAI", type: "organization" }, { name: "Codex", type: "product" }],
      tags: ["code-agent", "benchmark"],
    },
    {
      id: "i2", topic_id: "t1", type: "trend", event_id: "evt_x", statement: "S2", headline: "H2",
      statement_citation_index: 2,
      importance: 5, importance_basis: "b2",
      citations: [
        { content_item_id: "ci1", quote: "q2a", locator: { paragraph_index: 0, char_start: 3, char_end: 5 } },
        { content_item_id: "ci2", quote: "q2b", locator: { paragraph_index: 1, char_start: 0, char_end: 4 } },
      ],
      source_count: 2, multi_source: true, time_window: { start: "2026-05-01", end: "2026-05-07" },
      confidence: "high", language: "zh", is_followup: true, entities: [], tags: [],
    },
  ],
};

it("AnalysisBatch 往返（含 insights + citations）", () => {
  saveAnalysisBatch(db, batch);
  expect(getAnalysisBatch(db, "b1")).toEqual({ ...batch, display_coverage_state: "legacy", display_projection_version: "legacy" });
  expect(db.prepare("SELECT statement_citation_index FROM insight WHERE id = 'i2'").get()).toEqual({ statement_citation_index: 2 });
});

it("同一事务持久化 citation_ref/claim 与展示覆盖审计，读回不把旧行伪装成已审计", () => {
  const audited = structuredClone(batch);
  audited.insights[0].citations[0] = {
    ...audited.insights[0].citations[0], citation_ref: "cite_abc", claim: "S1 的原子事实",
  };
  audited.display_coverage_audits = [{
    insight_id: "i1", candidate_id: "i1", gate_version: "display-coverage-v2", terminal_reason: "kept",
    prompt_version: "display-coverage-v2", input_hash: "input-sha", validator_model: "validator-test",
    decision: { claims: [{ claim_id: "statement:1", supports: true, evidence_spans: [{ quote_start: 0, quote_end: 2, evidence_excerpt: "q1" }] }] },
    created_at: "2026-09-09T00:00:00.000Z",
  }];
  audited.display_coverage_state = "audited";
  audited.display_projection_version = "legacy";
  audited.display_coverage_candidate_audits = [
    {
      candidate_id: "i1", insight_id: "i1", gate_version: "display-coverage-v2", terminal_reason: "kept",
      prompt_version: "display-coverage-v2", input_hash: "input-sha", validator_model: "validator-test",
      decision: { claims: [{ claim_id: "statement:1", kind: "factual", supports: true, citation_indexes: [1] }] },
      created_at: "2026-09-09T00:00:00.000Z",
    },
    {
      candidate_id: "rejected_before_persistence", gate_version: "display-coverage-v2", terminal_reason: "dropped_no_displayable_citation",
      prompt_version: "display-coverage-v2", input_hash: "input-rejected", validator_model: "validator-test",
      decision: { claims: [{ claim_id: "statement:1", kind: "factual", supports: false, citation_indexes: [] }] },
      created_at: "2026-09-09T00:00:00.000Z",
    },
  ];
  saveAnalysisBatch(db, audited);

  expect(getAnalysisBatch(db, "b1")).toEqual(audited);
  expect(db.prepare("SELECT citation_ref, claim FROM citation WHERE insight_id = 'i1'").get()).toEqual({ citation_ref: "cite_abc", claim: "S1 的原子事实" });
});

it("已审计但无保留洞察的缓存读回仍是 audited，不能退化为 legacy", () => {
  const emptyAudited: AnalysisBatch = {
    ...structuredClone(batch), id: "b-empty", insights: [], display_coverage_state: "audited",
    display_projection_version: "legacy",
    display_coverage_audits: [],
    display_coverage_candidate_audits: [{
      candidate_id: "candidate_rejected", gate_version: "display-coverage-v2", terminal_reason: "dropped_no_displayable_citation",
      prompt_version: "display-coverage-v2", input_hash: "input", validator_model: "validator",
      decision: { claims: [] }, created_at: "2026-09-09T00:00:00.000Z",
    }],
  };
  saveAnalysisBatch(db, emptyAudited);
  expect(getAnalysisBatch(db, "b-empty")).toEqual(emptyAudited);
});

it("展示审计不能把其他 batch 的 insight 伪装成本 batch 的证据", () => {
  saveAnalysisBatch(db, batch);
  saveAnalysisBatch(db, { ...structuredClone(batch), id: "b2", insights: [] });
  const params = {
    batch_id: "b2", insight_id: "i1", candidate_id: "candidate", gate_version: "v", terminal_reason: "kept",
    prompt_version: "v", input_hash: "hash", validator_model: "validator", decision: "{}", created_at: "2026-09-09T00:00:00.000Z",
  };
  expect(() => db.prepare(`INSERT INTO display_coverage_audit
    (batch_id,insight_id,candidate_id,gate_version,terminal_reason,prompt_version,input_hash,validator_model,decision,created_at)
    VALUES (@batch_id,@insight_id,@candidate_id,@gate_version,@terminal_reason,@prompt_version,@input_hash,@validator_model,@decision,@created_at)`).run(params))
    .toThrow("display coverage audit insight belongs to another batch");
});

it("ValidationResult 往返（checks + report，含可达性短路项）", () => {
  saveAnalysisBatch(db, batch);
  const vr: ValidationResult = {
    checks: [
      { insight_id: "i1", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
      { insight_id: "i2", citation_index: 0, reachability: "fail", reachability_reason: "quote_not_in_source", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "blocked" },
    ],
    report: { total: 2, pass: 1, blocked: 1, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 2, insights_includable: 1, releasable: true },
  };
  saveValidationResult(db, "b1", vr);
  expect(getValidationResult(db, "b1")).toEqual(vr);
});
