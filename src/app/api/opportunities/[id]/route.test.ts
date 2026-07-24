import { describe, expect, it, vi } from "vitest";

const { db, audit } = vi.hoisted(() => ({ db: {}, audit: vi.fn() }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: () => db }));
vi.mock("../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));
vi.mock("../../../../lib/db/audit.js", () => ({ appendAudit: audit }));
vi.mock("../../../../lib/db/planning.js", () => ({
  getTechnologyOpportunity: vi.fn(), listOpportunityLeads: vi.fn(), setTechnologyOpportunityStatus: vi.fn(),
}));
vi.mock("../../../../lib/db/tech-leads.js", () => ({ listTechLeadEvidence: vi.fn(() => []) }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { getTechnologyOpportunity, setTechnologyOpportunityStatus } from "../../../../lib/db/planning.js";
import { POST } from "./route.js";

const call = (body: unknown) => POST(new Request("http://x/api/opportunities/o1", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "o1" }) });

describe("POST /api/opportunities/:id", () => {
  it("非管理员被二道闸拦下，不改状态", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await call({ status: "research_candidate" })).status).toBe(403);
    expect(setTechnologyOpportunityStatus).not.toHaveBeenCalled();
  });

  it("非法状态拒绝", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    expect((await call({ status: "approved" })).status).toBe(400);
  });

  it("管理员状态决策写审计日志", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(setTechnologyOpportunityStatus).mockReturnValueOnce(true);
    const res = await call({ status: "research_candidate" });
    expect(res.status).toBe(200);
    expect(setTechnologyOpportunityStatus).toHaveBeenCalledWith(db, "o1", "research_candidate");
    expect(audit).toHaveBeenCalledWith(db, expect.objectContaining({ action: "technology_opportunity_status", target: "o1" }));
  });

  it("不存在机会返回 404", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(setTechnologyOpportunityStatus).mockReturnValueOnce(false);
    expect((await call({ status: "watching" })).status).toBe(404);
    expect(getTechnologyOpportunity).not.toHaveBeenCalled();
  });
});
