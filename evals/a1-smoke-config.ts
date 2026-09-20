/** Fixed, intentionally small limits for developer feedback. They are paired with
 * A1_FORCE_SMOKE so even a custom fixture smaller than these limits stays non-promotable. */
export const A1_SMOKE_LIMITS = {
  A1_QUALITY_LIMIT: "1",
  A1_CONSISTENCY_LIMIT: "12",
  A1_DISPLAY_COVERAGE_LIMIT: "8",
  A1_QUOTE_SELF_CONTAINED_LIMIT: "4",
  A1_FORCE_SMOKE: "1",
} as const;

export function applyA1SmokeConfig(env: Record<string, string | undefined> = process.env): void {
  Object.assign(env, A1_SMOKE_LIMITS);
}
