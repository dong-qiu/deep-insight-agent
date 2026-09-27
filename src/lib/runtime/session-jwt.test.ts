import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JWT } from "next-auth/jwt";
import { authConfig } from "../../auth.config.js";
import { openDb, type DB } from "../db/index.js";
import { authenticateSessionUser, authenticateUser, deleteUser, listUsers, readSessionUser, upsertUser, type SessionUser } from "../db/users.js";
import { createSessionJwt } from "./session-jwt.js";

let db: DB;
beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-session-secret");
  vi.stubEnv("ADMIN_EMAIL", "admin@example.test");
  vi.stubEnv("ADMIN_PASSWORD", "admin-password");
  db = openDb(":memory:");
  upsertUser(db, "viewer@example.test", "viewer-password", "viewer");
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); });

const tokenFor = (user: SessionUser): JWT => ({ sub: user.id, email: user.email, role: user.role, sessionVersion: user.sessionVersion });
function runJwt(token: JWT, extra: Record<string, unknown> = {}, lookup = (email: string) => readSessionUser(db, email)) {
  const jwt = createSessionJwt(lookup);
  return jwt({ token, ...extra } as Parameters<typeof jwt>[0]);
}
const viewer = () => authenticateSessionUser(db, "viewer@example.test", "viewer-password")!;

describe("current credential session binding", () => {
  it("accepts unchanged identity and exposes only public fields", async () => {
    const user = viewer(), token = tokenFor(user);
    expect(await runJwt(token)).toEqual(token);
    expect(user.sessionVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(authenticateUser(db, user.email, "viewer-password")!).sort()).toEqual(["email", "id", "name", "role"]);
    expect(JSON.stringify(listUsers(db))).not.toContain("sessionVersion");
    const session = { user: { name: user.name, email: user.email, role: "viewer" as const }, expires: "2099-01-01" };
    expect(await authConfig.callbacks.session({ session, token } as Parameters<typeof authConfig.callbacks.session>[0])).toEqual(session);
    expect(JSON.stringify(session)).not.toContain(user.sessionVersion);
    expect(authConfig.callbacks.jwt()).toBeNull(); // forgotten Node config cannot fail open
  });

  it.each(["new-password", "viewer-password"])("invalidates upsert even for password %s", async (password) => {
    const old = tokenFor(viewer());
    upsertUser(db, "viewer@example.test", password, "viewer");
    expect(await runJwt(old)).toBeNull();
    expect(await runJwt(tokenFor(authenticateSessionUser(db, "viewer@example.test", password)!))).not.toBeNull();
  });

  it("rejects deleted and same-password recreated accounts", async () => {
    const old = tokenFor(viewer());
    deleteUser(db, "viewer@example.test");
    expect(await runJwt(old)).toBeNull();
    upsertUser(db, "viewer@example.test", "viewer-password", "viewer");
    expect(await runJwt(old)).toBeNull();
  });

  it("documents restore boundary: an old credential snapshot requires secret rotation", async () => {
    const old = tokenFor(viewer());
    const saved = db.prepare("SELECT password_hash FROM app_user WHERE email=?").get("viewer@example.test") as { password_hash: string };
    upsertUser(db, "viewer@example.test", "changed", "viewer");
    expect(await runJwt(old)).toBeNull();
    db.prepare("UPDATE app_user SET password_hash=? WHERE email=?").run(saved.password_hash, "viewer@example.test");
    expect(await runJwt(old)).not.toBeNull(); // state fingerprint is deliberately not a revocation ledger
    vi.stubEnv("AUTH_SECRET", "new-secret-after-restore");
    expect(await runJwt(old)).toBeNull();
  });

  it("detects role-only change without relying on password rotation", async () => {
    upsertUser(db, "legacy@example.test", "legacy-password", "admin");
    const old = tokenFor(authenticateSessionUser(db, "legacy@example.test", "legacy-password")!);
    db.prepare("UPDATE app_user SET role='viewer' WHERE email=?").run("legacy@example.test");
    expect(await runJwt(old)).toBeNull();
  });

  it("does not issue a current version for a previously authorized, now changed snapshot", async () => {
    const authorized = viewer();
    upsertUser(db, authorized.email, "changed-between-callbacks", "admin");
    expect(await runJwt({}, { user: authorized })).toBeNull();
  });

  it("ignores all client update fields, including role, version and identity", async () => {
    const user = viewer(), token = tokenFor(user);
    const attack = { role: "admin", sub: "admin", email: "admin@example.test", sessionVersion: "a".repeat(64) };
    expect(await runJwt(token, { trigger: "update", session: { ...attack, user: attack } })).toEqual(tokenFor(user));
    upsertUser(db, user.email, "changed", "viewer");
    expect(await runJwt(token, { trigger: "update", session: { sessionVersion: readSessionUser(db, user.email)!.sessionVersion } })).toBeNull();
  });

  it.each([{}, { sessionVersion: "short" }, { role: "admin" }, { sub: "admin" }, { email: "other@example.test" }, { role: "superuser" }])(
    "rejects legacy or mismatching token %j", async (delta) => {
      const token = tokenFor(viewer());
      if (!Object.keys(delta).length) delete token.sessionVersion;
      expect(await runJwt({ ...token, ...delta })).toBeNull();
    },
  );

  it("rejects lookup failures and does not poison a subsequent healthy check", async () => {
    const token = tokenFor(viewer());
    expect(await runJwt(token, {}, () => { throw new Error("db unavailable"); })).toBeNull();
    expect(await runJwt(token)).toEqual(token);
  });

  it("rotates bootstrap credentials and prevents same-email DB fallback", async () => {
    upsertUser(db, "admin@example.test", "shadow", "admin");
    const old = tokenFor(authenticateSessionUser(db, " ADMIN@EXAMPLE.TEST ", "admin-password")!);
    expect(await runJwt(old)).not.toBeNull();
    expect(authenticateSessionUser(db, "admin@example.test", "shadow")).toBeNull();
    vi.stubEnv("ADMIN_PASSWORD", "rotated-password");
    expect(await runJwt(old)).toBeNull();
    expect(await runJwt(tokenFor(authenticateSessionUser(db, "admin@example.test", "rotated-password")!))).not.toBeNull();
    vi.stubEnv("ADMIN_PASSWORD", "");
    expect(await runJwt(old)).toBeNull();
  });

  it("rejects when secret unavailable, supports legacy env alias, and separates secret rotations", async () => {
    const token = tokenFor(viewer());
    vi.stubEnv("AUTH_SECRET", undefined); vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(await runJwt(token)).toBeNull();
    expect(() => viewer()).toThrow("session version secret unavailable");
    vi.stubEnv("NEXTAUTH_SECRET", "test-session-secret");
    expect(await runJwt(token)).not.toBeNull();
    vi.stubEnv("AUTH_SECRET", ""); // match Auth.js: explicitly empty primary is not the legacy alias
    expect(await runJwt(token)).toBeNull();
    vi.stubEnv("AUTH_SECRET", "rotated-secret");
    expect(await runJwt(token)).toBeNull();
  });
});
