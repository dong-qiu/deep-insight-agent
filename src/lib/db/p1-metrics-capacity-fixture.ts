/** Stable, synthetic bounds used for P1b-2 dashboard query-plan evidence. */
export const P1_METRICS_CAPACITY_FIXTURE = {
  version: "p1-metrics-capacity-v1",
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" },
  dimensions: { topic_id: "topic_1", source_id: "source_1", pipeline_version: "pipeline-v1" },
} as const;
