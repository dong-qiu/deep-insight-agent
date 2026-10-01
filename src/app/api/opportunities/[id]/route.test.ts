import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, actor, opportunity, leads, evidence, readerContext, set, record } = vi.hoisted(() => ({
  db: {}, actor: vi.fn(), opportunity: vi.fn(), leads: vi.fn(), evidence: vi.fn(),
  readerContext: { preload: vi.fn(), accepts: vi.fn() }, set: vi.fn(), record: vi.fn(),
}));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: () => db }));
vi.mock("../../../../lib/db/reader-evidence.js", () => ({ createReaderEvidenceContext: vi.fn(() => readerContext) }));
vi.mock("../../../../lib/auth-guard.js", () => ({ requireAdminActor: actor }));
vi.mock("../../../../lib/db/provenance.js", () => ({ hashIdempotencyKey: vi.fn(() => "hash"), recordManualDecision: record }));
vi.mock("../../../../lib/db/provenance-revisions.js", () => ({ technologyOpportunityRef: vi.fn(() => ({})), technologyOpportunityRevisionSnapshot: vi.fn(() => ({})) }));
vi.mock("../../../../lib/db/planning.js", () => ({ getTechnologyOpportunity: opportunity, listOpportunityLeads: leads, setTechnologyOpportunityStatus: set }));
vi.mock("../../../../lib/db/tech-leads.js", () => ({ listTechLeadEvidence: evidence }));
import { GET, POST } from "./route.js";

const item = { id: "o1", topic_id: "t1", direction_id: null, canonical_key: "k", lane: "horizon", planning_effect: "new_direction", title: "T", hypothesis: "H", proposed_validation: "V", uncertainties: [], status: "observed", mapping_state: "current", mapping_direction_version: null, priority_score: 1, score_detail: { alignment: 1, evidence: 1, leverage: 1, verifiability: 1, timing: 1, total: 1, reason: "r" }, first_seen_at: "x", last_seen_at: "x", latest_evidence_at: "x" } as const;
const call = (body: unknown, key = "abcdefgh") => POST(new Request("http://x/api/opportunities/o1", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "o1" }) });
beforeEach(() => { process.env.AUTH_SECRET = "test-secret"; actor.mockReset().mockResolvedValue({ id: "u1", role: "admin" }); opportunity.mockReset().mockReturnValue(item); leads.mockReset().mockReturnValue([]); evidence.mockReset().mockReturnValue([]); set.mockReset(); record.mockReset().mockReturnValue({ kind: "accepted", traceId: "trace_1", requestId: "req_1" }); });

describe("GET /api/opportunities/:id", () => {
  it("returns 404 when the current evidence gate hides the opportunity", async () => {
    opportunity.mockReturnValueOnce(null);
    expect((await GET(new Request("http://x/api/opportunities/o1"), { params: Promise.resolve({ id: "o1" }) })).status).toBe(404);
    expect(leads).not.toHaveBeenCalled();
  });
  it("reuses one reader evidence context for opportunity, leads and their evidence", async () => {
    const lead = { id: "lead_1", title: "已核验技术线索" };
    leads.mockReturnValueOnce([lead]);
    evidence.mockReturnValueOnce([{ quote: "bound source quote" }]);
    const response = await GET(new Request("http://x/api/opportunities/o1"), { params: Promise.resolve({ id: "o1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ opportunity: item, leads: [{ ...lead, evidence: [{ quote: "bound source quote" }] }] });
    expect(opportunity).toHaveBeenCalledWith(db, "o1", readerContext);
    expect(leads).toHaveBeenCalledWith(db, "o1", readerContext);
    expect(evidence).toHaveBeenCalledWith(db, "lead_1", readerContext);
  });
});

describe("POST /api/opportunities/:id", () => {
  it("非管理员被二道闸拦下，不改状态", async () => {
    actor.mockResolvedValueOnce(null);
    expect((await call({ status: "research_candidate" })).status).toBe(403);
    expect(set).not.toHaveBeenCalled();
  });
  it("非法状态与无效幂等键拒绝", async () => {
    expect((await call({ status: "approved" })).status).toBe(400);
    expect((await call({ status: "watching" }, "short")).status).toBe(400);
  });
  it("管理员状态决策登记可信 actor 的 Trace", async () => {
    expect((await call({ status: "research_candidate" })).status).toBe(200);
    expect(record).toHaveBeenCalledWith(db, expect.objectContaining({ action: "technology_opportunity_status", actorId: "u1" }));
  });
  it("不存在机会返回 404", async () => {
    opportunity.mockReturnValueOnce(null);
    expect((await call({ status: "watching" })).status).toBe(404);
  });
});
