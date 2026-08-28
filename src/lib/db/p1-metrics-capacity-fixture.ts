/** Versioned shape for the production-SQL capacity harness. */
export const P1_METRICS_CAPACITY_FIXTURE = {
  version: "p1-metrics-capacity-v4",
  generator_version: "p1-metrics-capacity-generator-v4",
  days: 400,
  // Kept as the short-window compatibility vector for fact-contract tests.
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" },
  detail_window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" },
  aggregate_window: { from: "2025-08-01T00:00:00.000Z", to: "2026-09-05T00:00:00.000Z" },
  aggregate_partial_window: { from: "2025-08-01T12:00:00.000Z", to: "2026-09-05T12:00:00.000Z" },
  dimensions: { topics: ["topic_1", "topic_2"], sources: ["source_1", "source_2"], pipelines: ["pipeline-v1", "pipeline-v2"], providers: ["openai/gpt", "anthropic/claude"] },
} as const;
