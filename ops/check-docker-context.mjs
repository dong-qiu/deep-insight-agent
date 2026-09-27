/** Real Docker ignore/COPY test with synthetic data ONLY; never build the live workspace here. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "insight-docker-context-"));
const context = join(root, "context"), output = join(root, "output");
const required = ["package.json", "package-lock.json", "tsconfig.json", "next.config.mjs", "postcss.config.mjs",
  "src/app/page.tsx", "src/lib/config/defaults.yaml", "public/logo.svg", "vendor/image-size/package.json",
  "ops/run-provenance-migrations.ts", "ops/record-deployment.ts", "ops/replay-redaction-registry.ts",
  "ops/crontab", "ops/trigger.mjs", "ops/backup-db.mjs", "ops/cost-backfill.mjs", "ops/probe-alert.mjs",
  "ops/generation-dispatch-worker.mjs", "ops/generation-dispatch-healthcheck.mjs",
  "ops/regenerate-reports-cites.mjs", "ops/backfill-highlights.mjs", "ops/backfill-report-chain.mjs"];
const excluded = [".env", ".env.local", ".env.local.bak", ".npmrc", ".aws/credentials", ".ssh/id_rsa",
  ".codex/config.toml", ".claude/settings.json", ".data/insight.db", "deep-insight-cli_accessKeys.csv",
  "arbitrary-local-notes.json", "ops/aws/config.sh", "ops/aws/key.pem", "ops/local-accessKeys.csv",
  "src/.env.local", "src/nested/.aws/credentials", "src/nested/private.key", "src/backup.sqlite-wal",
  "src/backup.db-shm", "src/private-credentials.json", "src/local.log", "src/example.test.ts",
  "public/accessKeys.csv", "public/private.pem", "vendor/image-size/.npmrc", "vendor/image-size/node_modules/x.js",
  "node_modules/example/index.js", "docs/private.md", "evals/private.jsonl", "tests/private.json"];
try {
  mkdirSync(context);
  copyFileSync(join(repo, ".dockerignore"), join(context, ".dockerignore"));
  for (const file of [...required, ...excluded]) {
    const path = join(context, file); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, excluded.includes(file) ? "synthetic-private-sentinel" : "synthetic-build-input");
  }
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\nCOPY . /context/\n");
  execFileSync("docker", ["buildx", "build", "--network=none", "--no-cache", "--output", `type=local,dest=${output}`, context], { stdio: "pipe" });
  for (const file of excluded) assert(!existsSync(join(output, "context", file)), `excluded fixture entered context: ${file}`);
  for (const file of required) assert.equal(readFileSync(join(output, "context", file), "utf8"), "synthetic-build-input", `missing build input: ${file}`);
  console.log(JSON.stringify({ check: "real_docker_context", required: required.length, excluded: excluded.length, passed: true }));
} finally {
  // Only our validated mkdtemp root, never a worktree or a real credential directory.
  rmSync(root, { recursive: true, force: true });
}
