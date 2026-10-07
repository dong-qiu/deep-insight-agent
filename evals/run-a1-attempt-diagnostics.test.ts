import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createC4bFixture, runC4bFixture, type C4bProcessResult } from "./c4b-runner-fixture.js";
import { sha256File } from "./a1-artifacts.js";
import type { A1DiagnosticsSnapshot } from "./a1-attempt-diagnostics.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(language: "en" | "zh" = "en") { const root = mkdtempSync(join(tmpdir(), "td14-")); roots.push(root); return createC4bFixture(root, language); }
const env = (max = 80, window = 10000) => ({ A1_DIAGNOSTIC_MAX_ATTEMPTS: String(max), A1_DIAGNOSTIC_WINDOW_MS: String(window) });
const diag = (r: C4bProcessResult) => r.manifest.attempt_diagnostics as A1DiagnosticsSnapshot;
const cp = (r: C4bProcessResult) => JSON.parse(readFileSync(join(r.directory!, "quality-checkpoint.json"), "utf8"));
function failed(r: C4bProcessResult, requests: number) {
  expect(r.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated", attempt_diagnostics: { execution_complete: false } });
  expect(r.exit_code).toBe(1);
  expect(r.stats.requests).toHaveLength(requests);
  expect(diag(r).transport_attempts).toBe(requests);
  expect(cp(r).cases.every((entry: { completed?: unknown }) => !entry.completed)).toBe(true);
}
it("zero cap blocks every actual entry before dispatch", async () => { const r = await runC4bFixture(fixture(), "zero", "supported", { env: env(0) }); failed(r, 0); }, 15000);
it.each([1, 2, 3])("cap %i fails closed through primary/countercheck/validator without reusable completion", async (max) => {
  const r = await runC4bFixture(fixture(), "cap", "supported", { env: env(max) }); failed(r, max);
  expect(diag(r).stop_reason).toBe("attempt_limit");
  expect(cp(r).cases[0]?.chunks.length ?? 0).toBe(max === 3 ? 1 : 0);
}, 15000);
it("real SDK internal retry shares logical identity and cannot bypass the cap", async () => {
  const f = fixture();
  const stopped = await runC4bFixture(f, "stopped", "sdk_retry", { provider: "anthropic", env: { ...env(1), LLM_MAX_RETRIES: "2", LLM_TRANSIENT_RETRIES: "0" } });
  failed(stopped, 1);
  const success = await runC4bFixture(f, "success", "sdk_retry", { provider: "anthropic", env: { ...env(), LLM_MAX_RETRIES: "2", LLM_TRANSIENT_RETRIES: "0" } });
  expect(success.exit_code).toBe(0);
  const attempts = diag(success).attempts;
  expect(attempts[0].logical_call_id).toBe(attempts[1].logical_call_id);
  expect(attempts.slice(0, 2).map((a) => [a.attempt_number, a.sdk_retry_number, a.usage_status])).toEqual([[1, 0, "unknown"], [2, 1, "reported"]]);
  expect(diag(success).transport_attempts).toBe(diag(success).logical_calls + 1);
}, 15000);
it("EOF recovery counts a fresh transport within one logical call", async () => {
  const f = fixture();
  const r = await runC4bFixture(f, "ok", "eof_retry", { env: env() });
  expect(r.exit_code).toBe(0);
  expect(diag(r).transport_attempts).toBe(diag(r).logical_calls + 1);
  expect(diag(r).attempts[0].logical_call_id).toBe(diag(r).attempts[1].logical_call_id);
  const stopped = await runC4bFixture(f, "cap", "eof_retry", { env: env(1) }); failed(stopped, 1);
}, 15000);
it("split children are new logical calls and cannot dispatch after the cap", async () => {
  const f = fixture();
  const rows = readFileSync(f.qualityFile, "utf8").trim().split("\n").map((row) => JSON.parse(row));
  rows[0].items.push({ ...rows[0].items[0], id: "extra-synthetic-item" });
  writeFileSync(f.qualityFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const r = await runC4bFixture(f, "split", "split_success", { env: env(2) }); failed(r, 2);
  expect(new Set(diag(r).attempts.map((a) => a.logical_call_id)).size).toBe(2);
  expect(cp(r).cases[0]?.chunks.length ?? 0).toBe(0);
}, 15000);
it("language repair is bounded and cannot complete a checkpoint after stop", async () => {
  const r = await runC4bFixture(fixture("zh"), "repair", "supported", { env: env(3) }); failed(r, 3);
  expect(diag(r).calls.some((c) => c.operation === "reader_language_repair")).toBe(true);
}, 15000);
it("deadline and actual SIGTERM publish failed frozen observations", async () => {
  const f = fixture();
  const r = await runC4bFixture(f, "deadline", "deadline", { env: env(80, 1000) }); failed(r, 1);
  expect(diag(r).stop_reason).toBe("deadline");
  const cancel = await runC4bFixture(f, "cancel", "cancel", { env: env(), cancel: true }); failed(cancel, 1);
  expect(diag(cancel).stop_reason).toBe("cancelled");
}, 15000);
it.each(["coverage_error", "invalid_analysis", "truncated_empty", "truncated_validator"])("incomplete %s stays failed on real SDK", async (mode) => {
  const r = await runC4bFixture(fixture(), "run", mode, { provider: "anthropic", env: env() });
  expect(r.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated", attempt_diagnostics: { execution_complete: false } });
  expect(cp(r).cases[0]?.completed).toBeUndefined();
}, 15000);
it("disabled path preserves requests; complete diagnostic publishes honest timing and raw samples", async () => {
  const f = fixture();
  const reference = await runC4bFixture(f, "reference", "supported");
  const r = await runC4bFixture(f, "diagnostic", "supported", { env: env() });
  expect(r.exit_code).toBe(0);
  expect(r.stats.requests).toEqual(reference.stats.requests);
  expect(reference.manifest.attempt_diagnostics).toBeUndefined();
  const d = diag(r);
  expect(d.execution_complete).toBe(true);
  expect(d.transport_attempts).toBe(r.stats.requests.length);
  expect(new Set(d.attempts.map((a) => a.attempt_id)).size).toBe(d.transport_attempts);
  expect(d.attempts.every((a) => a.usage_status === "reported" && a.estimate_usd === null)).toBe(true);
  const lifecycle = JSON.parse(readFileSync(join(r.directory!, "diagnostic-lifecycle.json"), "utf8"));
  expect(lifecycle.publication_wall_ms).toBeGreaterThan(0);
  expect(r.wall_ms).toBeGreaterThan(lifecycle.publication_wall_ms);
  expect(r.manifest).toMatchObject({ auto_gate: "smoke", baseline_comparison: "incomparable" });
  expect(JSON.parse(readFileSync(join(r.directory!, "progress.json"), "utf8")).attempt_diagnostics.execution_complete).toBe(true);
}, 15000);
it("different caps and diagnostic disabled reject explicit resume with zero requests, keeping source bytes", async () => {
  const f = fixture();
  const source = await runC4bFixture(f, "source", "fail_second", { env: env() });
  const hash = sha256File(join(source.directory!, "quality-checkpoint.json"));
  for (const [label, values] of [["changed", env(79)], ["disabled", {}]] as const) {
    const r = await runC4bFixture(f, label, "empty", { resume: source.directory!, env: values });
    expect(r.exit_code).toBe(1); expect(r.stats.requests).toHaveLength(0);
    expect(sha256File(join(source.directory!, "quality-checkpoint.json"))).toBe(hash);
  }
  const r = await runC4bFixture(f, "same", "empty", { resume: source.directory!, env: env() });
  expect(r.exit_code).toBe(0);
  expect(r.stats.requests.filter((v) => v.operation === "analysis")).toHaveLength(1);
  expect(sha256File(join(source.directory!, "quality-checkpoint.json"))).toBe(hash);
}, 15000);
it("prepare-only freezes the actual runner configuration/selected hashes without a single request", async () => {
  const r = await runC4bFixture(fixture(), "prepare", "supported", { env: { ...env(), A1_DIAGNOSTIC_PREPARE_ONLY: "1" } });
  expect(r.exit_code).toBe(0);
  expect(r.stats.requests).toHaveLength(0);
  expect(r.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated", attempt_diagnostics: { execution_complete: false } });
  const plan = JSON.parse(readFileSync(join(r.directory!, "diagnostic-plan.json"), "utf8"));
  expect(plan).toMatchObject({ mode: "prepare_only_no_model_calls", input: { counts: { quality: 2, consistency: 1, display: 1, quote: 1 } }, config: { analyzer_model: "synthetic-a" }, resume: false });
  expect(plan.input.selected_quality_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(r.manifest.artifacts).toMatchObject({ "diagnostic-plan.json": sha256File(join(r.directory!, "diagnostic-plan.json")) });
}, 15000);
