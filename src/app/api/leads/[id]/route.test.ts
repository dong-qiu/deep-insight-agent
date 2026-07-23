import { beforeEach, describe, expect, it, vi } from "vitest";

const { deniedMock, getMock, evidenceMock, setMock, auditMock } = vi.hoisted(() => ({
  deniedMock: vi.fn(), getMock: vi.fn(), evidenceMock: vi.fn(), setMock: vi.fn(), auditMock: vi.fn(),
}));
vi.mock("../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: deniedMock }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../lib/db/audit.js", () => ({ appendAudit: auditMock }));
vi.mock("../../../../lib/db/tech-leads.js", () => ({ getTechLead: getMock, listTechLeadEvidence: evidenceMock, setTechLeadStatus: setMock }));
import { GET, POST } from "./route.js";

const ctx = { params: Promise.resolve({ id: "lead_1" }) };
beforeEach(() => { deniedMock.mockReset().mockResolvedValue(null); getMock.mockReset(); evidenceMock.mockReset(); setMock.mockReset(); auditMock.mockReset(); });

describe("/api/leads/[id]", () => {
  it("GET 返回线索及其可溯源证据", async () => {
    getMock.mockReturnValue({ id: "lead_1" }); evidenceMock.mockReturnValue([{ quote: "q" }]);
    expect(await (await GET(new Request("http://x"), ctx)).json()).toEqual({ lead: { id: "lead_1" }, evidence: [{ quote: "q" }] });
  });
  it("POST 需要 admin 且仅接受白名单状态", async () => {
    deniedMock.mockResolvedValue(new Response("no", { status: 403 }));
    expect((await POST(new Request("http://x", { method: "POST", body: "{}" }), ctx)).status).toBe(403);
    deniedMock.mockResolvedValue(null);
    expect((await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ status: "bad" }) }), ctx)).status).toBe(400);
    setMock.mockReturnValue(true);
    expect((await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ status: "watching" }) }), ctx)).status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith({}, expect.objectContaining({ action: "tech_lead_status", target: "lead_1" }));
  });
});
