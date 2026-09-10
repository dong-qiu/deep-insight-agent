/**
 * P1 lifecycle is a composition policy, never a production authorization.
 * Existing anchor/dashboard/deploy guards remain independent fail-closed
 * controls. This policy only selects a no-op or local development observer.
 */
export type CapabilityEnvironment = Readonly<Record<string, string | undefined>>;
export type P1Lifecycle = "dormant" | "dev";

export function p1Lifecycle(env: CapabilityEnvironment = process.env): P1Lifecycle {
  // Production is always dormant before a separately implemented admission.
  if (env.NODE_ENV === "production") return "dormant";
  return env.P1_LIFECYCLE === "dev" ? "dev" : "dormant";
}
