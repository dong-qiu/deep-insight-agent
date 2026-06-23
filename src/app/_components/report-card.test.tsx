/** ReportCard 单测：渲染逻辑用 renderToStaticMarkup，无需 DOM。
 *  覆盖 #57 标题去尾缀 + 本次去重（实体 chip 与 highlights 重复则丢 / 已筛选维度抑制）。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReportIndexEntry } from "../../lib/types.js";
import { ReportCard, type CardOmit } from "./report-card.js";

function entry(over: Partial<ReportIndexEntry> = {}): ReportIndexEntry {
  return {
    report_id: "r1",
    type: "brief",
    topic_id: "t1",
    facets: ["domain:ai-swe"],
    date: "2026-06-18",
    source_ids: [],
    title: "AI 时代的软件工程 · 今日 Brief · 2026-06-18",
    summary: "摘要文本",
    highlights: ["Anthropic 撤回 Fable 5 静默削弱策略"],
    tags: ["model-governance"],
    entity_names: ["Anthropic", "Claude Fable 5", "Cursor"],
    importance: 4,
    event_ids: [],
    milestone_count: 0,
    ...over,
  };
}

function html(e: ReportIndexEntry, opts: { showTypeLabel?: boolean; omit?: CardOmit } = {}): string {
  return renderToStaticMarkup(
    <ReportCard entry={e} showTypeLabel={opts.showTypeLabel} omit={opts.omit} />,
  );
}

describe("ReportCard 标题去尾缀（#57）", () => {
  it("剥掉 ` · 类型 · 日期` 只留主题名", () => {
    expect(html(entry())).toContain(">AI 时代的软件工程</a>");
    expect(html(entry())).not.toContain("今日 Brief · 2026-06-18");
  });

  it("模板不匹配的旧标题原样保留", () => {
    const h = html(entry({ title: "自定义老标题（无尾缀）" }));
    expect(h).toContain(">自定义老标题（无尾缀）</a>");
  });
});

describe("ReportCard 实体 chip 去重", () => {
  it("全名已出现在 highlights 里的实体被丢弃，其余保留", () => {
    const h = html(entry()); // highlights = "Anthropic 撤回 Fable 5 静默削弱策略"
    expect(h).not.toContain(">Anthropic</span>"); // 全名 "Anthropic" 出现 → 丢弃
    expect(h).toContain(">Claude Fable 5</span>"); // 全名未逐字出现（仅 "Fable 5"）→ 保守保留
    expect(h).toContain(">Cursor</span>"); // 未出现 → 保留
  });

  it("多词全名逐字命中时也丢弃", () => {
    const h = html(entry({ highlights: ["Claude Fable 5 实测强但昂贵"] }));
    expect(h).not.toContain(">Claude Fable 5</span>"); // 全名逐字出现 → 丢弃
  });

  it("highlights 为空时回退按 summary 去重", () => {
    const h = html(entry({ highlights: [], summary: "本期聚焦 Cursor 的发布" }));
    expect(h).not.toContain(">Cursor</span>"); // summary 命中
    expect(h).toContain(">Anthropic</span>"); // summary 未命中 → 保留
  });

  it("单字实体不参与去重（防误命中），≥2 字才参与", () => {
    // 单字 "X"：不参与子串去重，即便正文含 "X" 也保留
    const h1 = html(entry({ highlights: ["X 公司发布新品"], entity_names: ["X"] }));
    expect(h1).toContain(">X</span>");
    // "AI"（length===2）：参与去重，正文含 "ai" → 丢弃（验证 <2 边界确实只挡单字）
    const h2 = html(entry({ highlights: ["关于 AI 的讨论"], entity_names: ["AI"] }));
    expect(h2).not.toContain(">AI</span>");
  });
});

describe("ReportCard 已筛选维度抑制", () => {
  it("报告库默认 meta 含 类型 · 领域 · 日期（domain 标签）", () => {
    const h = html(entry(), { showTypeLabel: true });
    expect(h).toContain("今日 Brief · AI 软件工程 · 2026-06-18");
  });

  it("omit.type 时 meta 不含类型", () => {
    const h = html(entry(), { showTypeLabel: true, omit: { type: true } });
    expect(h).not.toContain("今日 Brief");
    expect(h).toContain("AI 软件工程 · 2026-06-18");
  });

  it("omit.domain 时 meta 不含领域", () => {
    const h = html(entry(), { showTypeLabel: true, omit: { domain: true } });
    expect(h).not.toContain("AI 软件工程");
    expect(h).toContain("今日 Brief · 2026-06-18");
  });

  it("多 domain facets 以 · 连接展示", () => {
    const h = html(entry({ facets: ["domain:ai-swe", "domain:ai-industry"] }), { showTypeLabel: true });
    expect(h).toContain("AI 软件工程 · AI 产业动态");
  });

  it("facets 为空时领域段跳过（仅 类型 · 日期）", () => {
    const h = html(entry({ facets: [] }), { showTypeLabel: true });
    expect(h).toContain("今日 Brief · 2026-06-18");
    expect(h).not.toContain("AI 软件工程");
  });

  it("两者都 omit 时只剩日期", () => {
    const h = html(entry(), { showTypeLabel: true, omit: { type: true, domain: true } });
    expect(h).toMatch(/card-meta">2026-06-18 </);
  });

  it("首页（!showTypeLabel）只显示日期", () => {
    const h = html(entry());
    expect(h).not.toContain("AI 软件工程");
    expect(h).toMatch(/card-meta">2026-06-18 </);
  });
});
