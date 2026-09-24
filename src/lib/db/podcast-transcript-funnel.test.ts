import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { appendTranscriptAcquisitionFact, insertSource, transcriptAcquisitionEventKey } from "./repos.js";
import { readTranscriptAcquisitionFunnel } from "./podcast-transcript-funnel.js";
import type { Source, TranscriptAcquisitionFact } from "../types.js";

const source: Source = {
  id: "pod-funnel", name: "Pod Funnel", type: "rss", endpoint: "https://pod.example/feed", topic_ids: ["t"],
  fetch_interval: "1h", backfill: null, enabled: true, transcript_mode: "observe", transcript_strategy: "relevant_only",
  transcript_max_items_per_run: 2, transcript_max_bytes_per_run: 1000, transcript_timeout_budget_ms: 1000,
  transcript_host_qps: 1, transcript_policy_version: "podcast-policy-v1",
};

describe("readTranscriptAcquisitionFunnel", () => {
  it("按 source/day/scope 投影候选、决策、尝试、结果、配额、资源和回退原因", () => {
    const db = openDb(":memory:");
    insertSource(db, source);
    const common = {
      source_id: source.id, canonical_episode_url: "https://pod.example/ep", candidate_hash: "candidate",
      transcript_policy_version: "podcast-policy-v1", mode: "observe" as const, strategy: "relevant_only" as const,
      execution_scope: "shadow" as const, adapter_version: "rss-podcast-transcript-shadow-v1", decision: "fetch" as const,
      fallback_body_kind: "show_notes" as const, content_item_id: null, raw_ref: null, run_id: null,
      occurred_at: "2026-09-13T12:00:00.000Z",
    };
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [
      { ...common, stage: "candidate", attempt: 0, outcome: "not_attempted", reason_code: "podcast_metadata", bytes: null, duration_ms: null, evidence_status: "not_applicable" },
      { ...common, stage: "decision", attempt: 0, outcome: "decision", reason_code: "topic_keyword_match", bytes: null, duration_ms: null, evidence_status: "not_applicable" },
      { ...common, stage: "attempt", attempt: 1, outcome: "not_attempted", reason_code: "transcript_request_started", bytes: null, duration_ms: null, evidence_status: "pending" },
      { ...common, stage: "terminal", attempt: 1, outcome: "budget_limited", reason_code: "source_budget_exhausted_before_program_page", bytes: 120, duration_ms: 45, evidence_status: "failed" },
    ];
    for (const fact of facts) appendTranscriptAcquisitionFact(db, { ...fact, event_key: transcriptAcquisitionEventKey(fact) });
    expect(readTranscriptAcquisitionFunnel(db, {
      from: "2026-09-13T00:00:00.000Z", to: "2026-09-14T00:00:00.000Z", source_id: source.id,
    })).toEqual([{
      source_id: source.id, day: "2026-09-13", execution_scope: "shadow", candidates: 1,
      decision_fetch: 1, decision_unknown: 0, decision_hard_negative: 0, attempts: 1, terminals: 1,
      successes: 0, budget_limited: 1, bytes: 120, duration_ms: 45,
      terminal_reasons: [{ outcome: "budget_limited", reason_code: "source_budget_exhausted_before_program_page", count: 1 }],
    }]);
    db.close();
  });
});
