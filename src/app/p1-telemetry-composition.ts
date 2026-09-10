/**
 * App/worker composition root for the optional P1 observer.
 *
 * This is deliberately outside `src/lib/agents`: the core pipeline receives
 * a P1TelemetrySink explicitly and otherwise uses its no-op implementation.
 */
import { NOOP_P1_TELEMETRY_SINK, type P1TelemetrySink } from "../lib/capabilities/p1-telemetry.js";
import { SQLITE_P1_TELEMETRY_SINK } from "../lib/capabilities/p1-telemetry-sqlite.js";
import { p1Lifecycle, type CapabilityEnvironment } from "../lib/runtime/p1-lifecycle.js";

export function p1TelemetrySinkForApp(env: CapabilityEnvironment = process.env): P1TelemetrySink {
  return p1Lifecycle(env) === "dev" ? SQLITE_P1_TELEMETRY_SINK : NOOP_P1_TELEMETRY_SINK;
}
