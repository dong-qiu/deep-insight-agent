/** Run the real A1 path on the curated safety subset, then emit an aggregate-only receipt. */
import "./load-env.js";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyA1PrototypeSafetyConfig } from "./a1-prototype-safety-config.js";
import { certifyPrototypeSafetyRun, writePrototypeSafetyReceipt } from "./prototype-safety.js";
import { sha256File } from "./a1-artifacts.js";

function main(): void {
  applyA1PrototypeSafetyConfig();
  const runsRoot = process.env.PROTOTYPE_SAFETY_RUNS_DIR?.trim() || "evals/out/prototype-safety";
  const child = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "evals/run-a1.ts"], {
    cwd: process.cwd(), stdio: "inherit", env: { ...process.env, A1_RUNS_DIR: runsRoot },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`prototype safety A1 失败（exit=${child.status ?? "unknown"}）`);

  const pointerPath = join(runsRoot, "latest-complete.json");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { manifest?: unknown };
  const manifestPath = resolve(text(pointer.manifest, "latest-complete.manifest"));
  const a1RunPath = join(dirname(manifestPath), "a1-run.json");
  const receipt = certifyPrototypeSafetyRun({
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    a1_run: JSON.parse(readFileSync(a1RunPath, "utf8")),
    manifest_sha256: sha256File(manifestPath),
    a1_run_sha256: sha256File(a1RunPath),
  });
  const output = process.env.PROTOTYPE_SAFETY_RECEIPT_PATH?.trim()
    || join(dirname(runsRoot), "prototype-safety-receipts", `${receipt.run_id}.json`);
  writePrototypeSafetyReceipt(output, receipt);
  console.log(`✅ prototype safety eval 通过：${output}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

try {
  main();
} catch (error) {
  console.error(`❌ prototype safety eval 未通过：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
