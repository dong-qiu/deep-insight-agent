import Database from "better-sqlite3";
import { fork } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DurableSyntheticAuthority } from "../experiments/c1-recovery/durable.js";
import { SyntheticFreshnessAnchor } from "../experiments/c1-recovery/freshness.js";
import { openDb } from "../src/lib/db/index.js";

const origin = "2026-01-01T00:00:00Z", cutoff = "2026-03-01T00:00:00Z";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "c1-anchor-test-"));
  const path = join(dir, "registry.sqlite"), anchorPath = join(dir, "anchor.sqlite");
  const issuer = generateKeyPairSync("ed25519"), witness = generateKeyPairSync("ed25519");
  const anchor = SyntheticFreshnessAnchor.create(anchorPath, witness.privateKey, witness.publicKey);
  const a = DurableSyntheticAuthority.createAnchored(path, origin, issuer.privateKey, issuer.publicKey, anchor);
  const epoch = a.epoch; a.close();
  const open = () => DurableSyntheticAuthority.openAnchored(path, epoch, issuer.privateKey, issuer.publicKey, anchor);
  const snapshot = async () => {
    const raw = new Database(path), old = `${path}.old`;
    try { await raw.backup(old); chmodSync(old, 0o600); } finally { raw.close(); }
    return () => copyFileSync(old, path);
  };
  const child = (mode: "batch" | "crash-reserve", prefix = "child", count = 1) => new Promise<void>((resolve, reject) => {
    const proc = fork(fileURLToPath(new URL("./fixtures/c1-registry-child.ts", import.meta.url)), [],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => (mode === "crash-reserve" ? signal === "SIGKILL" : code === 0)
      ? resolve() : reject(new Error(`synthetic anchored child failed: ${code} ${stderr}`)));
    proc.send({ path, epoch, mode, prefix, count, pem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      anchor: { path: anchorPath, id: anchor.id, pem: witness.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } });
  });
  return { dir, path, anchorPath, issuer, witness, anchor, epoch, open, snapshot,
    child,
    cleanup: () => { anchor.close(); rmSync(dir, { recursive: true }); } };
}

describe("independent synthetic freshness (no production trust claim)", () => {
  it.each(["object", "pending", "frozen"])("refuses complete same-epoch rollback of %s state", async (state) => {
    const f = fixture(); try {
      const restore = await f.snapshot(), a = f.open();
      if (state === "object") a.commit(a.begin(), { key: "later", version: "v1", body: "synthetic" });
      else if (state === "pending") a.begin();
      else a.freeze(cutoff);
      a.close(); restore();
      expect(() => f.open()).toThrow("freshness_stale");
    } finally { f.cleanup(); }
  });
  it("checks already-open siblings, permits verified no-op reads and refuses writes after freeze", () => {
    const f = fixture(), a = f.open(), b = f.open(), business = openDb(":memory:");
    try {
      a.commit(a.begin(), { key: "one", version: "v1", body: "synthetic" });
      expect(b.objects()).toHaveLength(1);
      const backup = b.backup(business, cutoff); expect(backup.payload.sequence).toBe(1);
      const checkpoint = a.freeze(cutoff); b.assertFrozen(checkpoint);
      expect(() => b.begin()).toThrow("maintenance_closed");
      b.assertFrozen(checkpoint);
    } finally { a.close(); b.close(); business.close(); f.cleanup(); }
  });
  it("a finalize failure leaves durable uncertainty and cannot return a checkpoint", () => {
    const f = fixture(), a = f.open(), raw = new Database(f.anchorPath);
    try {
      raw.exec(`CREATE TRIGGER inject_finalize BEFORE UPDATE ON c1_freshness_state
        WHEN json_extract(NEW.signed_state,'$.payload.pending') IS NULL
        BEGIN SELECT RAISE(ABORT,'injected finalize failure'); END`);
      expect(() => a.freeze(cutoff)).toThrow("injected finalize failure");
      expect(() => a.objects()).toThrow("freshness_pending");
      expect(() => f.open()).toThrow("freshness_pending");
      raw.exec("DROP TRIGGER inject_finalize");
      expect(() => a.freeze(cutoff)).toThrow("freshness_pending");
    } finally { raw.close(); a.close(); f.cleanup(); }
  });
  it("conflicting input fails before reserve and does not poison a usable anchor", () => {
    const f = fixture(), a = f.open(); try {
      a.commit(a.begin(), { key: "one", version: "v1", body: "synthetic" }); const token = a.begin();
      expect(() => a.commit(token, { key: "one", version: "v2", body: "conflict" })).toThrow("object_conflict");
      a.abort(token); expect(a.freeze(cutoff).payload.entries).toHaveLength(1);
    } finally { a.close(); f.cleanup(); }
  });
  it("a real deferred-constraint COMMIT failure leaves reserve pending and the registry unchanged", () => {
    const f = fixture(), a = f.open(), raw = new Database(f.path);
    try {
      const before = raw.prepare("SELECT signed_state FROM c1_registry_state").get();
      raw.exec(`CREATE TABLE injected_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE injected_child(parent_id INTEGER REFERENCES injected_parent(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER inject_commit AFTER UPDATE ON c1_registry_state
        BEGIN INSERT INTO injected_child VALUES(1); END`);
      expect(() => a.freeze(cutoff)).toThrow("FOREIGN KEY constraint failed");
      expect(raw.prepare("SELECT signed_state FROM c1_registry_state").get()).toEqual(before);
      expect(() => a.objects()).toThrow("freshness_pending");
      expect(() => f.open()).toThrow("freshness_pending");
    } finally { raw.close(); a.close(); f.cleanup(); }
  });
  it("survives independent reopen and refuses old API downgrade, identity substitution and absent anchor", () => {
    const f = fixture(); try {
      expect(() => DurableSyntheticAuthority.open(f.path, f.epoch, f.issuer.privateKey, f.issuer.publicKey)).toThrow("anchor_required");
      expect(() => SyntheticFreshnessAnchor.open(f.anchorPath, "wrong", f.witness.privateKey, f.witness.publicKey)).toThrow("state_invalid");
      expect(() => SyntheticFreshnessAnchor.open(`${f.anchorPath}.missing`, f.anchor.id, f.witness.privateKey, f.witness.publicKey)).toThrow();
      const wrong = generateKeyPairSync("ed25519");
      expect(() => SyntheticFreshnessAnchor.open(f.anchorPath, f.anchor.id, wrong.privateKey, wrong.publicKey)).toThrow("signature_invalid");
      const reopened = SyntheticFreshnessAnchor.open(f.anchorPath, f.anchor.id, f.witness.privateKey, f.witness.publicKey);
      try {
        const a = DurableSyntheticAuthority.openAnchored(f.path, f.epoch, f.issuer.privateKey, f.issuer.publicKey, reopened);
        try { a.freeze(cutoff); } finally { a.close(); }
      } finally { reopened.close(); }
      expect(() => DurableSyntheticAuthority.createAnchored(join(f.dir, "adopt.sqlite"), origin, f.issuer.privateKey, f.issuer.publicKey, f.anchor)).toThrow("already_enrolled");
    } finally { f.cleanup(); }
  });
  it("rejects issuer/witness key reuse and leaves unusable initialization unadoptable", () => {
    const dir = mkdtempSync(join(tmpdir(), "c1-shared-key-")), key = generateKeyPairSync("ed25519");
    const anchor = SyntheticFreshnessAnchor.create(join(dir, "anchor.sqlite"), key.privateKey, key.publicKey);
    try {
      const path = join(dir, "registry.sqlite");
      expect(() => DurableSyntheticAuthority.createAnchored(path, origin, key.privateKey, key.publicKey, anchor)).toThrow("binding_invalid");
      expect(() => DurableSyntheticAuthority.open(path, "wrong", key.privateKey, key.publicKey)).toThrow("anchor_required");
      expect(() => DurableSyntheticAuthority.createAnchored(path, origin, key.privateKey, key.publicKey, anchor)).toThrow();
    } finally { anchor.close(); rmSync(dir, { recursive: true }); }
  });
  it("a real killed process leaves reserve durable, registry rolled back and every reopened consumer refused", async () => {
    const f = fixture(); try {
      await f.child("crash-reserve");
      expect(() => f.open()).toThrow("freshness_pending");
      const raw = new Database(f.path);
      try {
        const row = raw.prepare("SELECT signed_state FROM c1_registry_state").get() as { signed_state: string };
        expect(JSON.parse(row.signed_state).payload.pending).toEqual([]);
      } finally { raw.close(); }
      const reopened = SyntheticFreshnessAnchor.open(f.anchorPath, f.anchor.id, f.witness.privateKey, f.witness.publicKey);
      try {
        expect(() => DurableSyntheticAuthority.openAnchored(f.path, f.epoch, f.issuer.privateKey, f.issuer.publicKey, reopened)).toThrow("freshness_pending");
      } finally { reopened.close(); }
    } finally { f.cleanup(); }
  }, 15000);
  it("acknowledged concurrent-process commits are complete and a reopened checkpoint preserves their sequence", async () => {
    const f = fixture(); try {
      await Promise.all([f.child("batch", "a", 5), f.child("batch", "b", 5), f.child("batch", "c", 5)]);
      const a = f.open(); try {
        expect(a.objects()).toHaveLength(15);
        expect(a.freeze(cutoff).payload.entries.map((entry) => entry.sequence)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
      } finally { a.close(); }
    } finally { f.cleanup(); }
  }, 15000);
  it("signature damage in the independent anchor refuses the existing connection", () => {
    const f = fixture(), a = f.open(), raw = new Database(f.anchorPath);
    try {
      raw.prepare("UPDATE c1_freshness_state SET signed_state=?").run('{"payload":{},"signature":"bad"}');
      expect(() => a.objects()).toThrow("signature_invalid");
    } finally { raw.close(); a.close(); f.cleanup(); }
  });
});
