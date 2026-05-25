import { beforeEach, expect, it } from "vitest";
import type { AnalysisBatch, Topic, ValidationResult } from "../types.js";
import { getAnalysisBatch, getValidationResult, saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { type DB, openDb } from "./index.js";
import { insertTopic } from "./repos.js";

let db: DB;
const topic: Topic = {
  id: "t1", name: "T", keywords: ["k"], industry: "ai-swe", language: "zh",
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
      id: "i1", topic_id: "t1", type: "aggregation", event_id: null, statement: "S1",
      importance: 4, importance_basis: "basis",
      citations: [{ content_item_id: "ci1", quote: "q1", locator: { paragraph_index: 0, char_start: 0, char_end: 2 } }],
      source_count: 1, multi_source: false, time_window: { start: "2026-05-01", end: "2026-05-07" },
      confidence: null, language: "zh",
    },
    {
      id: "i2", topic_id: "t1", type: "trend", event_id: null, statement: "S2",
      importance: 5, importance_basis: "b2",
      citations: [
        { content_item_id: "ci1", quote: "q2a", locator: { paragraph_index: 0, char_start: 3, char_end: 5 } },
        { content_item_id: "ci2", quote: "q2b", locator: { paragraph_index: 1, char_start: 0, char_end: 4 } },
      ],
      source_count: 2, multi_source: true, time_window: { start: "2026-05-01", end: "2026-05-07" },
      confidence: "high", language: "zh",
    },
  ],
};

it("AnalysisBatch 往返（含 insights + citations）", () => {
  saveAnalysisBatch(db, batch);
  expect(getAnalysisBatch(db, "b1")).toEqual(batch);
});

it("ValidationResult 往返（checks + report，含可达性短路项）", () => {
  saveAnalysisBatch(db, batch);
  const vr: ValidationResult = {
    checks: [
      { insight_id: "i1", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
      { insight_id: "i2", citation_index: 0, reachability: "fail", reachability_reason: "quote_not_in_source", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "blocked" },
    ],
    report: { total: 2, pass: 1, blocked: 1, flagged: 0, consistency_failure_rate: 0, flagged_rate: 0, releasable: true },
  };
  saveValidationResult(db, "b1", vr);
  expect(getValidationResult(db, "b1")).toEqual(vr);
});
