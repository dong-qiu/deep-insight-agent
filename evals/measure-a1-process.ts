/** Parent wall-clock observer. CLI requires --prepare or explicit --execute; never resumes/retries. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { a1DiagnosticLimits, type A1DiagnosticLimits } from "./a1-attempt-diagnostics.js";

export async function measureA1Process(options: {
  outputRoot: string; limits: A1DiagnosticLimits; prepare: boolean;
  /** Test callers pass a credential-free env and network-rejecting preload. */
  env?: NodeJS.ProcessEnv; preloads?: string[];
}) {
  const env = { ...(options.env ?? process.env), A1_DIAGNOSTIC_MAX_ATTEMPTS: String(options.limits.max_attempts), A1_DIAGNOSTIC_WINDOW_MS: String(options.limits.window_ms) };
  a1DiagnosticLimits(env); // Same validation as runner; no parallel parser.
  const root = join(resolve(options.outputRoot), `sample-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const childEnv = { ...env, A1_RUNS_DIR: root, A1_DIAGNOSTIC_PREPARE_ONLY: options.prepare ? "1" : "0", A1_RESUME_FROM: "", A1_DIAGNOSTIC_COLD_ONLY: "1", A1_FORCE_SMOKE: "1" };
  const args = ["--import", "tsx", ...(options.preloads ?? (options.prepare ? ["./evals/fixtures/td14-prepare-only.ts"] : [])).flatMap((path) => ["--import", path]), "evals/run-a1.ts"];
  const started = performance.now();
  const child = spawn(process.execPath, args, { env: childEnv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let publication: { publication_wall_ms: number; boundary: string } | null = null;
  child.on("message", (message) => {
    if (message && typeof message === "object" && "type" in message && message.type === "a1_diagnostic_publication"
      && "publication_wall_ms" in message && typeof message.publication_wall_ms === "number" && Number.isFinite(message.publication_wall_ms) && message.publication_wall_ms >= 0) {
      publication = { publication_wall_ms: message.publication_wall_ms, boundary: "boundary" in message && typeof message.boundary === "string" ? message.boundary : "unknown" };
    }
  });
  let forced: ReturnType<typeof setTimeout> | undefined;
  let windowExceeded = false;
  const timer = setTimeout(() => {
    windowExceeded = true;
    child.kill("SIGTERM");
    // Local process control cannot retract already dispatched provider fees.
    forced = setTimeout(() => child.kill("SIGKILL"), 1000);
  }, options.limits.window_ms);
  const outcome = await new Promise<{ exit_code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once("error", reject);
    child.once("close", (exit_code, signal) => done({ exit_code, signal }));
  }).finally(() => { clearTimeout(timer); if (forced) clearTimeout(forced); });
  const wall = performance.now() - started;
  const directory = readdirSync(root).find((name) => name.startsWith("a1-"));
  const read = (file: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(join(root, directory!, file), "utf8")); } catch { return null; } };
  const manifest = directory ? read("manifest.json") : null;
  const lifecycle = publication as { publication_wall_ms: number; boundary: string } | null;
  const mainWall = (manifest?.timing as { overall_wall_ms?: number } | undefined)?.overall_wall_ms ?? null;
  const sample = { version: 1, mode: options.prepare ? "prepare_only" : "diagnostic", ...outcome,
    measurement_complete: !windowExceeded && outcome.exit_code === 0 && lifecycle !== null && mainWall !== null,
    diagnostic_execution_complete: !options.prepare && !windowExceeded && outcome.exit_code === 0 && (manifest?.attempt_diagnostics as { execution_complete?: boolean } | undefined)?.execution_complete === true,
    process_wall_ms: wall, window_exceeded: windowExceeded, forced_exit_grace_ms: 1000,
    main_wall_ms: mainWall, publication_wall_ms: lifecycle?.publication_wall_ms ?? null,
    // These boundaries overlap on failure; don't subtract publication wall from this residual.
    outside_main_wall_ms: typeof mainWall === "number" ? wall - mainWall : null,
    outside_main_boundary: "spawn_module_loading_final_publication_exit_observer_overhead",
    execution_status: manifest?.status ?? "unavailable", auto_gate: manifest?.auto_gate ?? "not_evaluated",
    baseline_comparison: manifest?.baseline_comparison ?? "not_evaluated", tail_latency: "insufficient_samples",
    provider_billing: "unknown_in_flight_work_may_continue", raw_samples: "preserved_in_child_manifest" };
  if (directory && lifecycle) writeFileSync(join(root, directory, "diagnostic-lifecycle.json"), JSON.stringify(lifecycle, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(root, "process-observation.json"), JSON.stringify(sample, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { root, sample };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes("--prepare") === args.includes("--execute") || !value("--output")) {
    console.error("Use --prepare (zero requests) or --execute (requires separate model authorization), --max-attempts N --window-ms N --output PRIVATE_DIR");
    process.exitCode = 2;
  } else {
    const limits = a1DiagnosticLimits({ A1_DIAGNOSTIC_MAX_ATTEMPTS: value("--max-attempts"), A1_DIAGNOSTIC_WINDOW_MS: value("--window-ms") });
    if (!limits) throw new Error("explicit_diagnostic_limits_required");
    const { sample } = await measureA1Process({ prepare: args.includes("--prepare"), limits, outputRoot: value("--output")! });
    console.log(JSON.stringify(sample));
    process.exitCode = sample.window_exceeded ? 1 : sample.exit_code ?? 1;
  }
}
