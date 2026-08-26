/** Stable, synthetic bounds used for P1 dashboard query-plan evidence. */
export const P1_METRICS_CAPACITY_FIXTURE = {
  version: "p1-metrics-capacity-v2",
  // Kept as the short-window compatibility vector for fact-contract tests.
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" },
  detail_window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" },
  aggregate_window: { from: "2025-08-01T00:00:00.000Z", to: "2026-09-05T00:00:00.000Z" },
  dimensions: { topic_id: "topic_1", source_id: "source_1", pipeline_version: "pipeline-v1" },
} as const;
