import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/db/index.js", () => ({ getDb: () => ({}) }));
vi.mock("../../../lib/db/repos.js", () => ({
  getSource: () => ({ id: "s1" }), getTopic: () => ({ id: "t1" }),
  updateSource: vi.fn(), updateTopic: vi.fn(),
  deleteSource: vi.fn(), deleteTopic: vi.fn(),
}));
import { deleteSource, deleteTopic } from "../../../lib/db/repos.js";
import { DELETE as deleteSourceRoute } from "./sources/[id]/route.js";
import { DELETE as deleteTopicRoute } from "./topics/[id]/route.js";

describe("admin deletion diagnostic boundary", () => {
  it.each([
    ["source", deleteSourceRoute, deleteSource],
    ["topic", deleteTopicRoute, deleteTopic],
  ] as const)("%s preserves conflict handling without exposing SQLite message", async (_kind, handler, remove) => {
    vi.mocked(remove).mockImplementationOnce(() => {
      throw Object.assign(new Error("synthetic-private-db-detail"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    });
    const res = await handler(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: "test" }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ error: "fk_constraint", message: expect.stringContaining("sqlite_constraint") });
    expect(json.message).toContain("enabled=false");
    expect(JSON.stringify(json)).not.toContain("synthetic-private");
  });
});
