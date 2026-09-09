import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  data: vi.fn(),
  topics: vi.fn(),
  force: vi.fn<(props: unknown) => null>(() => null),
  db: {},
}));

vi.mock("../../lib/db/graph.js", () => ({ buildTopicGraphData: mocks.data }));
vi.mock("../../lib/db/index.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../lib/db/repos.js", () => ({ listTopics: mocks.topics }));
vi.mock("./_components/force-graph.js", () => ({
  ForceGraph: (props: unknown) => {
    mocks.force(props);
    return null;
  },
}));

import GraphPage from "./page.js";

describe("GraphPage reader projection", () => {
  beforeEach(() => {
    mocks.force.mockClear();
    mocks.topics.mockReturnValue([{ id: "t1", name: "Topic" }]);
    mocks.data.mockReturnValue({
      nodes: [{ name: "OpenAI", mentions: 2, type: "organization" }],
      candidateEdges: [{ a: "OpenAI", b: "Cursor", weight: 2, strength: 1 }],
      insightCount: 1, withEntities: 1, maxEdges: 40, suggestedMinWeight: 1, maxWeight: 2,
    });
  });

  it("does not serialize LLM entity type to the client graph", async () => {
    renderToStaticMarkup(await GraphPage({ searchParams: Promise.resolve({ topic: "t1" }) }));
    expect(mocks.force).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nodes: [{ name: "OpenAI", mentions: 2 }] }),
    }));
    const props = mocks.force.mock.calls[0]?.[0] as unknown as { data: { nodes: unknown[] } };
    expect(props.data.nodes[0]).not.toHaveProperty("type");
  });
});
