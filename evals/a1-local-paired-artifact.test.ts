import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishVerifiedLocalPair, type LocalPairWriter } from "./a1-local-paired-artifact.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function artifacts() {
  const root = mkdtempSync(join(tmpdir(), "a1-local-pair-"));
  roots.push(root);
  return {
    primary: { path: join(root, "nested", "data.local.jsonl"), bytes: Buffer.from("data\n"), label: "data" },
    companion: { path: join(root, "nested", "receipt.local.json"), bytes: Buffer.from("{\"ok\":true}\n"), label: "receipt" },
  };
}

describe("recoverable local paired artifacts", () => {
  it("publishes once, accepts the exact already-published pair, and never overwrites it", () => {
    const { primary, companion } = artifacts();
    expect(publishVerifiedLocalPair(primary, companion)).toBe("published");
    expect(publishVerifiedLocalPair(primary, companion)).toBe("already_published");
    expect(readFileSync(primary.path)).toEqual(primary.bytes);
    expect(readFileSync(companion.path)).toEqual(companion.bytes);
  });

  it("recovers exactly the missing second artifact after an injected second-write failure", () => {
    const { primary, companion } = artifacts();
    const failingWriter: LocalPairWriter = {
      mkdir: (path) => { mkdirSync(path, { recursive: true }); },
      writeExclusive: (path, bytes) => {
        if (path === companion.path) throw new Error("injected second write failure");
        writeFileSync(path, bytes, { flag: "wx" });
      },
    };
    expect(() => publishVerifiedLocalPair(primary, companion, failingWriter)).toThrow("injected second write failure");
    expect(readFileSync(primary.path)).toEqual(primary.bytes);
    expect(() => readFileSync(companion.path)).toThrow();
    expect(publishVerifiedLocalPair(primary, companion)).toBe("recovered");
    expect(readFileSync(companion.path)).toEqual(companion.bytes);
  });

  it("rejects mismatched pre-existing evidence instead of turning a retry into an overwrite", () => {
    const { primary, companion } = artifacts();
    expect(publishVerifiedLocalPair(primary, companion)).toBe("published");
    unlinkSync(companion.path);
    writeFileSync(companion.path, "forged\n");
    expect(() => publishVerifiedLocalPair(primary, companion)).toThrow(/receipt.*不一致/);
  });
});
