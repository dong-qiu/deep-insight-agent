/** Route handler test for POST /api/topics/[id]/deep-dive (C-1)。
 *  覆盖：404 不存在 / 409 disabled / 202 fire-and-forget + scheduler 被调到。 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../lib/db/index.js", () => ({
  getDb: vi.fn(() => ({})),
}));
vi.mock("../../../../../lib/db/repos.js", () => ({
  getTopic: vi.fn(),
}));
vi.mock("../../../../../lib/agents/scheduler.js", () => ({
  // 立刻 resolve 一个 fake Report，避免悬挂 Promise；fire-and-forget 路径会消费它
  runPipelineForTopic: vi.fn().mockResolvedValue({ id: "rep_fake" }),
}));
vi.mock("../../../../../lib/runtime/logger.js", () => ({
  runLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { runPipelineForTopic } from "../../../../../lib/agents/scheduler.js";
import { getTopic } from "../../../../../lib/db/repos.js";
import { POST } from "./route.js";

function call(id: string): Promise<Response> {
  return POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id }) });
}

describe("POST /api/topics/[id]/deep-dive", () => {
  it("topic 不存在 → 404", async () => {
    vi.mocked(getTopic).mockReturnValue(null);
    const res = await call("t_nope");
    expect(res.status).toBe(404);
  });

  it("topic 已停用 → 409 + 文案", async () => {
    // @ts-expect-error stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "T", enabled: false });
    const res = await call("t1");
    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: string; message: string };
    expect(j.error).toBe("topic_disabled");
    expect(j.message).toContain("启用后再深挖");
  });

  it("正常路径 → 202 + 调度 scheduler（fire-and-forget）", async () => {
    // @ts-expect-error stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "AI SWE", enabled: true });
    const res = await call("t1");
    expect(res.status).toBe(202);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.status).toBe("started");
    expect(j.topic_id).toBe("t1");
    expect(j.topic_name).toBe("AI SWE");
    expect(j.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // scheduler 被调一次（fire-and-forget，本测试 mock 故意不 resolve，不影响 response）
    expect(runPipelineForTopic).toHaveBeenCalledTimes(1);
    expect(runPipelineForTopic).toHaveBeenCalledWith(expect.anything(), "t1");
  });
});
