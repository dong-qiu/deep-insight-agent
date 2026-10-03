import Database from "better-sqlite3";
import { fork } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db/index.js";
import { DurableSyntheticAuthority } from "../experiments/c1-recovery/durable.js";

const origin = "2026-01-01T00:00:00Z", cutoff = "2026-03-01T00:00:00Z";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "c1-registry-test-")), path = join(dir, "registry.sqlite");
  const issuer = generateKeyPairSync("ed25519");
  const first = DurableSyntheticAuthority.create(path, origin, issuer.privateKey, issuer.publicKey), epoch = first.epoch;
  first.close();
  const open = () => DurableSyntheticAuthority.open(path, epoch, issuer.privateKey, issuer.publicKey);
  const child = (mode: "batch" | "pending" | "freeze", prefix = "child", count = 1) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const proc = fork(fileURLToPath(new URL("./fixtures/c1-registry-child.ts", import.meta.url)), [],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let result: Record<string, unknown> | undefined, stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("message", (message) => { result = message as Record<string, unknown>; if (mode === "pending") proc.kill("SIGKILL"); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => result && (code === 0 || (mode === "pending" && signal === "SIGKILL"))
      ? resolve(result) : reject(new Error(`synthetic child failed: ${code} ${stderr}`)));
    proc.send({ path, epoch, mode, prefix, count, pem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  });
  return { path, epoch, issuer, open, child, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe("durable synthetic registry (no production files/cloud)", () => {
  it("characterizes v1: a complete valid same-epoch rollback is not detected without an independent anchor", async () => {
    const f = fixture(); const snapshot = `${f.path}.old`;
    try {
      const raw = new Database(f.path);
      try { await raw.backup(snapshot); chmodSync(snapshot, 0o600); } finally { raw.close(); }
      const a = f.open();
      a.commit(a.begin(), { key: "later", version: "v1", body: "synthetic" }); a.freeze(cutoff); a.close();
      copyFileSync(snapshot, f.path);
      const rolledBack = f.open();
      try {
        expect(rolledBack.objects()).toEqual([]);
        expect(rolledBack.freeze(cutoff).payload.entries).toEqual([]);
      } finally { rolledBack.close(); }
    } finally { f.cleanup(); }
  });
  it("persists concurrent process commits without lost updates or sequence gaps", async () => {
    const f = fixture(); try {
      await Promise.all([f.child("batch", "a", 6), f.child("batch", "b", 6), f.child("batch", "c", 6)]);
      const a = f.open(); try {
        expect(a.objects()).toHaveLength(18);
        const checkpoint = a.freeze(cutoff);
        expect(checkpoint.payload.entries.map((entry) => entry.sequence)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
        expect(new Set(checkpoint.payload.entries.map((entry) => entry.key)).size).toBe(18);
      } finally { a.close(); }
    } finally { f.cleanup(); }
  }, 15000);
  it("retains an intent after its process exits and refuses sampling/freeze until explicitly resolved", async () => {
    const f = fixture(); const business = openDb(":memory:"); try {
      const result = await f.child("pending");
      const a = f.open(); try {
        expect(() => a.freeze(cutoff)).toThrow("freeze_invalid");
        expect(() => a.backup(business, cutoff)).toThrow("sample_invalid");
        expect(await f.child("freeze")).toEqual({ refused: true });
        a.commit(result.token as string, { key: "orphan", version: "v1", body: "synthetic external commit; no business write" });
        const cp = a.freeze(cutoff); expect(cp.payload.entries).toHaveLength(1);
      } finally { a.close(); }
    } finally { business.close(); f.cleanup(); }
  }, 15000);
  it("persists the closed gate, rejects late retries and refuses fresh process freeze after closure", async () => {
    const f = fixture(); try {
      const a = f.open(), token = a.begin();
      a.commit(token, { key: "one", version: "v1", body: "synthetic" }); const cp = a.freeze(cutoff); a.close();
      const b = f.open(); try {
        b.assertFrozen(cp);
        expect(() => b.begin()).toThrow("maintenance_closed");
        expect(() => b.commit(token, { key: "late", version: "v1", body: "synthetic" })).toThrow("commit_fenced");
        expect(() => b.abort(token)).toThrow("pending_unknown");
        expect(await f.child("freeze")).toEqual({ refused: true });
        expect(b.objects()).toHaveLength(1);
      } finally { b.close(); }
    } finally { f.cleanup(); }
  }, 15000);
  it("failed conflicting commit leaves no sequence gap, preserves pending and blocks checkpoint", () => {
    const f = fixture(); try {
      const a = f.open(); try {
        a.commit(a.begin(), { key: "one", version: "v1", body: "synthetic" }); const token = a.begin();
        expect(() => a.commit(token, { key: "one", version: "v2", body: "conflict" })).toThrow("object_conflict");
        expect(() => a.freeze(cutoff)).toThrow("freeze_invalid");
        a.abort(token); expect(a.freeze(cutoff).payload.entries.map((entry) => entry.sequence)).toEqual([1]);
      } finally { a.close(); }
    } finally { f.cleanup(); }
  });
  it("an already-open sibling cannot use stale state to bypass a frozen gate", () => {
    const f = fixture(); const a = f.open(), b = f.open(); try {
      const token = b.begin(); expect(() => a.freeze(cutoff)).toThrow("freeze_invalid");
      b.commit(token, { key: "one", version: "v1", body: "synthetic" }); const cp = a.freeze(cutoff);
      b.assertFrozen(cp); expect(() => b.begin()).toThrow("maintenance_closed");
      expect(() => b.commit(token, { key: "late", version: "v1", body: "synthetic" })).toThrow("commit_fenced");
    } finally { a.close(); b.close(); f.cleanup(); }
  });
  it("rolls back an appended object if signed-head persistence fails, retaining pending across reopen", () => {
    const f = fixture(); try {
      const a = f.open(), token = a.begin(), raw = new Database(f.path);
      const before = raw.prepare("SELECT signed_state FROM c1_registry_state").get();
      raw.exec("CREATE TRIGGER inject_state_failure BEFORE UPDATE ON c1_registry_state BEGIN SELECT RAISE(ABORT,'injected state failure'); END");
      try {
        expect(() => a.commit(token, { key: "one", version: "v1", body: "synthetic" })).toThrow("injected state failure");
        expect(a.objects()).toEqual([]);
        expect(raw.prepare("SELECT signed_state FROM c1_registry_state").get()).toEqual(before);
      } finally { a.close(); }
      const b = f.open(); try {
        expect(() => b.freeze(cutoff)).toThrow("freeze_invalid");
        raw.exec("DROP TRIGGER inject_state_failure");
        b.commit(token, { key: "one", version: "v1", body: "synthetic" });
        expect(b.freeze(cutoff).payload.entries.map((entry) => entry.sequence)).toEqual([1]);
      } finally { b.close(); raw.close(); }
    } finally { f.cleanup(); }
  });
  it("refuses wrong epoch/key, missing registry and exclusive re-creation", () => {
    const f = fixture(); try {
      expect(() => DurableSyntheticAuthority.open(f.path, "wrong", f.issuer.privateKey, f.issuer.publicKey)).toThrow("state_invalid");
      const wrong = generateKeyPairSync("ed25519");
      expect(() => DurableSyntheticAuthority.open(f.path, f.epoch, wrong.privateKey, wrong.publicKey)).toThrow("signature_invalid");
      expect(() => DurableSyntheticAuthority.create(f.path, origin, f.issuer.privateKey, f.issuer.publicKey)).toThrow();
      expect(() => DurableSyntheticAuthority.open(`${f.path}.missing`, f.epoch, f.issuer.privateKey, f.issuer.publicKey)).toThrow();
      expect(statSync(f.path).mode & 0o077).toBe(0);
    } finally { f.cleanup(); }
  });
  it.each(["object", "state", "missing"])("refuses tampered %s rather than issuing a new checkpoint", (target) => {
    const f = fixture(); try {
      const a = f.open(); a.commit(a.begin(), { key: "one", version: "v1", body: "synthetic" }); a.close();
      const db = new Database(f.path); try {
        if (target === "state") db.prepare("UPDATE c1_registry_state SET signed_state=?").run('{"payload":{},"signature":"bad"}');
        else {
          db.exec("DROP TRIGGER c1_registry_object_no_update; DROP TRIGGER c1_registry_object_no_delete");
          if (target === "missing") db.exec("DELETE FROM c1_registry_object");
          else db.prepare("UPDATE c1_registry_object SET signed_object=?").run('{"payload":{},"signature":"bad"}');
        }
      } finally { db.close(); }
      expect(() => f.open()).toThrow();
    } finally { f.cleanup(); }
  });
});
