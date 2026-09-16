import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function run(...args: string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "evals/prepare-a1-v2-prototype-owner-decision.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8",
  });
}

function fixture(root: string) {
  const manifest = join(root, "source-manifest.json");
  writeFileSync(manifest, JSON.stringify({ snapshot_id: "a1-v2-example", source_counts: { src_one: 10, src_two: 10 } }));
  return manifest;
}

const futureRetention = () => new Date(Date.now() + 86_400_000).toISOString();

describe("prototype A1 v2 owner decision preparation", () => {
  it("binds the exact immutable source manifest and states its non-promotable boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-owner-decision-")); roots.push(root);
    const out = join(root, "decision.json");
    const result = run(fixture(root), "s3://controlled-bucket/a1-v2/candidates/a1-v2-example/source-manifest.json?versionId=immutable", futureRetention(), "A1-V2-TERMS-PROTOTYPE-EXAMPLE", out);
    expect(result.status).toBe(0);
    const decision = JSON.parse(readFileSync(out, "utf8"));
    expect(decision).toMatchObject({
      status: "approved_all", prototype_only: true, lock_eligible: false,
      scope: { snapshot_id: "a1-v2-example", source_manifest_reference: expect.stringContaining("versionId=immutable") },
      sources: ["src_one", "src_two"],
    });
    expect(decision.owner_decision.prohibited_uses).toContain("production publication approval");
  });

  it("rejects mutable references, expired retention, and overwrites", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-owner-decision-")); roots.push(root);
    const manifest = fixture(root);
    const out = join(root, "decision.json");
    expect(run(manifest, "s3://controlled-bucket/a1-v2/source-manifest.json", futureRetention(), "A1-V2-TERMS-TEST", out).stderr).toContain("versionId");
    expect(run(manifest, "s3://controlled-bucket/a1-v2/source-manifest.json?versionId=immutable", "2020-01-01T00:00:00Z", "A1-V2-TERMS-TEST", out).stderr).toContain("未来");
    writeFileSync(out, "existing\n");
    const overwrite = run(manifest, "s3://controlled-bucket/a1-v2/source-manifest.json?versionId=immutable", futureRetention(), "A1-V2-TERMS-TEST", out);
    expect(overwrite.status).toBe(2);
    expect(readFileSync(out, "utf8")).toBe("existing\n");
  });
});
