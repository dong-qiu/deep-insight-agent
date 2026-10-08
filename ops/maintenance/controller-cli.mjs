/** Offline stdin consumer only; no command execution or transport. */
import { runControllerStep } from "./controller.mjs";
const allowedErrors = new Set(["invalid_controller_input", "controller_ledger_failed", "maintenance_owner_lost", "maintenance_revision_conflict",
  "invalid_maintenance_transition", "unsafe_maintenance_path", "noncanonical_maintenance_root", "maintenance_file_replaced", "maintenance_marker_changed",
  "unexpected_maintenance_sidecar", "maintenance_target_mismatch", "invalid_maintenance_record", "invalid_maintenance_schema", "invalid_maintenance_version",
  "invalid_maintenance_journal", "maintenance_audit_corrupt", "maintenance_genesis_mismatch", "maintenance_snapshot_invalid", "maintenance_genesis_missing",
  "maintenance_active_corrupt", "maintenance_fence_corrupt", "maintenance_operation_corrupt", "maintenance_submission_corrupt", "maintenance_record_too_large"]);
try {
  if (process.argv.length !== 4) throw new Error("invalid_controller_input");
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) { process.stdin.destroy(); throw new Error("invalid_controller_input"); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size), text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("invalid_controller_input");
  let input; try { input = JSON.parse(text); } catch { throw new Error("invalid_controller_input"); }
  const result = runControllerStep(process.argv[2], process.argv[3], input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.outcome === "blocked") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error && allowedErrors.has(error.message) ? error.message : "invalid_controller_input"}\n`);
  process.exitCode = 1;
}
