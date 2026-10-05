import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createC4bFixture, runC4bFixture, type C4bProcessResult } from "./c4b-runner-fixture.js";
import { loadVerifiedA1QualityCheckpoint } from "./fixtures/c4b-two-read-checkpoint.js";
import { loadVerifiedA1QualityCheckpoint as singleRead } from "./a1-quality-checkpoint.js";
import { sha256File } from "./a1-artifacts.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function normalized(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return value.replace(/a1-\d{14}-[a-f0-9]{8}/g, "RUN_ID")
    .replace(/batch_[a-f0-9]{8}|ins_[a-f0-9]{8}-[a-f0-9]{3}/g, (id) => {
      if (!ids.has(id)) ids.set(id, `${id.startsWith("batch_") ? "batch" : "candidate"}_${ids.size}`);
      return ids.get(id)!;
    });
  if (Array.isArray(value)) return value.map((item) => normalized(item, ids));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ![
    "generated_at", "created_at", "checked_at", "started_at", "ended_at", "updated_at", "sampled_at", "timing", "latency_ms", "artifacts",
  ].includes(key)).map(([key, item]) => [key, normalized(item, ids)]));
}

function verifyAndCompare(a: C4bProcessResult, b: C4bProcessResult) {
  expect(a.exit_code).toBe(0); expect(b.exit_code).toBe(0);
  expect(a.stats.requests).toEqual(b.stats.requests);
  for (const run of [a, b]) for (const [file, hash] of Object.entries(run.manifest.artifacts as Record<string, string>)) {
    expect(sha256File(join(run.directory!, file))).toBe(hash);
  }
  const maps = [new Map<string, string>(), new Map<string, string>()];
  const manifests: Record<string, unknown>[] = [];
  // Seed a bijection from the ordered checkpoint, preserving every ID reference across files.
  for (const [index, run] of [a, b].entries()) normalized(JSON.parse(readFileSync(join(run.directory!, "quality-checkpoint.json"), "utf8")), maps[index]!);
  const digest = (ids: string[]) => createHash("sha256").update(ids.sort().join("\n")).digest("hex");
  for (const [index, run] of [a, b].entries()) {
    const queue = JSON.parse(readFileSync(join(run.directory!, "review-queue.json"), "utf8"));
    const ids = queue.insights.map((insight: { id: string }) => insight.id);
    expect(run.manifest.insights).toEqual({ count: ids.length, ids_sha256: digest([...ids]) });
    // Verify the raw derived digest first, then recompute it from the same bijective ID mapping.
    manifests.push({ ...run.manifest, insights: { count: ids.length, ids_sha256: digest(ids.map((id: string) => normalized(id, maps[index]!) as string)) } });
  }
  for (const file of ["manifest.json", "progress.json", "quality-checkpoint.json", "a1-run.json", "review-queue.json"]) {
    const parse = (run: C4bProcessResult, index: number) => normalized(file === "manifest.json" ? manifests[index]
      : JSON.parse(readFileSync(join(run.directory!, file), "utf8")), maps[index]!);
    expect(parse(a, 0)).toEqual(parse(b, 1));
  }
  const csv = (run: C4bProcessResult, index: number) => {
    const queue = JSON.parse(readFileSync(join(run.directory!, "review-queue.json"), "utf8"));
    return normalized(readFileSync(join(run.directory!, "review.csv"), "utf8")
      .replaceAll(`"${queue.generated_at}"`, '"QUEUE_GENERATED_AT"'), maps[index]!);
  };
  expect(csv(a, 0)).toBe(csv(b, 1));
}

it("preserves nonempty completed analysis, citation judgments and publication artifacts across both read strategies", async () => {
  const root = mkdtempSync(join(tmpdir(), "c4b-nonempty-")); roots.push(root);
  const f = createC4bFixture(root);
  const source = await runC4bFixture(f, "source", "fail_second_nonempty");
  expect(source.manifest.status).toBe("failed");
  const before = JSON.parse(readFileSync(join(source.directory!, "quality-checkpoint.json"), "utf8"));
  expect(before.cases[0].completed.validation.checks[0]).toMatchObject({ consistency: "support", verdict: "pass" });
  const two = await runC4bFixture(f, "two", "supported", { strategy: "two", resume: source.directory! });
  const one = await runC4bFixture(f, "one", "supported", { strategy: "one", resume: source.directory! });
  verifyAndCompare(two, one);
  expect(one.stats.source_reads).toBe(1); expect(two.stats.source_reads).toBe(2);
  expect(one.stats.requests.filter((request) => request.operation === "analysis")).toHaveLength(1);
  expect(one.stats.requests.filter((request) => request.operation === "judge")).toHaveLength(2);
  const after = JSON.parse(readFileSync(join(one.directory!, "quality-checkpoint.json"), "utf8"));
  expect(after.cases[0].completed).toEqual(before.cases[0].completed);
}, 15000);

it("compares safe two-read and production single-read through the same frozen real runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "c4b-measure-")); roots.push(root);
  const f = createC4bFixture(root);
  const source = await runC4bFixture(f, "source", "fail_second");
  expect(source.manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
  const originalHash = sha256File(join(source.directory!, "quality-checkpoint.json"));
  const n = process.env.C4B_MEASURE === "1" ? 8 : 1;
  const observations: unknown[] = [];
  for (const mode of ["cold", "resume"] as const) {
    for (let index = 0; index < n; index++) {
      const results = {} as Record<"one" | "two", C4bProcessResult>;
      for (const strategy of index % 2 ? ["one", "two"] as const : ["two", "one"] as const) {
        const run = await runC4bFixture(f, `${mode}-${strategy}-${index}`, "empty", { strategy, ...(mode === "resume" ? { resume: source.directory! } : {}) });
        results[strategy] = run;
        observations.push({ mode, strategy, index, wall_ms: run.wall_ms, exit_code: run.exit_code, signal: run.signal,
          source_reads: run.stats.source_reads, source_bytes: run.stats.source_bytes, request_count: run.stats.requests.length,
          retries: run.stats.retries, status: run.manifest.status, auto_gate: run.manifest.auto_gate,
          timing: run.manifest.timing, role_telemetry: run.manifest.llm_role_telemetry });
      }
      verifyAndCompare(results.one, results.two);
      expect(results.one.stats.source_reads).toBe(mode === "resume" ? 1 : 0);
      expect(results.two.stats.source_reads).toBe(mode === "resume" ? 2 : 0);
      expect(results.one.stats.source_bytes * 2).toBe(results.two.stats.source_bytes);
      expect(sha256File(join(source.directory!, "quality-checkpoint.json"))).toBe(originalHash);
    }
  }

  if (process.env.C4B_MEASURE === "1") {
    const cp = JSON.parse(readFileSync(join(source.directory!, "quality-checkpoint.json"), "utf8"));
    const plan = cp.cases.map((entry: { case_index: number; topic_id: string; stratum: string; chunks: Array<{ input_sha256: string }> }) => ({
      case_index: entry.case_index, topic_id: entry.topic_id, stratum: entry.stratum, chunk_input_sha256: entry.chunks.map((chunk) => chunk.input_sha256),
    }));
    const micro = join(root, "micro"); mkdirSync(micro);
    const path = join(micro, "quality-checkpoint.json"); const manifest = join(micro, "manifest.json");
    writeFileSync(path, JSON.stringify({ ...cp, synthetic_padding: "s".repeat(1024 * 1024) }));
    const paddedHash = sha256File(path);
    writeFileSync(manifest, JSON.stringify({ status: "failed", artifacts: { "quality-checkpoint.json": paddedHash } }));
    const microObservations = [];
    for (let index = 0; index < 32; index++) {
      for (const strategy of index % 2 ? ["one", "two"] as const : ["two", "one"] as const) {
        const started = performance.now();
        const loaded = (strategy === "one" ? singleRead : loadVerifiedA1QualityCheckpoint)(manifest, path, cp, plan);
        const wall_ms = performance.now() - started;
        expect(loaded.checkpoint_sha256).toBe(paddedHash);
        if (index > 1) microObservations.push({ strategy, index, wall_ms });
      }
    }
    const output = "evals/out/c4b-recovery-measurement.json";
    mkdirSync("evals/out", { recursive: true });
    writeFileSync(output, JSON.stringify({ schema: "c4b-synthetic-measurement-v1", node: process.version, n, synthetic: true, paid_requests: 0,
      source: source.manifest.source, config: source.manifest.config, effective_config: source.manifest.effective_config,
      input_sha256: createHash("sha256").update(readFileSync(f.qualityFile)).digest("hex"), original_checkpoint_sha256: originalHash,
      cache_condition: "new process per sample; OS file cache not flushed; strategies interleaved",
      normalizations: "run/batch IDs, observation timestamps, timing/latency; artifact hashes verified separately",
      observations, micro: { bytes: readFileSync(path).length, input_sha256: paddedHash, observations: microObservations },
    }, null, 2) + "\n");
  }
}, 60000);
