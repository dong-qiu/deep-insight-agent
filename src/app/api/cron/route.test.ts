/** POST /api/cron 的模式分流：collect 只能采集，不得误触发分析/出刊。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { collectionMock, pipelineMock, integrityMock, anchorMock, enabledMock, recoverMock } = vi.hoisted(() => ({
  collectionMock: vi.fn(), pipelineMock: vi.fn(), integrityMock: vi.fn(), anchorMock: vi.fn(), enabledMock: vi.fn(), recoverMock: vi.fn(),
}));
vi.mock("../../../lib/agents/scheduler.js", () => ({
  runCollectionCycle: collectionMock,
  runScheduledPipeline: pipelineMock,
}));
vi.mock("../../../lib/db/integrity-publication.js", () => ({ runIntegrityMaintenance: integrityMock }));
vi.mock("../../../lib/runtime/integrity-anchor-runtime.js", () => ({ deploymentAnchorPublication: anchorMock, integrityAnchorEnabled: enabledMock }));
vi.mock("../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("../../../lib/db/repos.js", () => ({ recoverOrphanedRuns: recoverMock }));
vi.mock("../../../lib/runtime/logger.js", () => ({
  runLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })),
}));

import { POST } from "./route.js";

function call(mode?: string, auth = true): Promise<Response> {
  const url = `http://x/api/cron${mode ? `?mode=${mode}` : ""}`;
  return POST(new Request(url, { method: "POST", headers: auth ? { authorization: "Bearer test-secret" } : {} }));
}

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  collectionMock.mockReset().mockResolvedValue({ collected: [], errors: [] });
  pipelineMock.mockReset().mockResolvedValue({ topics: [], errors: [] });
  integrityMock.mockReset().mockResolvedValue({ skipped: false, reconciliation: { committed: 0, failed: 0 }, daily: "skipped", checks: { checked: 0, passed: 0, failed: 0 } });
  anchorMock.mockReset().mockReturnValue({ store: {}, signer: {}, retainUntil: "2027-01-01T00:00:00Z" });
  enabledMock.mockReset().mockReturnValue(true);
  recoverMock.mockReset().mockReturnValue(0);
});
afterEach(() => { delete process.env.CRON_SECRET; });

describe("POST /api/cron", () => {
  it("mode=collect 仅运行采集周期", async () => {
    const res = await call("collect");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "collect" });
    expect(collectionMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("默认仍运行完整日报管线", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "pipeline" });
    expect(pipelineMock).toHaveBeenCalledWith({ db: true }, {});
    expect(collectionMock).not.toHaveBeenCalled();
  });

  it("mode=integrity 独立运行维护，不触发采集或报告管线", async () => {
    const res = await call("integrity");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "integrity" });
    expect(integrityMock).toHaveBeenCalledWith({ db: true }, { store: {}, signer: {}, retainUntil: "2027-01-01T00:00:00Z" });
    expect(collectionMock).not.toHaveBeenCalled();
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("P1 锚定未启用时 integrity cron 成功跳过，不影响 P0 报告调度", async () => {
    enabledMock.mockReturnValue(false);
    const res = await call("integrity");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "integrity", summary: { skipped: true, reason: "integrity_anchor_disabled" } });
    expect(integrityMock).not.toHaveBeenCalled();
    expect(anchorMock).not.toHaveBeenCalled();
  });

  it("非法模式与未鉴权请求在执行前被拒绝", async () => {
    expect((await call("other")).status).toBe(400);
    expect((await call("collect", false)).status).toBe(401);
    expect(collectionMock).not.toHaveBeenCalled();
    expect(pipelineMock).not.toHaveBeenCalled();
  });
});
