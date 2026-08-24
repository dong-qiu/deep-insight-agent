/** Alert adapter for integrity rechecks. Payload is deliberately diagnostic-only. */
import type { IntegrityCheckResult } from "../db/integrity-checks.js";
import { notify } from "./alert.js";

export function notifyIntegrityFailure(checked: IntegrityCheckResult): void {
  try {
    notify({
      title: "🔴 Artifact integrity check failed",
      text: `Artifact: ${checked.artifact_id}@${checked.artifact_version}\nOutcome: ${checked.outcome}\nStep: ${checked.failure_step ?? "unknown"}\nExpected/actual hash prefixes: ${checked.expected_hash_prefix ?? "-"}/${checked.actual_hash_prefix ?? "-"}`,
      priority: "high",
      tags: ["rotating_light"],
    });
  } catch { /* Alert delivery never affects integrity evidence or report reads. */ }
}
