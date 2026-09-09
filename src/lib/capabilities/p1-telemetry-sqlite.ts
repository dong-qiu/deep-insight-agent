/** P1-dev adapter. Keep this dependency outside P0 pipeline modules. */
import type { P1TelemetrySink } from "./p1-telemetry.js";
import { appendAnalysisMetricFacts, appendCollectorMetricFact, appendValidationMetricFacts } from "../db/p1-metrics-pipeline.js";
import { freezeDueMetricDay } from "../db/p1-metrics-facts.js";

export const SQLITE_P1_TELEMETRY_SINK: P1TelemetrySink = {
  recordCollector: appendCollectorMetricFact,
  recordAnalysis: appendAnalysisMetricFacts,
  recordValidation: appendValidationMetricFacts,
  freezeDueDay: freezeDueMetricDay,
};
