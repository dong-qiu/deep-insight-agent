import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createC4bFixture } from "./c4b-runner-fixture.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function run(entry: string, max: number) {
  const root = mkdtempSync(join(tmpdir(), "td14-entrance-")); roots.push(root);
  const fixture = createC4bFixture(root);
  const output = join(root, "observer.json");
  const child = spawnSync(process.execPath, ["--import", "tsx", "--import", "./evals/fixtures/c4b-mock-provider.ts", "evals/fixtures/td14-call-entrances.ts", entry], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, C4B_SYNTHETIC_PROVIDER: "1", C4B_MOCK_MODE: entry === "validator_retry" ? "validator_error" : "supported",
      LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-synthetic", ANTHROPIC_BASE_URL: "https://example.test",
      ANALYZER_MODEL: "synthetic-a", VALIDATOR_MODEL: "synthetic-v", COVERAGE_MODEL: "synthetic-c", VALIDATOR_THINKING: "0",
      LLM_MAX_RETRIES: "0", LLM_TRANSIENT_RETRIES: "0", VALIDATOR_RETRIES: "2", VALIDATOR_RETRY_BACKOFF_MS: "0", COVERAGE_BACKFILL: "1",
      A1_QUALITY_FILE: fixture.qualityFile, TD14_ENTRANCE_OUT: output, A1_DIAGNOSTIC_MAX_ATTEMPTS: String(max), A1_DIAGNOSTIC_WINDOW_MS: "10000" },
    timeout: 15000, encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(readFileSync(output, "utf8"));
}
it("exported backfill also crosses the hard gate although P0 A1 deliberately never calls it", () => {
  const success = run("backfill", 1);
  expect(success).toMatchObject({ execution_complete: true, transport_attempts: 1 });
  expect(success.attempts[0].operation).toBe("citation_repair_candidates");
  const stopped = run("backfill", 0);
  expect(stopped).toMatchObject({ execution_complete: false, transport_attempts: 0, stop_reason: "attempt_limit" });
  expect(stopped.calls[0].operation).toBe("citation_repair_candidates");
}, 15000);
it("validator outer retry creates logical calls but cannot exceed actual attempt cap", () => {
  const r = run("validator_retry", 1);
  expect(r).toMatchObject({ execution_complete: false, transport_attempts: 1, stop_reason: "attempt_limit", logical_calls: 2 });
  expect(r.attempts[0].operation).toBe("citation_consistency_single");
}, 15000);
