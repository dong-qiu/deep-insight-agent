import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "./index.js";
import { authenticateUser, deleteUser, hashPassword, listUsers, upsertUser, verifyPassword } from "./users.js";

let db: DB;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD; });

describe("password hashing (scrypt)", () => {
  it("hash 可被 verify、错密码 false", () => {
    const h = hashPassword("s3cret");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("s3cret", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });
  it("同密码两次 hash 不同（随机盐）但都可验", () => {
    const a = hashPassword("pw"), b = hashPassword("pw");
    expect(a).not.toBe(b);
    expect(verifyPassword("pw", a) && verifyPassword("pw", b)).toBe(true);
  });
  it("畸形哈希 → false（不抛）", () => {
    expect(verifyPassword("pw", "garbage")).toBe(false);
    expect(verifyPassword("pw", "scrypt$onlytwo")).toBe(false);
    expect(verifyPassword("pw", "bcrypt$x$y")).toBe(false);
  });
});

describe("用户表 CRUD", () => {
  it("upsert → list（不含哈希）→ delete", () => {
    upsertUser(db, "v@x.com", "pw", "viewer", "Vee");
    let rows = listUsers(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "v@x.com", role: "viewer", name: "Vee" });
    expect("password_hash" in rows[0]).toBe(false); // 列表不泄露哈希
    expect(deleteUser(db, "v@x.com")).toBe(true);
    expect(listUsers(db)).toHaveLength(0);
    expect(deleteUser(db, "v@x.com")).toBe(false); // 删不存在 → false
  });
  it("同 email upsert = 覆盖（改密码/角色）", () => {
    upsertUser(db, "u@x.com", "old", "viewer");
    upsertUser(db, "u@x.com", "new", "admin");
    expect(listUsers(db)).toHaveLength(1);
    expect(authenticateUser(db, "u@x.com", "new")?.role).toBe("admin");
    expect(authenticateUser(db, "u@x.com", "old")).toBeNull(); // 旧密码失效
  });
  it("未知 role 落 viewer（最小权限）", () => {
    upsertUser(db, "u@x.com", "pw", "superuser" as never);
    expect(listUsers(db)[0].role).toBe("viewer");
  });
});

describe("authenticateUser（env admin 优先 + DB 用户）", () => {
  it("env admin 正确凭据 → admin", () => {
    process.env.ADMIN_EMAIL = "admin@x.com"; process.env.ADMIN_PASSWORD = "apw";
    expect(authenticateUser(db, "admin@x.com", "apw")).toMatchObject({ role: "admin", email: "admin@x.com" });
  });
  it("DB viewer 正确凭据 → viewer", () => {
    upsertUser(db, "v@x.com", "vpw", "viewer");
    expect(authenticateUser(db, "v@x.com", "vpw")).toMatchObject({ role: "viewer", email: "v@x.com" });
  });
  it("env admin 不会被同 email 的库内记录覆盖/锁死（root 不可夺）", () => {
    process.env.ADMIN_EMAIL = "admin@x.com"; process.env.ADMIN_PASSWORD = "apw";
    upsertUser(db, "admin@x.com", "hacked", "viewer"); // 库里塞同名 viewer
    // env 密码仍登 admin；库内密码登不进（env 先判、且匹配 env 密码即返 admin）
    expect(authenticateUser(db, "admin@x.com", "apw")).toMatchObject({ role: "admin" });
    expect(authenticateUser(db, "admin@x.com", "hacked")).toBeNull();
  });
  it("错密码 / 缺凭据 / 不存在 → null", () => {
    upsertUser(db, "v@x.com", "vpw", "viewer");
    expect(authenticateUser(db, "v@x.com", "bad")).toBeNull();
    expect(authenticateUser(db, "nobody@x.com", "x")).toBeNull();
    expect(authenticateUser(db, undefined, "x")).toBeNull();
    expect(authenticateUser(db, "v@x.com", undefined)).toBeNull();
  });
  it("返回的 AppUser 不含 password/hash", () => {
    upsertUser(db, "v@x.com", "vpw", "viewer");
    const u = authenticateUser(db, "v@x.com", "vpw")!;
    expect(Object.keys(u).sort()).toEqual(["email", "id", "name", "role"]);
  });
});
