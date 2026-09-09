/**
 * P1 lifecycle is a composition policy, never a production authorization.
 * Existing anchor/dashboard/deploy guards remain independent fail-closed
 * controls. This policy only selects a no-op or local development observer.
 */
import { NOOP_P1_TELEMETRY_SINK, type P1TelemetrySink } from "../capabilities/p1-telemetry.js";
import { SQLITE_P1_TELEMETRY_SINK } from "../capabilities/p1-telemetry-sqlite.js";

type CapabilityEnvironment = Readonly<Record<string, string | undefined>>;
export type P1Lifecycle = "dormant" | "dev";

export function p1Lifecycle(env: CapabilityEnvironment = process.env): P1Lifecycle {
  // Production is always dormant before a separately implemented admission.
  if (env.NODE_ENV === "production") return "dormant";
  return env.P1_LIFECYCLE === "dev" ? "dev" : "dormant";
}

export function p1TelemetrySinkForRuntime(env: CapabilityEnvironment = process.env): P1TelemetrySink {
  return p1Lifecycle(env) === "dev" ? SQLITE_P1_TELEMETRY_SINK : NOOP_P1_TELEMETRY_SINK;
}
