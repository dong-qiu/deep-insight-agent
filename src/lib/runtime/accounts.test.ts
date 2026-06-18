import { describe, expect, it } from "vitest";
import { authenticate, loadAccounts } from "./accounts.js";

const admin: Record<string, string | undefined> = { ADMIN_EMAIL: "admin@x.com", ADMIN_PASSWORD: "adminpw" };

describe("loadAccounts（账号表解析）", () => {
  it("仅 ADMIN_* → 一个 admin 账号", () => {
    const a = loadAccounts(admin);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ email: "admin@x.com", role: "admin" });
  });

  it("APP_USERS 追加 viewer（role 缺省 viewer）", () => {
    const a = loadAccounts({ ...admin, APP_USERS: JSON.stringify([{ email: "v@x.com", password: "vpw" }]) });
    expect(a).toHaveLength(2);
    expect(a[1]).toMatchObject({ email: "v@x.com", role: "viewer", name: "v@x.com" });
  });

  it("APP_USERS 可显式给 admin / 自定义 name", () => {
    const a = loadAccounts({ ...admin, APP_USERS: JSON.stringify([{ email: "b@x.com", password: "bpw", role: "admin", name: "Bob" }]) });
    expect(a[1]).toMatchObject({ email: "b@x.com", role: "admin", name: "Bob" });
  });

  it("未知 role 一律降级 viewer（最小权限）", () => {
    const a = loadAccounts({ ...admin, APP_USERS: JSON.stringify([{ email: "v@x.com", password: "vpw", role: "superuser" }]) });
    expect(a[1].role).toBe("viewer");
  });

  it("非法 JSON / 缺字段 → 忽略该项，不影响 admin 登录", () => {
    expect(loadAccounts({ ...admin, APP_USERS: "{not json" })).toHaveLength(1); // 容错：admin 仍在
    const a = loadAccounts({ ...admin, APP_USERS: JSON.stringify([{ email: "x@x.com" }, { password: "p" }, { email: "ok@x.com", password: "p" }]) });
    expect(a.map((u) => u.email)).toEqual(["admin@x.com", "ok@x.com"]); // 缺 email/password 的两项被跳过
  });

  it("无 ADMIN_* 配置 → 空表（谁也登不进）", () => {
    expect(loadAccounts({})).toHaveLength(0);
  });
});

describe("authenticate（凭据校验）", () => {
  it("admin 正确凭据 → admin 角色", () => {
    expect(authenticate("admin@x.com", "adminpw", admin)).toMatchObject({ role: "admin", email: "admin@x.com" });
  });

  it("viewer 正确凭据 → viewer 角色", () => {
    const env = { ...admin, APP_USERS: JSON.stringify([{ email: "v@x.com", password: "vpw" }]) };
    expect(authenticate("v@x.com", "vpw", env)).toMatchObject({ role: "viewer" });
  });

  it("密码错 / 邮箱错 / 缺凭据 → null", () => {
    expect(authenticate("admin@x.com", "wrong", admin)).toBeNull();
    expect(authenticate("nobody@x.com", "adminpw", admin)).toBeNull();
    expect(authenticate(undefined, "adminpw", admin)).toBeNull();
    expect(authenticate("admin@x.com", undefined, admin)).toBeNull();
  });

  it("返回的 AppUser 不含 password（不泄露进 session）", () => {
    const u = authenticate("admin@x.com", "adminpw", admin);
    expect(u && "password" in u).toBe(false);
  });
});
