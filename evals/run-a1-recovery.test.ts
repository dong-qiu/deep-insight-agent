import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createC4bFixture, runC4bFixture } from "./c4b-runner-fixture.js";
import { sha256File } from "./a1-artifacts.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(language: "en" | "zh" = "en") {
  const root = mkdtempSync(join(tmpdir(), "c4b-runner-")); roots.push(root);
  return createC4bFixture(root, language);
}
function checkpoint(directory: string) { return JSON.parse(readFileSync(join(directory, "quality-checkpoint.json"), "utf8")); }

it("runs a real cold process and resumes complete topics without rerunning them or skipping later benchmarks", async () => {
  const f = fixture();
  const failed = await runC4bFixture(f, "failed", "fail_second");
  expect(failed.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  expect(failed.exit_code).toBe(1);
  expect(checkpoint(failed.directory!).cases[0].completed).toBeDefined();
  const hash = sha256File(join(failed.directory!, "quality-checkpoint.json"));
  for (const label of ["resumed", "resumed-again"]) {
    const resumed = await runC4bFixture(f, label, "empty", { resume: failed.directory! });
    expect(resumed.manifest).toMatchObject({ status: "completed", auto_gate: "smoke", baseline_comparison: "incomparable", resumed_from_checkpoint_sha256: hash });
    expect(resumed.exit_code).toBe(0);
    expect(resumed.stats.requests.filter((entry) => entry.operation === "analysis")).toHaveLength(1);
    expect(resumed.stats.requests.filter((entry) => entry.operation === "judge")).toHaveLength(1);
    expect(resumed.stats.requests.some((entry) => entry.role === "coverage")).toBe(true);
    expect(resumed.stats.source_reads).toBe(1);
    expect(sha256File(join(failed.directory!, "quality-checkpoint.json"))).toBe(hash);
  }
}, 15000);

it("fails a reachable validator error, preserves only analyzer chunks, then revalidates on explicit resume", async () => {
  const f = fixture();
  const failed = await runC4bFixture(f, "failed", "validator_error");
  expect(failed.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  expect(failed.stats.requests.filter((entry) => entry.operation === "judge")).toHaveLength(1);
  expect(checkpoint(failed.directory!).cases[0]).toMatchObject({ chunks: [{ execution_complete: true }] });
  expect(checkpoint(failed.directory!).cases[0].completed).toBeUndefined();
  const resumed = await runC4bFixture(f, "resumed", "supported", { resume: failed.directory! });
  expect(resumed.exit_code).toBe(0);
  // Only second topic is generated; first topic still receives its missing citation judge.
  expect(resumed.stats.requests.filter((entry) => entry.operation === "analysis")).toHaveLength(1);
  expect(resumed.stats.requests.filter((entry) => entry.operation === "judge")).toHaveLength(3);
}, 15000);

it.each(["uncertain", "not_support"])("preserves complete semantic %s judgments without granting publication pass", async (mode) => {
  const result = await runC4bFixture(fixture(), "run", mode);
  expect(result.exit_code).toBe(0);
  const cp = checkpoint(result.directory!);
  expect(cp.cases[0].completed.validation.checks[0].consistency).toBe(mode);
  expect(cp.cases[0].completed.validation.checks[0].verdict).not.toBe("pass");
  expect(JSON.parse(readFileSync(join(result.directory!, "review-queue.json"), "utf8")).insights).toEqual([]);
}, 15000);

it.each(["invalid_analysis", "coverage_error", "invalid_coverage", "translation_error", "translation_invalid"])("refuses incomplete audited work on real transport (%s)", async (mode) => {
  const f = fixture(mode.startsWith("translation") ? "zh" : "en");
  const result = await runC4bFixture(f, "run", mode);
  expect(result.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  expect(result.exit_code).toBe(1);
  expect(checkpoint(result.directory!).cases.every((entry: { chunks: unknown[] }) => !entry.chunks.length)).toBe(true);
}, 15000);

it.each(["truncated_empty", "truncated_validator"])("rejects schema-valid Anthropic max_tokens through the real SDK (%s)", async (mode) => {
  const result = await runC4bFixture(fixture(), "run", mode, { provider: "anthropic" });
  expect(result.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  expect(result.exit_code).toBe(1);
  const cp = checkpoint(result.directory!);
  expect(cp.cases[0]?.completed).toBeUndefined();
  expect(cp.cases[0]?.chunks.length ?? 0).toBe(mode === "truncated_empty" ? 0 : 1);
}, 15000);

it("allows a successful EOF recovery, recording actual requests separately from logical calls", async () => {
  const result = await runC4bFixture(fixture(), "run", "eof_retry");
  expect(result.exit_code).toBe(0);
  expect(result.stats.retries).toBe(1);
  expect(result.stats.requests.filter((entry) => entry.operation === "analysis")).toHaveLength(3);
  expect(result.manifest.llm_role_telemetry).toMatchObject({ analyzer: { calls: 2, requests: 3, failures: 0 } });
}, 15000);

it("allows complete child generations after a recoverable parent schema failure", async () => {
  const f = fixture();
  const cases = readFileSync(f.qualityFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  cases[0].items.push({ ...cases[0].items[0], id: "synthetic-extra-item" });
  writeFileSync(f.qualityFile, cases.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const result = await runC4bFixture(f, "run", "split_success");
  expect(result.exit_code).toBe(0);
  expect(result.manifest.llm_role_telemetry).toMatchObject({ analyzer: { failures: 1, calls: 4 } });
  expect(checkpoint(result.directory!).cases[0].completed.execution_complete).toBe(true);
}, 15000);

it("keeps a real topic deadline failed and non-reusable", async () => {
  // Exercise the production minimum rather than bypassing timeout validation with a fake clock.
  const result = await runC4bFixture(fixture(), "run", "deadline", { watchdogMs: 35000 });
  expect(result.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  expect(result.exit_code).toBe(1);
  expect(result.stats.requests).toHaveLength(1);
  expect(checkpoint(result.directory!).cases.every((entry: { completed?: unknown }) => !entry.completed)).toBe(true);
}, 40000);

it("records real SIGTERM cancellation without reviving a workspace or granting completion", async () => {
  const result = await runC4bFixture(fixture(), "run", "cancel", { cancel: true });
  expect(result.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  expect(result.exit_code).toBe(1);
  expect(result.stats.requests).toHaveLength(1);
  expect(result.manifest.timing).toMatchObject({ phases: { consistency: { state: "not_run" } } });
}, 15000);

it("rejects a changed runtime identity before issuing a model request and leaves prior bytes intact", async () => {
  const f = fixture(); const failed = await runC4bFixture(f, "failed", "fail_second");
  const path = join(failed.directory!, "quality-checkpoint.json"); const bytes = readFileSync(path);
  const result = await runC4bFixture(f, "changed", "empty", { resume: failed.directory!, env: { PROMPT_CACHE: "1" } });
  expect(result.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  expect(result.stats.requests).toHaveLength(0);
  expect(readFileSync(path)).toEqual(bytes);
  // A truncated JSON file cannot become usable by changing only its manifest hash.
  writeFileSync(path, "{\"partial\":");
  const manifestPath = join(failed.directory!, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.artifacts["quality-checkpoint.json"] = sha256File(path);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const corrupt = await runC4bFixture(f, "corrupt", "empty", { resume: failed.directory! });
  expect(corrupt.exit_code).toBe(1); expect(corrupt.stats.requests).toHaveLength(0);
}, 15000);

it("permits a cold run with unavailable Git while refusing any reuse of its unknown source identity", async () => {
  const f = fixture();
  const unknown = await runC4bFixture(f, "unknown", "fail_second", { env: { PATH: "/nonexistent" } });
  expect(unknown.manifest.source).toMatchObject({ identity_complete: false });
  expect(unknown.stats.requests.filter((entry) => entry.operation === "analysis")).toHaveLength(2);
  expect(checkpoint(unknown.directory!).recovery_identity_sha256).toBeNull();
  const retry = await runC4bFixture(f, "refused", "empty", { resume: unknown.directory!, env: { PATH: "/nonexistent" } });
  expect(retry.exit_code).toBe(1); expect(retry.stats.requests).toHaveLength(0);
}, 15000);

it("keeps formal quality failure and incomparable baseline separate from successful orchestration", async () => {
  const result = await runC4bFixture(fixture(), "formal", "empty", { formal: true });
  expect(result.manifest).toMatchObject({ status: "completed", auto_gate: "fail", baseline_comparison: "incomparable" });
  expect(result.exit_code).toBe(1);
}, 15000);
