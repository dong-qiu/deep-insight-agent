/** Route handler test for POST /api/admin/sources/[id]/collect (C-3 · AC8)。 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../lib/db/index.js", () => ({
  getDb: vi.fn(() => ({})),
}));
vi.mock("../../../../../../lib/db/repos.js", () => ({
  getSource: vi.fn(),
  hasRunningRun: vi.fn(() => false),
}));
vi.mock("../../../../../../lib/agents/collector.js", () => ({
  // 立刻 resolve 一个 fake 结果（fire-and-forget 路径 .then 会消费它）
  collectSource: vi.fn().mockResolvedValue({ runId: "run_fake", fetched: 5, inserted: 3, updated: 1, skipped: 1 }),
}));
vi.mock("../../../../../../lib/runtime/logger.js", () => ({
  runLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { collectSource } from "../../../../../../lib/agents/collector.js";
import { getSource, hasRunningRun } from "../../../../../../lib/db/repos.js";
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

  it("已有 running ingest Run → 409 already_running（防并发 review #2）", async () => {
    // @ts-expect-error stub
    vi.mocked(getSource).mockReturnValue({ id: "s1", name: "x", enabled: true });
    vi.mocked(hasRunningRun).mockReturnValueOnce(true);
    const res = await call("s1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_running");
    expect(collectSource).not.toHaveBeenCalled();
  });

  it("正常路径 → 202 fire-and-forget（review #3 改造）+ 调度 collectSource", async () => {
    // @ts-expect-error stub
    vi.mocked(getSource).mockReturnValue({ id: "s1", name: "ArXiv", enabled: true });
    const res = await call("s1");
    expect(res.status).toBe(202);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.status).toBe("started");
    expect(j.source_id).toBe("s1");
    expect(j.source_name).toBe("ArXiv");
    expect(j.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(collectSource).toHaveBeenCalledTimes(1);
  });
});
