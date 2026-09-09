import { describe, expect, it } from "vitest";
import type { AnalysisBatch, Insight, ValidationResult } from "../src/lib/types.js";
import { selectInsights } from "../src/lib/agents/report-gen.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../src/lib/utils/source-quote-projection.js";
import {
  countReaderVisibleByTopic,
  DCP_MIN_CONSISTENCY_PAIRS,
  DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC,
  DCP_MIN_TOPICS,
  dcpSamplePrerequisite,
} from "./a1-dcp.js";

const topicCounts = (counts: readonly number[]) => counts.map((count, index) => ({ topic_id: `topic-${index + 1}`, count }));

describe("A1 DCP sample prerequisite", () => {
  it("仅主题数和一致性对达标不足以签 DCP：还必须有足量 reader-visible 洞察", () => {
    const counts = Array.from({ length: DCP_MIN_TOPICS }, () => DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC);
    counts[0]!--;
    expect(dcpSamplePrerequisite({
      topics: DCP_MIN_TOPICS,
      consistencyPairs: DCP_MIN_CONSISTENCY_PAIRS,
      readerVisibleInsightsByTopic: topicCounts(counts),
    })).toContain("reader-visible 洞察");
  });

  it("50 条集中在一个主题仍必须阻断，不能把总数当作每主题覆盖", () => {
    expect(dcpSamplePrerequisite({
      topics: DCP_MIN_TOPICS,
      consistencyPairs: DCP_MIN_CONSISTENCY_PAIRS,
      readerVisibleInsightsByTopic: topicCounts([DCP_MIN_TOPICS * DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC, 0, 0, 0, 0]),
    })).toContain("主题 topic-2:0/10 未达标");
  });

  it("拒绝重复 topic id，避免 quality case 数量伪装成主题覆盖", () => {
    expect(dcpSamplePrerequisite({
      topics: DCP_MIN_TOPICS,
      consistencyPairs: DCP_MIN_CONSISTENCY_PAIRS,
      readerVisibleInsightsByTopic: [
        { topic_id: "same", count: 10 }, { topic_id: "same", count: 10 },
        ...topicCounts([10, 10, 10]),
      ],
    })).toContain("重复 topic_id：same");
  });

  it("真实链路：raw analyze 洞察的绑定引用全 blocked 时，selectInsights 计数为零并阻断 DCP", () => {
    const quote = "A tool shipped.";
    const insight: Insight = {
      id: "i1", topic_id: "topic-1", type: "aggregation", event_id: null, statement: quote,
      statement_citation_index: 1, importance: 4, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
      citations: [{ content_item_id: "ci1", citation_ref: "binding", quote, locator: { paragraph_index: 0, char_start: 0, char_end: quote.length } }],
      source_count: 1, multi_source: false, time_window: { start: "2026-09-01", end: "2026-09-02" }, confidence: null, language: "en",
    };
    const batch: AnalysisBatch = {
      id: "b1", topic_id: "topic-1", time_window: insight.time_window, status: "done", no_significant_event: false, insights: [insight],
      display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION,
      display_coverage_audits: [{
        insight_id: insight.id, candidate_id: insight.id, gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "x", validator_model: "coverage",
        decision: { statement_citation_index: 1, statement_citation_ref: "binding", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash(quote), quote_sha256: sourceQuoteHash(quote), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] },
        created_at: "2026-09-09T00:00:00Z",
      }],
    };
    const blocked: ValidationResult = {
      checks: [{ insight_id: insight.id, citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "not_support", consistency_reason: "exaggeration", verdict: "blocked" }],
      report: { total: 1, pass: 0, blocked: 1, flagged: 0, errored: 0, consistency_failure_rate: 1, flagged_rate: 0, insights_total: 1, insights_includable: 0, releasable: false },
    };
    const readerVisible = selectInsights(batch, blocked).map((entry) => entry.insight);
    expect(batch.insights).toHaveLength(1);
    expect(readerVisible).toEqual([]);
    const counts = countReaderVisibleByTopic(
      Array.from({ length: DCP_MIN_TOPICS }, (_, index) => `topic-${index + 1}`),
      readerVisible,
    );
    expect(counts[0]).toEqual({ topic_id: "topic-1", count: 0 });
    expect(dcpSamplePrerequisite({ topics: DCP_MIN_TOPICS, consistencyPairs: DCP_MIN_CONSISTENCY_PAIRS, readerVisibleInsightsByTopic: counts }))
      .toContain("主题 topic-1:0/10 未达标");
  });

  it("三个维度且每个主题均达标时不再产生样本量阻断", () => {
    expect(dcpSamplePrerequisite({
      topics: DCP_MIN_TOPICS,
      consistencyPairs: DCP_MIN_CONSISTENCY_PAIRS,
      readerVisibleInsightsByTopic: topicCounts(Array.from({ length: DCP_MIN_TOPICS }, () => DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC)),
    })).toBeNull();
  });
});
