import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const legacy = new URL("./deploy.sh", import.meta.url).pathname;

test("legacy deploy refuses every invocation before config or network access", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-legacy-deploy-"));
  try {
    const aws = join(root, "ops/aws");
    const bin = join(root, "bin");
    mkdirSync(aws, { recursive: true });
    mkdirSync(bin);
    cpSync(legacy, join(aws, "deploy.sh"));
    writeFileSync(join(root, ".env.local"), "PRODUCTION_SENTINEL=keep\n");
    writeFileSync(join(aws, "config.sh"), 'echo sourced > "' + join(root, "sourced") + '"\n');
    for (const name of ["ssh", "scp", "rsync", "docker"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho invoked >> '${join(root, "network-invoked")}'\n`, { mode: 0o755 });
    }
    for (const args of [[], ["--bootstrap"], ["--apply"]]) {
      const result = spawnSync("/bin/bash", [join(aws, "deploy.sh"), ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Deploy Production Image/);
    }
    assert.equal(readFileSync(join(root, ".env.local"), "utf8"), "PRODUCTION_SENTINEL=keep\n");
    assert.equal(existsSync(join(root, "sourced")), false);
    assert.equal(existsSync(join(root, "network-invoked")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
