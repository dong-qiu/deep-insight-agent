/** Shared synthetic process fixture for lifecycle regressions and opt-in measurements. */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContentItem, Topic } from "../src/lib/types.js";

export interface C4bFixture {
  root: string;
  qualityFile: string;
  consistencyFile: string;
}
export function createC4bFixture(root: string, language: "en" | "zh" = "en"): C4bFixture {
  mkdirSync(root, { recursive: true });
  const qualityFile = join(root, "quality.jsonl");
  const consistencyFile = join(root, "consistency.jsonl");
  const cases = [0, 1].map((index) => {
    const topic: Topic = { id: `synthetic-${index}`, name: "Synthetic", keywords: [], language, brief_schedule: "daily", enabled: true };
    const item: ContentItem = { id: `synthetic-item-${index}`, source_id: "synthetic-source", url: "https://example.test/synthetic",
      title: "Synthetic", body: "Fact is supported.", body_kind: "article", raw_ref: "", content_hash: "synthetic",
      author: null, published_at: null, fetched_at: "2026-10-05T00:00:00.000Z", language: "en", topic_ids: [topic.id], tags: [], fetch_status: "ok" };
    return { topic, items: [item], time_window: { start: "2026-10-01", end: "2026-10-05" } };
  });
  writeFileSync(qualityFile, cases.map((value) => JSON.stringify(value)).join("\n") + "\n");
  writeFileSync(consistencyFile, JSON.stringify({ statement: "Synthetic fact.", source_text: "Synthetic fact.", expected_consistency: "support" }) + "\n");
  return { root, qualityFile, consistencyFile };
}

export interface C4bProcessResult {
  wall_ms: number;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  directory: string | null;
  manifest: Record<string, unknown>;
  stats: { requests: Array<{ role: string; operation: string; sha256: string }>; retries: number; source_reads: number; source_bytes: number };
}

export async function runC4bFixture(
  fixture: C4bFixture, label: string, mode: string,
  options: { resume?: string; provider?: "anthropic" | "volcengine-responses"; strategy?: "one" | "two"; formal?: boolean; cancel?: boolean; watchdogMs?: number; env?: Record<string, string> } = {},
): Promise<C4bProcessResult> {
  const runs = join(fixture.root, label); mkdirSync(runs, { recursive: true });
  const statsPath = join(runs, "synthetic-transport.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: "UTC", LANG: "C.UTF-8", NODE_ENV: "test",
    C4B_SYNTHETIC_PROVIDER: "1", C4B_MOCK_MODE: mode, C4B_STATS_PATH: statsPath, C4B_READ_STRATEGY: options.strategy ?? "one",
    LLM_PROVIDER: options.provider ?? "volcengine-responses", LLM_API_KEY: "sk-ant-api03-synthetic-only", ANTHROPIC_API_KEY: "sk-ant-api03-synthetic-only",
    LLM_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3", ANTHROPIC_BASE_URL: "https://example.test/synthetic",
    ANALYZER_MODEL: "synthetic-a", VALIDATOR_MODEL: "synthetic-v", COVERAGE_MODEL: "synthetic-c",
    VALIDATOR_THINKING: "0", COVERAGE_THINKING: "0", COVERAGE_MAX_TOKENS: "2048", VALIDATOR_BATCH: "0",
    LLM_MAX_RETRIES: "0", LLM_TRANSIENT_RETRIES: "1", LLM_TRANSIENT_RETRY_BACKOFF_MS: "0", VALIDATOR_RETRIES: "0", VALIDATOR_RETRY_BACKOFF_MS: "0",
    LLM_TIMEOUT_MS: "120000", A1_TOPIC_TIMEOUT_MS: "30000", A1_JUDGE_TIMEOUT_MS: "30000", A1_COVERAGE_TIMEOUT_MS: "30000",
    A1_INDEPENDENT_CALL_CONCURRENCY: "1", ANALYZE_BATCH_CHARS: "30000", ANALYZE_BODY_CHARS: "10000", SELECT_WINDOW_CHARS: "1000",
    PROMPT_CACHE: "0", COVERAGE_BACKFILL: "0", A1_FORCE_SMOKE: options.formal ? "0" : "1",
    A1_QUALITY_FILE: fixture.qualityFile, A1_CONSISTENCY_FILE: fixture.consistencyFile,
    A1_DISPLAY_COVERAGE_LIMIT: options.formal ? "0" : "1", A1_QUOTE_SELF_CONTAINED_LIMIT: options.formal ? "0" : "1",
    A1_RUNS_DIR: runs, ...(options.resume ? { A1_RESUME_FROM: options.resume } : {}), ...options.env,
  };
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./evals/fixtures/c4b-mock-provider.ts", "evals/run-a1.ts"], {
    cwd: resolve("."), env, stdio: "ignore",
  });
  const watchdog = setTimeout(() => child.kill("SIGTERM"), options.watchdogMs ?? 15000);
  let poll: ReturnType<typeof setInterval> | undefined;
  if (options.cancel) poll = setInterval(() => {
    if (existsSync(statsPath)) { clearInterval(poll); child.kill("SIGTERM"); }
  }, 10);
  const outcome = await new Promise<{ exit_code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (exit_code, signal) => resolveResult({ exit_code, signal }));
  }).finally(() => { clearTimeout(watchdog); if (poll) clearInterval(poll); });
  const wall_ms = performance.now() - started;
  const name = readdirSync(runs).find((value) => /^a1-/.test(value));
  const directory = name ? join(runs, name) : null;
  return { wall_ms, ...outcome, directory,
    manifest: directory ? JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) : {},
    stats: existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, "utf8")) : { requests: [], retries: 0, source_reads: 0, source_bytes: 0 },
  };
}
