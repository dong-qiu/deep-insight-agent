/** Dedicated cold task: four identity cases, then the unchanged prototype safety selection. */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EvaluationBudget, cancelTask, createBudget, digest, privateJson } from "./d7-s2b-evaluation-budget.js";

type Json = Record<string, unknown>;
const json = (path: string): Json => JSON.parse(readFileSync(path, "utf8")) as Json;
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export function sourceBinding(cwd: string) {
  if (git(cwd, "status", "--porcelain")) throw new Error("evaluation_source_must_be_clean");
  return { commit: git(cwd, "rev-parse", "HEAD"), tree: git(cwd, "rev-parse", "HEAD^{tree}"),
    lockfile_sha256: digest(readFileSync(join(cwd, "package-lock.json"))) };
}

/** Only called after child close, on this fresh task's exclusive A1 root. */
export function sealFailedOutputs(root: string, reason: string): void {
  const failures: string[] = [];
  const pointer = join(root, "latest-complete.json");
  if (existsSync(pointer)) unlinkSync(pointer);
  for (const name of readdirSync(root)) {
    if (!/^\.?a1-\d{14}-[a-f0-9]{8}(\.tmp)?$/.test(name)) continue;
    const run = join(root, name), audit: Json = { reason, original_hashes: {} };
    const changed: Record<string, string> = {};
    for (const file of ["quality-checkpoint.json", "progress.json", "a1-run.json", "manifest.json"]) {
      const path = join(run, file); if (!existsSync(path)) continue;
      try {
      (audit.original_hashes as Json)[file] = digest(readFileSync(path));
      const value = json(path);
      if (file === "quality-checkpoint.json") {
        value.recovery_identity_sha256 = null;
        for (const entry of (value.cases ?? []) as Json[]) delete entry.completed;
      } else {
        value.execution_complete = false;
        if (file === "progress.json") { value.state = "failed"; delete value.completed; }
        else { value.status = "failed"; value.auto_gate = "not_evaluated"; value.baseline_comparison = "not_evaluated"; value.dcp_eligibility = "not_evaluated"; }
        const diagnostics = value.attempt_diagnostics as Json | undefined;
        if (diagnostics) { diagnostics.execution_complete = false; diagnostics.stop_reason = reason; }
        if (file === "manifest.json") {
          const artifacts = value.artifacts as Json | undefined;
          if (artifacts) for (const [key, hash] of Object.entries(changed)) if (key in artifacts) artifacts[key] = hash;
          value.error = `d7_task_${reason}`;
        }
      }
      privateJson(path, value); changed[file] = digest(readFileSync(path));
      } catch { failures.push(file); }
    }
    audit.sealed_hashes = changed; privateJson(join(run, "d7-failure-seal.json"), audit);
  }
  if (failures.length) throw new Error("evaluation_failure_seal_incomplete");
}

export function failEvaluationOutputs(root: string, budget: EvaluationBudget): void {
  cancelTask(root, "task_incomplete");
  try { budget.fail("task_incomplete"); } catch { /* Corrupt state must not suppress checkpoint sealing. */ }
  try {
    for (const name of ["prototype-safety-receipt.json", "task-receipt.json"]) if (existsSync(join(root, name))) unlinkSync(join(root, name));
    if (existsSync(join(root, "identity-result.json"))) {
      const identity = json(join(root, "identity-result.json")); identity.execution_complete = false;
      const diagnostics = identity.diagnostics as Json | undefined;
      if (diagnostics) diagnostics.execution_complete = false; privateJson(join(root, "identity-result.json"), identity);
    }
  } finally { sealFailedOutputs(join(root, "a1"), "task_incomplete"); }
}

/** Covers parent-only certification/publication as well as child execution. */
export class EvaluationLifetime {
  activeChild = false;
  private readonly timer;
  private readonly signal = (): void => this.stop("cancelled");
  constructor(readonly root: string, readonly budget: EvaluationBudget) {
    this.timer = setTimeout(() => this.stop("deadline"), Math.max(1, budget.check().deadline - Date.now()));
    process.on("SIGINT", this.signal); process.on("SIGTERM", this.signal);
  }
  private stop(reason: string): void {
    cancelTask(this.root, reason);
    // Active-child cancellation is handled by child(), which awaits close before sealing.
    if (!this.activeChild) {
      try { failEvaluationOutputs(this.root, this.budget); } catch { /* Remains STOP/incomplete even if sealing fails. */ }
    }
  }
  dispose(): void { clearTimeout(this.timer); process.removeListener("SIGINT", this.signal); process.removeListener("SIGTERM", this.signal); }
}

async function child(options: { candidate: string; guard: string; root: string; nonce: string; mode: "identity" | "a1"; prepare: boolean }): Promise<void> {
  const budget = new EvaluationBudget(options.root, options.nonce, null);
  const state = budget.check();
  const output = join(options.root, `${options.mode}.log`);
  writeFileSync(output, "", { flag: "wx", mode: 0o600 });
  const childProcess = spawn(process.execPath, ["--import", "tsx", "--import", join(options.guard, "evals/d7-s2b-evaluation-preload.ts"),
    join(options.guard, "evals/d7-s2b-evaluation-child.ts")], {
    cwd: options.candidate, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, D7_EVALUATION_CHILD: "1", D7_EVALUATION_CANDIDATE: options.candidate,
      D7_EVALUATION_ROOT: options.root, D7_EVALUATION_NONCE: options.nonce, D7_EVALUATION_MODE: options.mode,
      A1_RUNS_DIR: join(options.root, "a1"), A1_RESUME_FROM: "", A1_DIAGNOSTIC_COLD_ONLY: "1",
      A1_DIAGNOSTIC_PREPARE_ONLY: options.prepare ? "1" : "0", A1_DIAGNOSTIC_MAX_ATTEMPTS: "100",
      A1_DIAGNOSTIC_WINDOW_MS: String(Math.max(1, state.deadline - Date.now())) },
  });
  // Private logs may contain source/model text; never stream them to the terminal.
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string): void => {
    cancelTask(options.root, reason); childProcess.kill("SIGTERM");
    force ??= setTimeout(() => childProcess.kill("SIGKILL"), 1000);
  };
  const log = (bytes: Buffer): void => { try { appendFileSync(output, bytes); } catch { stop("private_log_write_failed"); } };
  childProcess.stdout!.on("data", log); childProcess.stderr!.on("data", log);
  const cancel = (): void => stop("cancelled");
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const timer = setTimeout(() => stop("deadline"), Math.max(1, state.deadline - Date.now()));
  let exit: number | null;
  let spawnError = false;
  try { exit = await new Promise<number | null>((done) => {
    childProcess.once("error", () => { spawnError = true; }); // Always wait for close before the parent mutates state or seals outputs.
    childProcess.once("close", done);
  }); }
  finally { clearTimeout(timer); if (force) clearTimeout(force); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  // Parent becomes the sole state writer only after close. An early bootstrap failure may never have claimed it.
  const final = json(join(options.root, "budget.json"));
  if (final.owner !== childProcess.pid && final.owner !== null) throw new Error("evaluation_child_owner_mismatch");
  final.owner = null; privateJson(join(options.root, "budget.json"), final);
  if (existsSync(join(options.root, "actor.json"))) unlinkSync(join(options.root, "actor.json"));
  if (spawnError || exit !== 0) { budget.fail("child_execution_incomplete"); throw new Error("evaluation_child_failed"); }
  budget.check();
}

export async function runEvaluation(options: { candidate: string; output: string; input: string; prepare: boolean; prepared?: string }) {
  process.umask(0o077);
  const candidate = resolve(options.candidate), guard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const binding = { candidate: sourceBinding(candidate), guard: sourceBinding(guard),
    input_sha256: digest(readFileSync(options.input)), node: process.version };
  if (binding.input_sha256 !== "056a6748ad961d4785ae36f1a5706ca1efda3af692613a681d4137f0f6d14c37") throw new Error("identity_input_drift");
  if (!/^v24\.19\./.test(process.version)) throw new Error("evaluation_node_mismatch");
  process.chdir(candidate);
  await import(pathToFileURL(join(candidate, "evals/load-env.ts")).href);
  const { applyA1PrototypeSafetyConfig } = await import(pathToFileURL(join(candidate, "evals/a1-prototype-safety-config.ts")).href) as typeof import("./a1-prototype-safety-config.js");
  applyA1PrototypeSafetyConfig();
  const configEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(A1_|LLM_|ANALYZER_|VALIDATOR_|COVERAGE_|CONSISTENCY_|ANALYZE_|SELECT_|PROMPT_CACHE)/.test(key) && !/API_KEY|AUTH_TOKEN|SECRET|DIAGNOSTIC|RESUME|RUNS_DIR|PREPARE/.test(key)).sort());
  // Includes endpoint/config changes as a one-way binding; no values or credentials are persisted.
  const env_sha256 = digest(JSON.stringify(configEnv));
  const frozen = { ...binding, env_sha256 };
  if (!options.prepare) {
    if (!options.prepared) throw new Error("evaluation_requires_fresh_preparation");
    const prepared = json(options.prepared);
    if (JSON.stringify(prepared.binding) !== JSON.stringify(frozen) || prepared.mode !== "prepared_zero_requests") throw new Error("evaluation_preparation_drift");
  }
  const root = resolve(options.output);
  mkdirSync(root, { mode: 0o700 }); // Exclusive fresh task; never reuse baseline/cache/checkpoint roots.
  chmodSync(root, 0o700); mkdirSync(join(root, "a1"), { mode: 0o700 });
  writeFileSync(join(root, "identity-input.json"), readFileSync(options.input), { flag: "wx", mode: 0o600 });
  const state = createBudget(root, { attempts: options.prepare ? 0 : 100, retries: 20, window: 2700000 });
  const budget = new EvaluationBudget(root, state.nonce, null);
  const lifetime = new EvaluationLifetime(root, budget);
  const runChild = async (mode: "identity" | "a1", prepare: boolean): Promise<void> => {
    lifetime.activeChild = true;
    try { await child({ candidate, guard, root, nonce: state.nonce, mode, prepare }); }
    finally { lifetime.activeChild = false; }
  };
  privateJson(join(root, "binding.json"), frozen);
  try {
    if (!options.prepare) await runChild("identity", false);
    await runChild("a1", options.prepare);
    if (JSON.stringify(sourceBinding(candidate)) !== JSON.stringify(binding.candidate)
      || JSON.stringify(sourceBinding(guard)) !== JSON.stringify(binding.guard)) throw new Error("evaluation_source_drift");
    if (options.prepare) {
      const directory = readdirSync(join(root, "a1")).find((name) => /^a1-/.test(name));
      if (!directory) throw new Error("evaluation_preparation_missing");
      const plan = json(join(root, "a1", directory, "diagnostic-plan.json"));
      const { a1QualityCheckpointConfigSha256 } = await import(pathToFileURL(join(candidate, "evals/a1-quality-checkpoint.ts")).href) as typeof import("./a1-quality-checkpoint.js");
      if (a1QualityCheckpointConfigSha256(plan.config as object) !== "22d79dcecb79b1dae6dbe830dac3a6ca30f1814aa37ebedb01b29793d75fa288") throw new Error("authorized_config_drift");
      const input = plan.input as Json;
      if (JSON.stringify(input.counts) !== JSON.stringify({ quality: 1, consistency: 12, display: 14, quote: 8 })
        || input.selected_quality_sha256 !== "186ff6ea7547d25c3c302e460de9c07a95b2684495aff1e1cb993eebb07cb82f"
        || input.selected_consistency_sha256 !== "21b61d00318c52efd5fa58f60e8acd532c923d9e75199ac395eca214395893b9"
        || input.selected_display_sha256 !== "8fafaca23722a2702506902f23de5cf20a8f565cee4a3019b93ba8c34270c7a5"
        || input.selected_quote_sha256 !== "29aeef7782a94cb9b3ec43015dd7b6943d8b35230ccfdcc5f6128e6e9efced09") throw new Error("authorized_input_drift");
      if (budget.check().attempts.length !== 0 || plan.execution_complete !== false) throw new Error("evaluation_prepare_not_zero");
      sealFailedOutputs(join(root, "a1"), "prepared_without_execution");
      privateJson(join(root, "preparation.json"), { mode: "prepared_zero_requests", binding: frozen, plan,
        plan_sha256: digest(readFileSync(join(root, "a1", directory, "diagnostic-plan.json"))) });
      return { root, mode: "prepared_zero_requests", attempts: 0 };
    }
    const identity = json(join(root, "identity-result.json"));
    if (identity.execution_complete !== true || (identity.cases as unknown[]).length !== 4) throw new Error("identity_incomplete");
    const pointer = json(join(root, "a1/latest-complete.json")), manifestPath = resolve(String(pointer.manifest));
    if (!manifestPath.startsWith(`${join(root, "a1")}/`)) throw new Error("evaluation_pointer_outside_task");
    const manifest = json(manifestPath), runPath = join(dirname(manifestPath), "a1-run.json");
    const identityDiagnostics = identity.diagnostics as Json, a1Diagnostics = manifest.attempt_diagnostics as Json;
    if (a1Diagnostics?.execution_complete !== true || identityDiagnostics?.execution_complete !== true
      || Number(a1Diagnostics.transport_attempts) + Number(identityDiagnostics.transport_attempts) !== budget.check().attempts.length) throw new Error("evaluation_attempt_observer_mismatch");
    const prepared = json(options.prepared!), plan = prepared.plan as Json;
    if (digest(JSON.stringify(manifest.config)) !== digest(JSON.stringify(plan.config))) throw new Error("evaluation_config_drift");
    const { certifyPrototypeSafetyRun } = await import(pathToFileURL(join(candidate, "evals/prototype-safety.ts")).href) as typeof import("./prototype-safety.js");
    budget.check();
    const safety = certifyPrototypeSafetyRun({ manifest, a1_run: json(runPath), manifest_sha256: digest(readFileSync(manifestPath)), a1_run_sha256: digest(readFileSync(runPath)) });
    const completed = budget.check();
    privateJson(join(root, "prototype-safety-receipt.json"), safety); budget.check();
    privateJson(join(root, "task-receipt.json"), { execution_complete: true, binding: frozen,
      attempts: completed.attempts.length, retries: completed.attempts.filter((entry) => entry.retry).length,
      deadline: completed.deadline, safety_sha256: digest(readFileSync(join(root, "prototype-safety-receipt.json"))),
      identity_sha256: digest(readFileSync(join(root, "identity-result.json"))), limitations: ["prototype safety scope only; formal baseline incomparable", "S2a old head and overall TD-20 remain unaccepted"] });
    budget.check(); completed.execution_complete = true; privateJson(join(root, "budget.json"), completed);
    // Final publication must remain inside the same deadline, including the final state write.
    if (Date.now() >= completed.deadline || existsSync(join(root, "STOP"))) throw new Error("evaluation_late_publication");
    return { root, mode: "completed_scoped_evaluation", attempts: completed.attempts.length };
  } catch (error) {
    failEvaluationOutputs(root, budget);
    throw error;
  } finally { lifetime.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = (key: string): string | undefined => args[args.indexOf(key) + 1];
  if (args.includes("--prepare") === args.includes("--execute") || !args.includes("--candidate") || !args.includes("--output") || !args.includes("--input")) {
    console.error("Use --prepare or separately authorized --execute, --candidate DIR --input FILE --output FRESH_PRIVATE_DIR [--prepared FILE]"); process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await runEvaluation({ candidate: value("--candidate")!, input: value("--input")!, output: value("--output")!, prepare: args.includes("--prepare"), prepared: args.includes("--prepared") ? value("--prepared") : undefined }))); }
    catch { console.error("D7 evaluation incomplete; inspect private task outputs. No pass receipt."); process.exitCode = 1; }
  }
}
