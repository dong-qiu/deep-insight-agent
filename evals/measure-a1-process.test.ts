import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { measureA1Process } from "./measure-a1-process.js";
import { createC4bFixture } from "./c4b-runner-fixture.js";
import { A1AttemptDiagnostics } from "./a1-attempt-diagnostics.js";
import { beginA1Run, finalizeA1Run, finalizeFailedA1Run, writeA1RunProgress, type A1RunManifest } from "./a1-artifacts.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "td14-parent-")); roots.push(root);
  const f = createC4bFixture(root);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, C4B_SYNTHETIC_PROVIDER: "1", C4B_MOCK_MODE: "empty",
    ANALYZER_MODEL: "synthetic-a", VALIDATOR_MODEL: "synthetic-v", COVERAGE_MODEL: "synthetic-c", LLM_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-synthetic", ANTHROPIC_BASE_URL: "https://example.test", VALIDATOR_THINKING: "0", COVERAGE_THINKING: "0",
    A1_QUALITY_FILE: f.qualityFile, A1_CONSISTENCY_FILE: f.consistencyFile, A1_DISPLAY_COVERAGE_LIMIT: "1", A1_QUOTE_SELF_CONTAINED_LIMIT: "1" };
  return { root, env };
}
it("records actual outer/IPC publication boundaries using a credential-free real child runner", async () => {
  const f = fixture();
  const r = await measureA1Process({ outputRoot: f.root, limits: { max_attempts: 80, window_ms: 10000 }, prepare: false, env: f.env, preloads: ["./evals/fixtures/c4b-mock-provider.ts"] });
  expect(r.sample).toMatchObject({ exit_code: 0, diagnostic_execution_complete: true, auto_gate: "smoke", baseline_comparison: "incomparable" });
  expect(r.sample.process_wall_ms).toBeGreaterThan(r.sample.main_wall_ms!);
  expect(r.sample.publication_wall_ms).toBeGreaterThan(0);
  expect(existsSync(join(r.root, "process-observation.json"))).toBe(true);
}, 15000);
it("parent total window includes cold module loading and terminalizes without new attempts", async () => {
  const f = fixture();
  const r = await measureA1Process({ outputRoot: f.root, limits: { max_attempts: 0, window_ms: 1 }, prepare: false, env: f.env, preloads: ["./evals/fixtures/c4b-mock-provider.ts"] });
  expect(r.sample).toMatchObject({ window_exceeded: true, diagnostic_execution_complete: false, publication_wall_ms: null });
  expect(r.sample.exit_code).not.toBe(0);
}, 15000);
it("cold-only refuses a resume value reintroduced after parent cleared inherited env", async () => {
  const f = fixture();
  const preload = join(f.root, "load-synthetic-resume.mjs");
  writeFileSync(preload, 'process.env.A1_RESUME_FROM ||= "synthetic-resume-from-config";');
  const r = await measureA1Process({ outputRoot: f.root, limits: { max_attempts: 80, window_ms: 10000 }, prepare: true, env: f.env, preloads: ["./evals/fixtures/c4b-mock-provider.ts", preload] });
  expect(r.sample).toMatchObject({ exit_code: 1, auto_gate: "not_evaluated", diagnostic_execution_complete: false });
  const directory = readdirSync(r.root).find((name) => name.startsWith("a1-"))!;
  const manifest = JSON.parse(readFileSync(join(r.root, directory, "manifest.json"), "utf8"));
  expect(manifest.attempt_diagnostics.transport_attempts).toBe(0);
}, 15000);
it("publication failure after rename downgrades sealed completion without recreating temp or publishing latest", () => {
  const f = fixture(); const workspace = beginA1Run(f.root);
  const d = new A1AttemptDiagnostics({ max_attempts: 0, window_ms: 10000 }); d.finish(true);
  const manifest: A1RunManifest = { run_id: workspace.runId, status: "completed", auto_gate: "smoke", manual_review: "pending", dcp_eligibility: "ineligible",
    started_at: workspace.startedAt, ended_at: new Date().toISOString(), config: {}, dataset: {}, source: { commit: null, dirty_fingerprint: null }, insights: { count: 0, ids_sha256: "" }, artifacts: {}, attempt_diagnostics: d.snapshot() };
  let count = 0;
  expect(() => finalizeA1Run(workspace, manifest, () => { if (++count === 3) { d.incomplete(); d.checkPublication(); } })).toThrow("a1_diagnostic_incomplete");
  d.finish(false);
  writeA1RunProgress({ ...workspace, tempDir: workspace.finalDir }, { state: "failed", phase: "finalizing", attempt_diagnostics: d.snapshot() });
  finalizeFailedA1Run(workspace, { ...manifest, status: "failed", auto_gate: "not_evaluated", attempt_diagnostics: d.snapshot() });
  expect(existsSync(workspace.tempDir)).toBe(false);
  expect(existsSync(join(f.root, "latest-complete.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(workspace.finalDir, "manifest.json"), "utf8"))).toMatchObject({ status: "failed", attempt_diagnostics: { execution_complete: false } });
  d.finish(true); expect(d.snapshot().execution_complete).toBe(false);
});
