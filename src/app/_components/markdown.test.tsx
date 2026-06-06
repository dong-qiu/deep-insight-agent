/** Markdown 组件单测（C-2）：纯渲染逻辑用 renderToStaticMarkup，无需 DOM。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown.js";

function html(md: string): string {
  return renderToStaticMarkup(<Markdown md={md} />);
}

describe("Markdown 基础", () => {
  it("# / ## / ### 标题 + 段落 + 行内 code", () => {
    const h = html("# T1\n## T2\n### T3\n正文 `inline` 段");
    expect(h).toContain("<h1>T1</h1>");
    expect(h).toContain("<h2>T2</h2>");
    expect(h).toContain("<h3>T3</h3>");
    expect(h).toContain("<code>inline</code>");
  });

  it("> blockquote · muted 类", () => {
    expect(html("> 引言")).toContain('class="muted"');
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

  it("列表项 '- [N] text' → <li id='cite-N'>", () => {
    const h = html("- [5] 引用文本");
    expect(h).toContain('id="cite-5"');
    // 文本去掉 [N] 前缀
    expect(h).toContain(">引用文本</li>");
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
});
