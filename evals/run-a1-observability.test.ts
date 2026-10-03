/** Runs the real A1 orchestration and artifact/checkpoint writers; only model boundaries are replaced. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AnalysisBatch, ContentItem, Topic } from "../src/lib/types.js";

const fixture = vi.hoisted(() => ({ mode: "success", judgeCalls: 0, exits: [] as number[], signals: {} as Record<string, () => void> }));
vi.mock("./load-env.js", () => ({}));
vi.mock("../src/lib/agents/analyzer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agents/analyzer.js")>();
  return {
    ...actual,
    analyze: vi.fn(async (topic: Topic, items: ContentItem[], timeWindow: AnalysisBatch["time_window"], _cost: unknown, options: Parameters<typeof actual.analyze>[4]) => {
      if (fixture.mode === "cancel") { fixture.signals.SIGTERM(); throw new Error("PRIVATE-SOURCE-TEXT sk-ant-api03-SENSITIVE"); }
      if (fixture.mode === "quality_failure") throw new Error("PRIVATE-SOURCE-TEXT sk-ant-api03-SENSITIVE");
      const chunks = actual.chunkByChars(items, actual.ANALYZE_BATCH_CHARS);
      for (const [index, chunk] of chunks.entries()) {
        options?.onChunkComplete?.({ chunk_index: index, chunk_total: chunks.length, input_sha256: actual.analyzeChunkInputSha256(topic, chunk, timeWindow, []), insights: [], coverage_decisions: [] });
      }
      return { id: "fixture-batch", topic_id: topic.id, time_window: timeWindow, status: "done", no_significant_event: true, insights: [] } satisfies AnalysisBatch;
    }),
    filterByQuoteCoverage: vi.fn(async () => {
      if (fixture.mode === "coverage_failure") throw new Error("PRIVATE-SOURCE-TEXT sk-ant-api03-SENSITIVE");
      return [];
    }),
    verifyQuoteSelfContained: vi.fn(async () => ({ supports: false, reason: "fixture_reject" })),
  };
});
vi.mock("../src/lib/agents/validator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agents/validator.js")>();
  return {
    ...actual,
    validateBatch: vi.fn(async () => ({ checks: [], report: {} })),
    judgeWithRetry: vi.fn(async (...args: unknown[]) => {
      fixture.judgeCalls++;
      expect(args[5]).toBeInstanceOf(AbortSignal);
      if (fixture.mode === "judge_failure") throw new Error("PRIVATE-SOURCE-TEXT sk-ant-api03-SENSITIVE");
      return { consistency: "support", rationale: "fixture" };
    }),
  };
});
// Credentials and provider requests are never needed. Stub the last boundary to catch accidental calls.
vi.mock("../src/lib/runtime/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/runtime/llm.js")>();
  return { ...actual, callStructured: vi.fn(() => { throw new Error("Unexpected real model call"); }) };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function run(mode: string) {
  vi.resetModules(); fixture.mode = mode; fixture.judgeCalls = 0; fixture.exits = []; fixture.signals = {};
  const root = mkdtempSync(join(tmpdir(), "c4a-run-")); roots.push(root);
  vi.stubEnv("A1_RUNS_DIR", root); vi.stubEnv("LLM_API_KEY", "sk-ant-api03-SENSITIVE"); vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("COVERAGE_MODEL", "fixture-coverage"); vi.stubEnv("LLM_BASE_URL", "https://private.example/secret");
  for (const key of ["A1_QUALITY_LIMIT", "A1_CONSISTENCY_LIMIT", "A1_DISPLAY_COVERAGE_LIMIT", "A1_QUOTE_SELF_CONTAINED_LIMIT"]) vi.stubEnv(key, "1");
  vi.stubEnv("A1_INDEPENDENT_CALL_CONCURRENCY", "2"); vi.stubEnv("A1_RESUME_FROM", undefined);
  if (mode === "setup_failure") vi.stubEnv("A1_TOPIC_TIMEOUT_MS", "PRIVATE-SOURCE-TEXT");
  const log: unknown[][] = [];
  for (const key of ["log", "warn", "error"] as const) vi.spyOn(console, key).mockImplementation((...args) => { log.push(args); });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const originalOnce = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
    if (event === "SIGINT" || event === "SIGTERM") { fixture.signals[event] = listener; return process; }
    return originalOnce(event, listener);
  }) as typeof process.once);
  vi.spyOn(process, "exit").mockImplementation(((code: number) => { fixture.exits.push(code); }) as typeof process.exit);
  await import("./run-a1.js");
  await vi.waitFor(() => expect(fixture.exits.length).toBeGreaterThan(0), { timeout: 10000 });
  const directory = readdirSync(root).find((name) => name.startsWith("a1-"))!;
  const manifest = JSON.parse(readFileSync(join(root, directory, "manifest.json"), "utf8"));
  const progress = JSON.parse(readFileSync(join(root, directory, "progress.json"), "utf8"));
  expect(JSON.stringify([manifest, progress, log])).not.toMatch(/PRIVATE-SOURCE-TEXT|sk-ant-api03-SENSITIVE|private.example/);
  return { manifest, progress, root, directory };
}

it("publishes completed orchestration separately from quality and baseline, without changing checkpoint identity", async () => {
  const { manifest, progress, root, directory } = await run("success");
  expect(manifest).toMatchObject({ status: "completed", auto_gate: "smoke", baseline_comparison: "incomparable", effective_config: { independent_call_concurrency: 2 }, timing: { phases: { setup: { state: "completed" }, quality: { state: "completed" }, consistency: { state: "completed" }, coverage_benchmark: { state: "completed" }, finalizing: { state: "completed" } } } });
  expect(progress.timing).toEqual(manifest.timing);
  expect(fixture.judgeCalls).toBe(1);
  const checkpoint = JSON.parse(readFileSync(join(root, directory, "quality-checkpoint.json"), "utf8"));
  const { a1QualityCheckpointConfigSha256 } = await import("./a1-quality-checkpoint.js");
  expect(checkpoint.eval_config_sha256).toBe(a1QualityCheckpointConfigSha256(manifest.config));
  expect(manifest.config).not.toHaveProperty("timing");
});
it.each(["quality_failure", "cancel"])("retains terminal timing on %s and leaves later stages unexecuted", async (mode) => {
  const { manifest, progress } = await run(mode);
  expect(manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated", timing: { phases: { setup: { state: "completed" }, quality: { state: "failed" }, consistency: { state: "not_run", wall_ms: null }, finalizing: { state: "not_run", wall_ms: null } } } });
  expect(progress.state).toBe("failed"); expect(fixture.judgeCalls).toBe(0);
});
it("retains setup failures without inventing configuration or later timing", async () => {
  const { manifest } = await run("setup_failure");
  expect(manifest.effective_config).toBeUndefined();
  expect(manifest.timing.phases).toMatchObject({ setup: { state: "failed" }, quality: { state: "not_run", wall_ms: null } });
});
it.each(["judge_failure", "coverage_failure"])("does not turn %s into a quality verdict", async (mode) => {
  const { manifest } = await run(mode);
  expect(manifest).toMatchObject({ status: "completed", auto_gate: "not_evaluated", baseline_comparison: "not_evaluated" });
  expect(manifest.timing.phases[mode === "judge_failure" ? "consistency" : "coverage_benchmark"].state).toBe("failed");
});
