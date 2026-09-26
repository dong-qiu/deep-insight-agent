/**
 * Curated, non-promotable A1 subset for prototype releases. The IDs live in the canonical
 * repository fixtures so the full benchmark's ordering and content are never copied or changed.
 */
export const A1_PROTOTYPE_SAFETY_LIMITS = {
  A1_QUALITY_LIMIT: "1",
  A1_CONSISTENCY_LIMIT: "12",
  A1_DISPLAY_COVERAGE_LIMIT: "0",
  A1_QUOTE_SELF_CONTAINED_LIMIT: "0",
  A1_FORCE_SMOKE: "1",
  A1_DISPLAY_COVERAGE_IDS: [
    "controlled-poc-to-blackbox",
    "specbench-task-scope-to-universal",
    "kv-certification-to-not-merely-empirical",
    "llamaweb-combinations-to-edge-portability",
    "chinese-production-bypass",
    "composite-evidence-stitching",
    "statement-expands-bound-claim-with-automatic",
    "bound-claim-still-needs-quote-support",
    "source-quote-projects-synthetic-scope",
    "source-quote-explicit-synthetic-positive",
    "source-quote-paraphrased-synthetic-positive",
    "source-quote-chinese-synthetic-positive",
    "generic-subject-direct-positive",
    "direct-factual-positive",
  ].join(","),
  A1_QUOTE_SELF_CONTAINED_IDS: [
    "anaphora-it",
    "anaphora-former",
    "generic-approach",
    "chinese-demonstrative",
    "explicit-subject",
    "explicit-benchmark",
    "explicit-scope",
    "chinese-explicit",
  ].join(","),
} as const;

export function applyA1PrototypeSafetyConfig(env: Record<string, string | undefined> = process.env): void {
  Object.assign(env, A1_PROTOTYPE_SAFETY_LIMITS);
}
