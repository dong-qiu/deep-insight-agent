/** Route handler test for POST /api/admin/runs/[id]/retry (B-4)。
 *  覆盖：404 不存在 / 409 非 failed / kind=ingest 成功路径 / kind=ingest 源已删 / 非 ingest kind 返 501。 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../lib/db/index.js", () => ({
  getDb: vi.fn(() => ({})),
}));
vi.mock("../../../../../../lib/db/repos.js", () => ({
  getRun: vi.fn(),
  getSource: vi.fn(),
}));
vi.mock("../../../../../../lib/agents/collector.js", () => ({
  collectSource: vi.fn(),
}));

import { collectSource } from "../../../../../../lib/agents/collector.js";
import { getRun, getSource } from "../../../../../../lib/db/repos.js";
import { POST } from "./route.js";

function call(id: string): Promise<Response> {
  return POST(new Request("http://x/", { method: "POST" }), { params: Promise.resolve({ id }) });
}

describe("POST /api/admin/runs/[id]/retry", () => {
  it("不存在的 Run → 404", async () => {
    vi.mocked(getRun).mockReturnValue(null);
    const res = await call("run_nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run_not_found" });
  });

  it("status=done → 409 不可重试", async () => {
    // @ts-expect-error 测试 stub
    vi.mocked(getRun).mockReturnValue({ id: "r1", kind: "ingest", target: {}, status: "done" });
    const res = await call("r1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_failed");
  });

  it("kind=ingest 失败 → 调 collectSource、返新 run id + 计数", async () => {
    // @ts-expect-error 测试 stub
    vi.mocked(getRun).mockReturnValue({ id: "r1", kind: "ingest", target: { source_id: "s1" }, status: "failed" });
    // @ts-expect-error stub
    vi.mocked(getSource).mockReturnValue({ id: "s1", name: "x" });
    vi.mocked(collectSource).mockResolvedValue({
      runId: "run_new", fetched: 10, inserted: 3, updated: 1, skipped: 6,
    });
    const res = await call("r1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done", new_run_id: "run_new", inserted: 3 });
  });

  it("kind=ingest + source 已删 → 410", async () => {
    // @ts-expect-error 测试 stub
    vi.mocked(getRun).mockReturnValue({ id: "r1", kind: "ingest", target: { source_id: "s_gone" }, status: "failed" });
    vi.mocked(getSource).mockReturnValue(null);
    const res = await call("r1");
    expect(res.status).toBe(410);
  });

  it("kind=analyze → 501 + 文案", async () => {
    // @ts-expect-error 测试 stub
    vi.mocked(getRun).mockReturnValue({ id: "r1", kind: "analyze", target: { topic_id: "t1" }, status: "failed" });
    const res = await call("r1");
    expect(res.status).toBe(501);
    const j = await res.json();
    expect(j.error).toBe("kind_not_retryable_alone");
    expect(j.message).toContain("/api/cron");
  });

  it("collectSource 抛错 → 502 + error 字符串", async () => {
    // @ts-expect-error 测试 stub
    vi.mocked(getRun).mockReturnValue({ id: "r1", kind: "ingest", target: { source_id: "s1" }, status: "failed" });
    // @ts-expect-error stub
    vi.mocked(getSource).mockReturnValue({ id: "s1", name: "x" });
    vi.mocked(collectSource).mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    const res = await call("r1");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("ECONNRESET");
  });
});
