/** Route test：直接调 GET/POST/DELETE，注入内存 DB + mock 二道闸。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testDb: import("../../../../lib/db/index.js").DB;
// 保留真 openDb，只把 getDb 指到内存库
vi.mock("../../../../lib/db/index.js", async (orig) => {
  const actual = await orig<typeof import("../../../../lib/db/index.js")>();
  return { ...actual, getDb: () => testDb };
});
// 二道闸 mock：默认放行（admin）；403 短路单独测
vi.mock("../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { openDb } from "../../../../lib/db/index.js";
import { listUsers } from "../../../../lib/db/users.js";
import { DELETE, GET, POST } from "./route.js";

const post = (b: unknown) => POST(new Request("http://x/api/admin/users", { method: "POST", body: JSON.stringify(b) }));
const del = (email: string) => DELETE(new Request(`http://x/api/admin/users?email=${encodeURIComponent(email)}`, { method: "DELETE" }));

beforeEach(() => { testDb = openDb(":memory:"); });
afterEach(() => { vi.mocked(forbidNonAdmin).mockReset(); delete process.env.ADMIN_EMAIL; });

describe("/api/admin/users", () => {
  it("非 admin（二道闸 403）→ GET/POST/DELETE 全 403、不改库", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await GET()).status).toBe(403);
    expect((await post({ email: "v@x.com", password: "secret1", role: "viewer" })).status).toBe(403);
    expect((await del("v@x.com")).status).toBe(403);
    expect(listUsers(testDb)).toHaveLength(0);
  });

  it("POST 合法 → 201、GET 能列出", async () => {
    expect((await post({ email: "v@x.com", password: "secret1", role: "viewer" })).status).toBe(201);
    const res = await GET();
    const { users } = (await res.json()) as { users: { email: string; role: string }[] };
    expect(users).toEqual([expect.objectContaining({ email: "v@x.com", role: "viewer" })]);
  });

  it("POST 邮箱非法 / 密码太短 → 422", async () => {
    expect((await post({ email: "notanemail", password: "secret1" })).status).toBe(422);
    expect((await post({ email: "v@x.com", password: "123" })).status).toBe(422);
  });

  it("POST 与内置 admin 同邮箱 → 409（大小写不敏感，S1）", async () => {
    process.env.ADMIN_EMAIL = "admin@x.com";
    expect((await post({ email: "admin@x.com", password: "secret1" })).status).toBe(409);
    expect((await post({ email: "Admin@X.com", password: "secret1" })).status).toBe(409); // 变体也挡
  });

  it("受邀账号一律 viewer——即便请求 role:admin 也落 viewer（S2）", async () => {
    await post({ email: "v@x.com", password: "secret1", role: "admin" }); // 请求 admin
    expect(listUsers(testDb)[0].role).toBe("viewer"); // 仍 viewer
  });

  it("邮箱大小写归一：Mixed@X.com 与 mixed@x.com 视为同一账号", async () => {
    await post({ email: "Mixed@X.com", password: "secret1" });
    const rows = listUsers(testDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("mixed@x.com"); // 入库已小写
    expect((await del("MIXED@x.COM")).status).toBe(200); // 变体也能删到
  });

  it("DELETE 存在 → 200 + 移除；不存在 → 404", async () => {
    await post({ email: "v@x.com", password: "secret1", role: "viewer" });
    expect((await del("v@x.com")).status).toBe(200);
    expect(listUsers(testDb)).toHaveLength(0);
    expect((await del("ghost@x.com")).status).toBe(404);
  });
});
