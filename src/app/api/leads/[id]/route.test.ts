import { beforeEach, describe, expect, it, vi } from "vitest";

const { actor, get, evidence, set, record } = vi.hoisted(() => ({ actor: vi.fn(), get: vi.fn(), evidence: vi.fn(), set: vi.fn(), record: vi.fn() }));
vi.mock("../../../../lib/auth-guard.js", () => ({ requireAdminActor: actor }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../lib/db/provenance.js", () => ({ hashIdempotencyKey: vi.fn(() => "hash"), recordManualDecision: record }));
vi.mock("../../../../lib/db/provenance-revisions.js", () => ({ techLeadRef: vi.fn(() => ({})), techLeadRevisionSnapshot: vi.fn(() => ({})) }));
vi.mock("../../../../lib/db/tech-leads.js", () => ({ getTechLead: get, listTechLeadEvidence: evidence, setTechLeadStatus: set }));
import { GET, POST } from "./route.js";

const lead = { id: "lead_1", topic_id: "t1", canonical_key: "k", kind: "tool", title: "T", summary: "S", status: "recommended", score: 1, score_detail: { freshness: 1, evidence: 1, importance: 1, relevance: 1, total: 1, reason: "r" }, first_seen_at: "x", last_seen_at: "x", latest_evidence_at: "x" } as const;
const ctx = { params: Promise.resolve({ id: "lead_1" }) };
const call = (body: unknown, key = "abcdefgh") => POST(new Request("http://x", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) }), ctx);
beforeEach(() => { process.env.AUTH_SECRET = "test-secret"; actor.mockReset().mockResolvedValue({ id: "u1", role: "admin" }); get.mockReset().mockReturnValue(lead); evidence.mockReset(); set.mockReset(); record.mockReset().mockReturnValue({ kind: "accepted", traceId: "trace_1", requestId: "req_1" }); });

describe("/api/leads/[id]", () => {
  it("GET 返回线索及其可追溯证据", async () => {
    evidence.mockReturnValue([{ quote: "q" }]);
    expect(await (await GET(new Request("http://x"), ctx)).json()).toEqual({ lead, evidence: [{ quote: "q" }] });
  });
  it("POST 需要可信 admin、合法幂等键并登记人工 Trace", async () => {
    actor.mockResolvedValueOnce(null);
    expect((await call({ status: "watching" })).status).toBe(403);
    expect((await call({ status: "bad" })).status).toBe(400);
    expect((await call({ status: "watching" }, "short")).status).toBe(400);
    expect((await call({ status: "watching" })).status).toBe(200);
    expect(record).toHaveBeenCalledWith({}, expect.objectContaining({ action: "tech_lead_status", actorId: "u1", idempotencyKeyHash: "hash" }));
  });
});
