import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, actor, get, update, record } = vi.hoisted(() => ({ db: {}, actor: vi.fn(), get: vi.fn(), update: vi.fn(), record: vi.fn() }));
vi.mock("../../../../lib/auth-guard.js", () => ({ requireAdminActor: actor }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: () => db }));
vi.mock("../../../../lib/db/provenance.js", () => ({ hashIdempotencyKey: vi.fn(() => "hash"), recordManualDecision: record }));
vi.mock("../../../../lib/db/provenance-revisions.js", () => ({ topicDirectionRef: vi.fn(() => ({})), topicDirectionRevisionSnapshot: vi.fn(() => ({})) }));
vi.mock("../../../../lib/db/planning.js", () => ({ getTopicDirection: get, setTopicDirectionStatus: vi.fn(), updateTopicDirection: update }));
import type { TopicDirection } from "../../../../lib/types.js";
import { PUT } from "./route.js";

const direction: TopicDirection = { id: "d1", topic_id: "t1", name: "D", objective: "O", problem_statement: "P", in_scope: [], out_of_scope: [], key_questions: [], constraints: [], success_signals: [], match_terms: ["x"], adjacent_terms: [], challenge_terms: [], horizon: "now", status: "active", version: 1, created_at: "x", updated_at: "x" };
const call = (body: unknown, key = "abcdefgh") => PUT(new Request("http://x/api/directions/d1", { method: "PUT", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "d1" }) });
beforeEach(() => { process.env.AUTH_SECRET = "test-secret"; actor.mockReset().mockResolvedValue({ id: "u1", role: "admin" }); get.mockReset().mockReturnValue(direction); update.mockReset(); record.mockReset().mockReturnValue({ kind: "accepted", traceId: "trace_1", requestId: "req_1" }); });

describe("PUT /api/directions/:id", () => {
  it("非管理员被二道闸拦下", async () => {
    actor.mockResolvedValueOnce(null);
    expect((await call({ direction, expected_version: 1 })).status).toBe(403);
  });
  it("缺少有效 Idempotency-Key 时拒绝", async () => {
    expect((await call({ direction, expected_version: 1 }, "short")).status).toBe(400);
  });
  it("更新词表登记方向变更 Trace", async () => {
    expect((await call({ direction: { ...direction, match_terms: ["new"] }, expected_version: 1 })).status).toBe(200);
    expect(record).toHaveBeenCalledWith(db, expect.objectContaining({ action: "topic_direction_update", actorId: "u1", terminalEvent: "config_changed" }));
  });
});
