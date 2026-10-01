import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TechLeadEvidence } from "../../../lib/types.js";
import { OpportunityEvidence, summarizeOpportunityEvidence } from "./opportunity-evidence.js";

const evidence = (overrides: Partial<TechLeadEvidence> = {}): TechLeadEvidence => ({
  lead_id: "lead-1", insight_id: "insight-1", citation_index: 0,
  source_name: "arXiv", url: "https://arxiv.org/abs/1234", quote: "Audited original quote.",
  observed_at: "2026-09-24T17:53:35Z", ...overrides,
});

describe("opportunity evidence display", () => {
  it("shows one excerpt and one source page for two audited references to the same original", () => {
    const rows = [evidence(), evidence({ insight_id: "insight-2" })];
    const summary = summarizeOpportunityEvidence(rows);
    expect(summary).toMatchObject({ citationCount: 2, sourcePageCount: 1 });
    expect(summary.excerpts).toHaveLength(1);
    expect(summary.excerpts[0]?.citationCount).toBe(2);
    const html = renderToStaticMarkup(<OpportunityEvidence evidence={rows} />);
    expect(html).toContain("1 个来源页面 · 1 段原文 · 2 条引用记录");
    expect(html).toContain("同一原文关联 2 条引用记录");
    expect(html.match(/Audited original quote\./g)).toHaveLength(1);
  });

  it("keeps distinct source pages and distinct quotes separate", () => {
    const rows = [
      evidence(),
      evidence({ insight_id: "insight-2", url: "https://example.org/other" }),
      evidence({ insight_id: "insight-3", quote: "Different audited quote." }),
    ];
    const summary = summarizeOpportunityEvidence(rows);
    expect(summary).toMatchObject({ citationCount: 3, sourcePageCount: 2 });
    expect(summary.excerpts).toHaveLength(3);
    const html = renderToStaticMarkup(<OpportunityEvidence evidence={rows} />);
    expect(html).toContain("2 个来源页面 · 3 段原文 · 3 条引用记录");
    expect(html.match(/Audited original quote\./g)).toHaveLength(2);
    expect(html).toContain("Different audited quote.");
  });

  it("does not mutate the audited input rows", () => {
    const rows = [evidence(), evidence({ insight_id: "insight-2" })];
    summarizeOpportunityEvidence(rows);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.insight_id).toBe("insight-1");
    expect(rows[1]?.insight_id).toBe("insight-2");
  });
});
