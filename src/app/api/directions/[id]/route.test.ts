import { describe, expect, it, vi } from "vitest";

const { db, audit } = vi.hoisted(() => ({ db: {}, audit: vi.fn() }));
vi.mock("../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: () => db }));
vi.mock("../../../../lib/db/audit.js", () => ({ appendAudit: audit }));
vi.mock("../../../../lib/db/planning.js", () => ({ getTopicDirection: vi.fn(), setTopicDirectionStatus: vi.fn(), updateTopicDirection: vi.fn() }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { getTopicDirection, updateTopicDirection } from "../../../../lib/db/planning.js";
import type { TopicDirection } from "../../../../lib/types.js";
import { PUT } from "./route.js";

const direction: TopicDirection = { id: "d1", topic_id: "t1", name: "D", objective: "O", problem_statement: "P", in_scope: [], out_of_scope: [], key_questions: [], constraints: [], success_signals: [], match_terms: ["x"], adjacent_terms: [], challenge_terms: [], horizon: "now", status: "active", version: 1, created_at: "x", updated_at: "x" };
const call = (body: unknown) => PUT(new Request("http://x/api/directions/d1", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "d1" }) });

describe("PUT /api/directions/:id", () => {
  it("非管理员被二道闸拦下", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await call({ direction, expected_version: 1 })).status).toBe(403);
  });
  it("版本冲突返回当前版本，避免静默覆盖", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(getTopicDirection).mockReturnValueOnce(direction);
    vi.mocked(updateTopicDirection).mockReturnValueOnce({ kind: "conflict", current: { ...direction, version: 2 } });
    const res = await call({ direction, expected_version: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).current.version).toBe(2);
  });
  it("更新词表写入审计记录", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(getTopicDirection).mockReturnValueOnce(direction);
    vi.mocked(updateTopicDirection).mockReturnValueOnce({ kind: "updated", direction: { ...direction, version: 2 } });
    expect((await call({ direction: { ...direction, match_terms: ["new"] }, expected_version: 1 })).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(db, expect.objectContaining({ action: "topic_direction_update", detail: expect.objectContaining({ rules_changed: true }) }));
  });
});
