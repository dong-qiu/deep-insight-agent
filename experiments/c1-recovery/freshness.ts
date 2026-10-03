/** Independent synthetic witness; its non-rollback control is an explicit external assumption. */
import Database from "better-sqlite3";
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import type { DB } from "../../src/lib/db/index.js";
import { C1_SYNTHETIC_FRESHNESS_SCHEMA_SQL } from "../../src/lib/db/schema.js";
import { authenticated, digest, signed, type Signed } from "./core.js";
import { privateSyntheticPath } from "./private-store.js";

type Binding = { epoch: string; issuer: string; current: string };
type Reservation = { token: string; before: string; after: string };
type State = { protocol: "synthetic-freshness-v1"; id: string; generation: number;
  binding: Binding | null; pending: Reservation | null };
const encode = (value: unknown) => JSON.stringify(value);
const hashValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(code: string): never { throw new Error(`synthetic_freshness_${code}`); }
export const publicKeyDigest = (key: KeyObject) => digest((key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" }));

export class SyntheticFreshnessAnchor {
  readonly id: string;
  readonly path: string;
  #db: DB;
  #signer: KeyObject;
  #trust: KeyObject;
  private constructor(db: DB, path: string, id: string, signer: KeyObject, trust: KeyObject) {
    authenticated(signed({ probe: "synthetic-freshness-key-pair" }, signer), trust);
    this.#db = db; this.path = path; this.id = id; this.#signer = signer; this.#trust = trust;
    db.pragma("busy_timeout = 5000"); db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
  }
  static create(path: string, signer: KeyObject, trust: KeyObject): SyntheticFreshnessAnchor {
    privateSyntheticPath(path, false);
    authenticated(signed({ probe: "synthetic-freshness-key-pair" }, signer), trust);
    closeSync(openSync(path, "wx", 0o600));
    const db = new Database(path), id = randomUUID();
    try {
      const anchor = new SyntheticFreshnessAnchor(db, path, id, signer, trust);
      db.transaction(() => {
        db.exec(C1_SYNTHETIC_FRESHNESS_SCHEMA_SQL);
        db.prepare("INSERT INTO c1_freshness_state VALUES (1,?)").run(encode(signed({
          protocol: "synthetic-freshness-v1", id, generation: 0, binding: null, pending: null,
        } satisfies State, signer)));
      }).immediate();
      return anchor;
    } catch (error) { db.close(); throw error; }
  }
  static open(path: string, id: string, signer: KeyObject, trust: KeyObject): SyntheticFreshnessAnchor {
    privateSyntheticPath(path, true);
    const db = new Database(path, { fileMustExist: true });
    try {
      const anchor = new SyntheticFreshnessAnchor(db, path, id, signer, trust);
      anchor.checked(() => undefined); return anchor;
    } catch (error) { db.close(); throw error; }
  }
  private read(): State {
    const row = this.#db.prepare("SELECT signed_state FROM c1_freshness_state WHERE id=1").get() as { signed_state: string } | undefined;
    if (!row) fail("missing");
    const state = authenticated(JSON.parse(row.signed_state) as Signed<State>, this.#trust);
    if (state.protocol !== "synthetic-freshness-v1" || state.id !== this.id || !Number.isSafeInteger(state.generation) || state.generation < 0 ||
      (state.binding !== null && (!state.binding || typeof state.binding.epoch !== "string" || !state.binding.epoch ||
        !hashValid(state.binding.issuer) || !hashValid(state.binding.current))) ||
      (state.pending !== null && (!state.pending || !state.binding || !state.pending.token ||
        state.pending.before !== state.binding.current || !hashValid(state.pending.after)))) fail("state_invalid");
    return state;
  }
  private checked<T>(fn: (state: State) => T): T { return this.#db.transaction(() => fn(this.read())).immediate(); }
  private save(state: State): void {
    this.#db.prepare("UPDATE c1_freshness_state SET signed_state=? WHERE id=1").run(encode(signed(state, this.#signer)));
  }
  /** Only fresh-registry creation calls this; no adoption/re-enrollment/recovery API. */
  enroll(epoch: string, issuer: string, current: string): void {
    this.checked((state) => {
      if (state.binding || state.pending || state.generation !== 0) fail("already_enrolled");
      if (!epoch || !hashValid(issuer) || !hashValid(current) || issuer === publicKeyDigest(this.#trust)) fail("binding_invalid");
      state.binding = { epoch, issuer, current }; this.save(state);
    });
  }
  private match(state: State, epoch: string, issuer: string, current: string): void {
    if (state.pending) fail("pending");
    if (!state.binding || state.binding.epoch !== epoch || state.binding.issuer !== issuer) fail("binding_invalid");
    if (state.binding.current !== current) fail("stale");
  }
  assertCurrent(epoch: string, issuer: string, current: string): void {
    this.checked((state) => this.match(state, epoch, issuer, current));
  }
  reserve(epoch: string, issuer: string, before: string, after: string): string {
    return this.checked((state) => {
      this.match(state, epoch, issuer, before);
      if (!hashValid(after) || before === after || state.generation === Number.MAX_SAFE_INTEGER) fail("transition_invalid");
      const token = randomUUID(); state.pending = { token, before, after }; this.save(state); return token;
    });
  }
  finalize(token: string, commitRegistry: () => void): void {
    this.checked((state) => {
      if (!state.binding || !state.pending || state.pending.token !== token) fail("reservation_invalid");
      // Hold this anchor transaction across the registry COMMIT. A sibling that obtains
      // the now-released registry lock waits for finalize instead of seeing transient pending.
      // Crash/commit failure rolls this transaction back to the previously durable reservation.
      commitRegistry();
      state.binding.current = state.pending.after; state.pending = null; state.generation++; this.save(state);
    });
  }
  close(): void { this.#db.close(); }
}
