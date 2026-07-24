import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));

import { auth } from "../auth.js";
import { forbidNonAdmin } from "./auth-guard.js";

afterEach(() => vi.mocked(auth).mockReset());

describe("forbidNonAdmin（二道鉴权闸）", () => {
  it("admin → 放行", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as never);

    await expect(forbidNonAdmin()).resolves.toBeNull();
  });

  it.each(["viewer", undefined])("角色为 %s → 403", async (role) => {
    vi.mocked(auth).mockResolvedValue(role ? ({ user: { role } } as never) : (null as never));

    const response = await forbidNonAdmin();
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: "forbidden" });
  });
});
