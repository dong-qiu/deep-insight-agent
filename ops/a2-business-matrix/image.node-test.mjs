import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runMatrix } from "./run.mjs";

// CI cannot skip. Manual Linux runners may opt in; local absence is always explicit and never a success receipt.
const enabled = process.env.GITHUB_ACTIONS === "true" || process.env.A2_BUSINESS_IMAGE_TEST === "1";
test("frozen447 exact manifest: isolated HTTP/auth/reader and real business writer matrix", {
  skip: !enabled ? "Local Docker matrix not executed; final acceptance requires real frozen-manifest Linux CI" : false,
  timeout: 900_000,
}, async () => {
  assert.equal(process.platform, "linux", "image matrix requires Linux Docker, never silently skips in CI");
  execFileSync("docker", ["--host", "unix:///var/run/docker.sock", "version"], { env: { PATH: process.env.PATH }, stdio: "pipe" });
  const evidence = await runMatrix();
  assert.equal(evidence.result, "pass"); assert.equal(evidence.stages.length, 3); assert.equal(evidence.failures.length, 3);
  // Existing application logs are the raw CI artifact; this dedicated JSON is emitted only after all assertions pass and precise cleanup completes.
  console.log(`A2_BUSINESS_MATRIX_JSON=${JSON.stringify(evidence)}`);
});
