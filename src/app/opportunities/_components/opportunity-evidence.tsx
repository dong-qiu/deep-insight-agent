import type { TechLeadEvidence } from "../../../lib/types.js";

interface EvidenceExcerpt {
  evidence: TechLeadEvidence;
  citationCount: number;
}

/** Group only reader-visible citation rows; never use this display grouping as a validation gate. */
export function summarizeOpportunityEvidence(evidence: TechLeadEvidence[]): {
  citationCount: number;
  sourcePageCount: number;
  excerpts: EvidenceExcerpt[];
} {
  const sourcePages = new Set<string>();
  const excerpts = new Map<string, EvidenceExcerpt>();
  for (const item of evidence) {
    sourcePages.add(item.url);
    const key = JSON.stringify([item.url, item.quote]);
    const existing = excerpts.get(key);
    if (existing) existing.citationCount += 1;
    else excerpts.set(key, { evidence: item, citationCount: 1 });
  }
  return { citationCount: evidence.length, sourcePageCount: sourcePages.size, excerpts: [...excerpts.values()] };
}

export function OpportunityEvidence({ evidence }: { evidence: TechLeadEvidence[] }): React.ReactElement {
  const summary = summarizeOpportunityEvidence(evidence);
  return <details>
    <summary>可追溯事实证据（{summary.sourcePageCount} 个来源页面 · {summary.excerpts.length} 段原文 · {summary.citationCount} 条引用记录）</summary>
    <ul>{summary.excerpts.map(({ evidence: item, citationCount }) => <li key={JSON.stringify([item.url, item.quote])}>
      <a href={item.url} target="_blank" rel="noreferrer">{item.source_name}</a> · {item.observed_at.slice(0, 10)}
      {citationCount > 1 ? <> · 同一原文关联 {citationCount} 条引用记录</> : null}<br />「{item.quote}」
    </li>)}</ul>
  </details>;
}
