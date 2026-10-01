import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { closeDb, getDb, openDb } from "./index.js";
import * as reports from "./reports.js";
import * as rawArchive from "./raw-archive.js";
import * as planning from "./planning.js";

beforeEach(() => {
  closeDb();
  vi.stubEnv("DB_PATH", ":memory:");
  vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", undefined);
  vi.stubEnv("PROVENANCE_DEPLOYMENT_REQUIRED", undefined);
  vi.stubEnv("PROVENANCE_DEPLOYMENT_WRITER", undefined);
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("database initialization failure boundaries", () => {
  it("does not cache a connection rejected by the real migration guard", () => {
    vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", "1");
    const close = vi.spyOn(Database.prototype, "close");
    for (let attempt = 0; attempt < 2; attempt++) expect(getDb).toThrow(/has not been applied/);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not cache a connection rejected by the real deployment guard", () => {
    vi.stubEnv("PROVENANCE_DEPLOYMENT_REQUIRED", "1");
    vi.stubEnv("INSIGHT_IMAGE_DIGEST", undefined);
    const close = vi.spyOn(Database.prototype, "close");
    for (let attempt = 0; attempt < 2; attempt++) expect(getDb).toThrow("deployment_identity_missing_digest");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("closes a connection when reconciliation fails and retries initialization", () => {
    const error = new Error("injected reconciliation failure");
    const reconcile = vi.spyOn(reports, "reconcileReportEffects").mockImplementationOnce(() => { throw error; });
    const close = vi.spyOn(Database.prototype, "close");
    expect(getDb).toThrow(error);
    expect(close).toHaveBeenCalledTimes(1);
    const db = getDb();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(db.open).toBe(true);
    expect(getDb()).toBe(db);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("closes a connection if openDb itself fails while applying the schema", () => {
    const error = new Error("injected schema failure");
    vi.spyOn(Database.prototype, "exec").mockImplementationOnce(() => { throw error; });
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => openDb(":memory:")).toThrow(error);
    expect(close).toHaveBeenCalledTimes(1);
    const db = openDb(":memory:");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='content_item'").get()).toBeTruthy();
    db.close();
  });

  it("can initialize after a failed check is corrected; close is idempotent", () => {
    vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", "1");
    expect(getDb).toThrow(/has not been applied/);
    vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", undefined);
    const db = getDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='content_item'").get()).toBeTruthy();
    closeDb();
    expect(db.open).toBe(false);
    expect(closeDb).not.toThrow();
    expect(getDb()).not.toBe(db);
  });

  it.each([
    { stage: "raw archive", inject: () => vi.spyOn(rawArchive, "reconcileRawArchiveEffects") },
    { stage: "default directions", inject: () => vi.spyOn(planning, "seedDefaultDirections") },
  ])("does not publish the connection on a late $stage failure", ({ inject }) => {
    const error = new Error("injected late initialization failure");
    const stage = inject().mockImplementationOnce(() => { throw error; });
    const close = vi.spyOn(Database.prototype, "close");
    expect(getDb).toThrow(error);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getDb().open).toBe(true);
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it("preserves the original initialization error when cleanup also throws", () => {
    const error = new Error("schema failure is the root cause");
    vi.spyOn(Database.prototype, "exec").mockImplementationOnce(() => { throw error; });
    const originalClose = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementationOnce(function (this: Database.Database) {
      originalClose.call(this);
      throw new Error("secondary cleanup failure");
    });
    expect(() => openDb(":memory:")).toThrow(error);
  });
});
