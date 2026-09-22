import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("../..", import.meta.url).pathname;
const script = join(repoRoot, "ops/aws/gen-env.sh");

test("gen-env writes all independent model and thinking settings into a fresh runtime env", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-gen-env-"));
  try {
    const aws = join(root, "ops/aws");
    cpSync(script, join(aws, "gen-env.sh"), { recursive: false });
    writeFileSync(join(aws, "config.sh"), [
      'COMPOSE_PROJECT="test-insight"',
      'LLM_PROVIDER="volcengine-responses"',
      'LLM_BASE_URL="https://ark.cn-beijing.volces.com/api/coding/v3"',
      'ANALYZER_MODEL="deepseek-v4-flash"',
      'VALIDATOR_MODEL="deepseek-v4-pro"',
      'COVERAGE_MODEL="glm-5.2"',
      'VALIDATOR_THINKING="0"',
      'COVERAGE_THINKING="0"',
      'ADMIN_EMAIL="admin"',
    ].join("\n"));

    execFileSync("bash", [join(aws, "gen-env.sh")], {
      env: { ...process.env, LLM_API_KEY: "test-only-key", ADMIN_PASSWORD: "test-only-password" },
      stdio: "pipe",
    });
    const runtimeEnv = readFileSync(join(root, ".env.local"), "utf8");
    for (const line of [
      "LLM_PROVIDER=volcengine-responses",
      "ANALYZER_MODEL=deepseek-v4-flash",
      "VALIDATOR_MODEL=deepseek-v4-pro",
      "COVERAGE_MODEL=glm-5.2",
      "VALIDATOR_THINKING=0",
      "COVERAGE_THINKING=0",
    ]) assert.match(runtimeEnv, new RegExp(`^${line}$`, "m"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gen-env rejects duplicate models before writing runtime configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-gen-env-"));
  try {
    const aws = join(root, "ops/aws");
    cpSync(script, join(aws, "gen-env.sh"), { recursive: false });
    writeFileSync(join(aws, "config.sh"), [
      'COMPOSE_PROJECT="test-insight"',
      'ANALYZER_MODEL="same"',
      'VALIDATOR_MODEL="same"',
      'COVERAGE_MODEL="other"',
      'ADMIN_EMAIL="admin"',
    ].join("\n"));
    const result = spawnSync("bash", [join(aws, "gen-env.sh")], {
      env: { ...process.env, LLM_API_KEY: "test-only-key", ADMIN_PASSWORD: "test-only-password" },
      stdio: "pipe",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout.toString("utf8"), /必须两两不同/);
    assert.throws(() => readFileSync(join(root, ".env.local"), "utf8"), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
