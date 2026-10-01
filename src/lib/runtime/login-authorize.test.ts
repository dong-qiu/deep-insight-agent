import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db/index.js";
import { authenticateUser, upsertUser } from "../db/users.js";
import { createLoginAuthorizer, LoginRateLimited } from "./login-authorize.js";

afterEach(() => vi.unstubAllEnvs());

describe("Credentials admission boundary", () => {
  it("normalizes account keys and rejects before touching DB/password verifier", () => {
    const verify = vi.fn(() => null);
    const authorize = createLoginAuthorizer(verify);
    for (let i = 0; i < 5; i++) expect(authorize({ email: " USER@EXAMPLE.TEST ", password: "wrong" })).toBeNull();
    expect(() => authorize({ email: "user@example.test", password: "correct" })).toThrow(LoginRateLimited);
    expect(verify).toHaveBeenCalledTimes(5);
    expect(verify).toHaveBeenLastCalledWith("user@example.test", "wrong");
    expect(authorize({ email: "another@example.test", password: "wrong" })).toBeNull();
  });

  it.each([undefined, {}, { email: 12, password: "pw" }, { email: {}, password: "pw" },
    { email: "a", password: [] }, { email: " ", password: "pw" }, { email: "a", password: "" }])(
    "rejects malformed credentials without DB work: %j", (credentials) => {
      const verify = vi.fn(() => null);
      expect(createLoginAuthorizer(verify)(credentials)).toBeNull();
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("does not refund exceptions or expose credentials in the public limit error", () => {
    const verify = vi.fn(() => { throw new Error("database unavailable"); });
    const authorize = createLoginAuthorizer(verify);
    const credentials = { email: "private@example.test", password: "sensitive-test-value" };
    for (let i = 0; i < 5; i++) expect(() => authorize(credentials)).toThrow("database unavailable");
    try { authorize(credentials); throw new Error("expected limit error"); } catch (error) {
      expect(error).toBeInstanceOf(LoginRateLimited);
      expect((error as LoginRateLimited).code).toBe("rate_limited");
      expect(String(error)).not.toContain(credentials.email);
      expect(String(error)).not.toContain(credentials.password);
    }
    expect(verify).toHaveBeenCalledTimes(5);
  });

  it("uses real SQLite/scrypt for viewer, reserves env admin and applies the same guard to both", () => {
    vi.stubEnv("ADMIN_EMAIL", "admin@example.test");
    vi.stubEnv("ADMIN_PASSWORD", "admin-password");
    const db = openDb(":memory:");
    try {
      upsertUser(db, "viewer@example.test", "viewer-password", "viewer");
      upsertUser(db, "admin@example.test", "shadow-password", "viewer");
      const authorize = createLoginAuthorizer((email, password) => authenticateUser(db, email, password));
      for (const [email, password, role] of [
        ["viewer@example.test", "viewer-password", "viewer"], ["admin@example.test", "admin-password", "admin"],
      ]) {
        for (let i = 0; i < 4; i++) expect(authorize({ email, password: "wrong" })).toBeNull();
        const user = authorize({ email, password });
        expect(user?.role).toBe(role);
        expect(Object.keys(user!).sort()).toEqual(["email", "id", "name", "role"]);
        // Success cleared this account's previous four failures.
        for (let i = 0; i < 5; i++) expect(authorize({ email, password: "wrong" })).toBeNull();
        expect(() => authorize({ email, password })).toThrow(LoginRateLimited);
      }
    } finally { db.close(); }
  });
});
