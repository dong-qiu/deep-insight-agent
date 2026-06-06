/** Route handler test for POST /api/admin/sources/[id]/collect (C-3 · AC8)。 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../lib/db/index.js", () => ({
  getDb: vi.fn(() => ({})),
}));
vi.mock("../../../../../../lib/db/repos.js", () => ({
  getSource: vi.fn(),
}));
vi.mock("../../../../../../lib/agents/collector.js", () => ({
  collectSource: vi.fn(),
}));

import { collectSource } from "../../../../../../lib/agents/collector.js";
import { getSource } from "../../../../../../lib/db/repos.js";
import { POST } from "./route.js";

function call(id: string): Promise<Response> {
  return POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id }) });
}

describe("POST /api/admin/sources/[id]/collect", () => {
  it("不存在的源 → 404", async () => {
    vi.mocked(getSource).mockReturnValue(null);
    const res = await call("s_nope");
    expect(res.status).toBe(404);
  });

  it("已停用 → 409 + 文案", async () => {
    // @ts-expect-error stub
    vi.mocked(getSource).mockReturnValue({ id: "s1", name: "x", enabled: false });
    const res = await call("s1");
    expect(res.status).toBe(409);
    const j = (await res.json()) as { message: string };
    expect(j.message).toContain("启用后再抓取");
  });

  it("成功 → 200 + 抓取计数", async () => {
    // @ts-expect-error stub
    vi.mocked(getSource).mockReturnValue({ id: "s1", name: "x", enabled: true });
    vi.mocked(collectSource).mockResolvedValue({
      runId: "run_new", fetched: 10, inserted: 7, updated: 2, skipped: 1,
    });
    const res = await call("s1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "done", run_id: "run_new", fetched: 10, inserted: 7, updated: 2, skipped: 1,
    });
  });

  it("collectSource 抛错 → 502", async () => {
    // @ts-expect-error stub
    vi.mocked(getSource).mockReturnValue({ id: "s1", name: "x", enabled: true });
    vi.mocked(collectSource).mockRejectedValue(new Error("rss 5xx"));
    const res = await call("s1");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("rss 5xx");
  });
});
