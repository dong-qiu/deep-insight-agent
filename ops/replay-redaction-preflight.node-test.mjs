import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildSync } from "esbuild";

test("real recovery bundle rejects incomplete recovery configuration without touching data", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "insight-replay-preflight-"));
  t.after(() => rmSync(root, { recursive: true }));
  const bundle = join(root, "replay.cjs");
  buildSync({ entryPoints: [resolve("ops/replay-redaction-registry.ts")], outfile: bundle,
    bundle: true, platform: "node", format: "cjs", external: ["better-sqlite3"], logLevel: "silent" });
  const restoreArgs = ["--restore-time", "2026-10-02T00:00:00.000Z"];
  const cases = [
    { name: "missing time", args: [], env: {}, reason: "usage:" },
    { name: "non-UTC time", args: ["--restore-time", "2026-10-02T00:00:00+08:00"], env: {}, reason: "usage:" },
    { name: "missing registry", args: restoreArgs, env: {}, reason: "missing_redaction_registry_bucket" },
    { name: "missing independent recovery role", args: restoreArgs, env: { REDACTION_REGISTRY_BUCKET: "synthetic-only" }, reason: "missing_redaction_recovery_role_arn" },
    { name: "missing HMAC mapping", args: restoreArgs, env: { REDACTION_REGISTRY_BUCKET: "synthetic-only", REDACTION_RECOVERY_ROLE_ARN: "synthetic-only" }, reason: "missing_redaction_hmac_secret_mapping" },
  ];
  for (const [index, scenario] of cases.entries()) await t.test(scenario.name, () => {
    const dir = join(root, `case-${index}`); mkdirSync(dir);
    const dbPath = join(dir, "insight.db");
    const report = join(dir, "synthetic-report.md"); writeFileSync(report, "Synthetic report, unchanged");
    const before = readFileSync(report);
    const result = spawnSync(process.execPath, [bundle, ...scenario.args], { encoding: "utf8", timeout: 10_000,
      cwd: dir, env: { NODE_PATH: resolve("node_modules"), DATA_DIR: dir, DB_PATH: dbPath,
        AWS_EC2_METADATA_DISABLED: "true", ...scenario.env } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(scenario.reason), result.stderr);
    assert.equal(result.stdout.includes("redaction_registry_replayed"), false);
    for (const suffix of ["", "-wal", "-shm"]) assert.equal(existsSync(dbPath + suffix), false);
    assert.deepEqual(readFileSync(report), before);
  });
});
