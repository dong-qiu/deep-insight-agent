import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createA1QualityCheckpoint, loadVerifiedA1QualityCheckpoint, writeA1QualityCheckpoint } from "./a1-quality-checkpoint.js";
import { loadVerifiedA1QualityCheckpoint as twoRead } from "./fixtures/c4b-two-read-checkpoint.js";
import { sha256File } from "./a1-artifacts.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const original = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
afterEach(() => {
  vi.mocked(readFileSync).mockImplementation(original.readFileSync); vi.clearAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const context = { eval_config_sha256: "a".repeat(64), quality_dataset_sha256: "b".repeat(64), recovery_identity_sha256: "c".repeat(64) };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "c4b-single-read-")); roots.push(root);
  const path = join(root, "quality-checkpoint.json"); const manifest = join(root, "manifest.json");
  const checkpoint = createA1QualityCheckpoint(context); writeA1QualityCheckpoint(path, checkpoint);
  const hash = sha256File(path);
  writeFileSync(manifest, JSON.stringify({ status: "failed", artifacts: { "quality-checkpoint.json": hash } }));
  vi.clearAllMocks(); return { path, manifest, checkpoint, hash };
}

it("reads recovery source once and returns exactly the verified bytes and original judgment identity", () => {
  const f = fixture();
  expect(loadVerifiedA1QualityCheckpoint(f.manifest, f.path, context, [])).toEqual({ checkpoint: f.checkpoint, checkpoint_sha256: f.hash });
  expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === f.path)).toHaveLength(1);
});

it("parses the bound Buffer when the source is replaced immediately after that read", () => {
  const f = fixture();
  const replacement = { ...f.checkpoint, recovery_identity_sha256: "d".repeat(64) };
  vi.mocked(readFileSync).mockImplementation(((...args: Parameters<typeof readFileSync>) => {
    const bytes = original.readFileSync(...args);
    if (args[0] === f.path) writeFileSync(f.path, JSON.stringify(replacement));
    return bytes;
  }) as typeof readFileSync);
  expect(loadVerifiedA1QualityCheckpoint(f.manifest, f.path, context, [])).toEqual({ checkpoint: f.checkpoint, checkpoint_sha256: f.hash });
});

it("safe two-read reference rejects replacement rather than accepting unbound second bytes", () => {
  const f = fixture(); let reads = 0;
  vi.mocked(readFileSync).mockImplementation(((...args: Parameters<typeof readFileSync>) => {
    const bytes = original.readFileSync(...args);
    if (args[0] === f.path && ++reads === 1) writeFileSync(f.path, JSON.stringify({ ...f.checkpoint, cases: [], extra: "replacement" }));
    return bytes;
  }) as typeof readFileSync);
  expect(() => twoRead(f.manifest, f.path, context, [])).toThrow();
  expect(reads).toBe(2);
});

it.each(["running", "completed"])("refuses non-failed source manifest (%s)", (status) => {
  const f = fixture(); writeFileSync(f.manifest, JSON.stringify({ status, artifacts: { "quality-checkpoint.json": f.hash } }));
  expect(() => loadVerifiedA1QualityCheckpoint(f.manifest, f.path, context, [])).toThrow("哈希绑定");
});

it("refuses v1, missing identity, bad hash, malformed bytes and an unreadable checkpoint", () => {
  for (const replacement of [
    { ...createA1QualityCheckpoint(context), schema_version: "a1-quality-checkpoint-v1" },
    { schema_version: "a1-quality-checkpoint-v2", eval_config_sha256: context.eval_config_sha256, quality_dataset_sha256: context.quality_dataset_sha256, cases: [] },
  ]) {
    const f = fixture(); writeFileSync(f.path, JSON.stringify(replacement));
    writeFileSync(f.manifest, JSON.stringify({ status: "failed", artifacts: { "quality-checkpoint.json": sha256File(f.path) } }));
    expect(() => loadVerifiedA1QualityCheckpoint(f.manifest, f.path, context, [])).toThrow();
  }
  const f = fixture(); writeFileSync(f.path, "{partial");
  expect(() => loadVerifiedA1QualityCheckpoint(f.manifest, f.path, context, [])).toThrow("哈希绑定");
  writeFileSync(f.manifest, JSON.stringify({ status: "failed", artifacts: { "quality-checkpoint.json": sha256File(f.path) } }));
  expect(() => loadVerifiedA1QualityCheckpoint(f.manifest, f.path, context, [])).toThrow("无法解析");
  expect(() => loadVerifiedA1QualityCheckpoint(f.manifest, join(f.path, "missing"), context, [])).toThrow();
});
