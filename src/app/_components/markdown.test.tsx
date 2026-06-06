/** Markdown 组件单测（C-2）：纯渲染逻辑用 renderToStaticMarkup，无需 DOM。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown.js";

function html(md: string): string {
  return renderToStaticMarkup(<Markdown md={md} />);
}

describe("Markdown 基础", () => {
  it("# / ## / ### 标题 + 段落 + 行内 code（非编号标题不进 insight-block）", () => {
    const h = html("# T1\n## T2\n### T3\n正文 `inline` 段");
    expect(h).toContain("<h1>T1</h1>");
    expect(h).toContain("<h2>T2</h2>");
    expect(h).toContain("<h3>T3</h3>");
    expect(h).toContain("<code>inline</code>");
    expect(h).not.toContain("insight-block");
  });

  it("编号 ## N. / ### N. 自动包入 <section class='insight-block'>", () => {
    const h1 = html("## 1. 重要洞察 statement");
    expect(h1).toContain('class="insight-block"');
    expect(h1).toMatch(/<section[^>]*><h2>1\./);

    const h2 = html("### 1. deep_dive 洞察");
    expect(h2).toContain('class="insight-block"');
    expect(h2).toMatch(/<section[^>]*><h3>1\./);
  });

  it("两条洞察 → 两个独立 <section> 不嵌套", () => {
    const h = html("## 1. 第一条 [1]\n- [1] Q1\n\n## 2. 第二条 [2]\n- [2] Q2");
    const sections = h.match(/<section[^>]*class="insight-block"/g);
    expect(sections?.length).toBe(2);
  });

  it("> blockquote · 第一条 hero-meta 类（报告头）", () => {
    expect(html("> 引言")).toContain('class="hero-meta"');
  });

  it("> blockquote · 非顶部位置 muted 类（普通引用）", () => {
    const h = html("# Title\n## 1. 洞察\n> 内嵌引用");
    expect(h).toContain('class="muted"');
  });

  it("- 列表 → ul/li", () => {
    const h = html("- a\n- b");
    expect(h).toContain("<ul>");
    expect(h.match(/<li/g)?.length).toBe(2);
  });
});

describe("Markdown 引用 [N]（C-2）", () => {
  it("段落中 [1] [2] → sup.cite-ref 含 href=#cite-N", () => {
    const h = html("洞察句 [1][2] 末尾");
    expect(h).toContain('class="cite-ref"');
    expect(h).toContain('href="#cite-1"');
    expect(h).toContain('href="#cite-2"');
  });

  it("标题中 [N] 同样解析", () => {
    const h = html("## 1. statement [3]");
    expect(h).toContain('href="#cite-3"');
  });

  it("列表项 '- [N] text' → <li id='cite-N'> + 可见 [N] 序号 + cite-li 类", () => {
    const h = html("- [5] 引用文本");
    expect(h).toContain('id="cite-5"');
    expect(h).toContain('class="cite-li"');
    expect(h).toContain('class="cite-num"');
    expect(h).toContain("[5]");        // [N] 作为可见序号渲染（不再剥掉）
    expect(h).toContain("引用文本");  // 文本部分仍正常显示
  });

  it("混合：statement 含 [1] + 列表项 [1] 同号匹配（点击会跳到 li#cite-1）", () => {
    const h = html("## 1. S [1]\n- [1] Q1");
    expect(h).toMatch(/href="#cite-1"[^>]*>\[1\]/);
    expect(h).toMatch(/id="cite-1"/);
  });

  it("普通 [text] 非数字 → 不被识别为引用", () => {
    const h = html("正文 [TODO] 标签");
    expect(h).not.toContain("cite-ref");
    expect(h).toContain("[TODO]");
  });

  it("行内 code 内的 [1] 不应被解析为引用", () => {
    const h = html("看 `[1]` 这里");
    expect(h).toContain("<code>[1]</code>");
    expect(h).not.toContain("cite-ref");
  });

  it("标准 markdown 链接 [text](url) → <a> 带 target=_blank", () => {
    const h = html("点 [「quote 文本」](https://example.com/abc) 看原文");
    expect(h).toContain('href="https://example.com/abc"');
    expect(h).toContain('target="_blank"');
    expect(h).toContain("「quote 文本」");
    // 不应被误认成 [N] 锚
    expect(h).not.toContain("cite-ref");
  });

  it("[5](url) 优先解析为链接（不被误识为 [N] 锚）", () => {
    const h = html("[5](https://example.com)");
    expect(h).toContain('href="https://example.com"');
    expect(h).not.toContain("#cite-5");
  });
});
