import type { ReactNode } from "react";

/** 极简 Markdown 渲染：仅覆盖 report-gen 产出的子集（# / ## / ### / > / 列表 / 行内 code / 段落）。
 *  仅用于渲染本系统自产的受控 Markdown；React 自动转义文本，无 XSS 风险。
 *
 *  C-2 引用支持（全局连续编号）：
 *  - 段落 / 标题中的 `[N]` → 渲染 <sup><a href="#cite-N">[N]</a></sup>；
 *  - 列表项以 `[N] ` 开头 → 该 <li> 加 id="cite-N"（点击 [N] 行内时浏览器自动滚到此项）；
 *  - 「{quote}」段 → 渲染 <q>，无引号字面值（避免和系统其他位置「」重复）。 */
export function Markdown({ md }: { md: string }) {
  const nodes: ReactNode[] = [];
  let bullets: { text: string; id: string | null; citeNum: string | null }[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      nodes.push(
        <ul key={`ul-${nodes.length}`}>
          {items.map((b, i) => (
            <li key={i} id={b.id ?? undefined} className={b.citeNum ? "cite-li" : undefined}>
              {/* dogfood feedback：列表项 [N] 作为可见序号显示（之前只剥成 id 用、用户只看到圆点）*/}
              {b.citeNum ? <span className="cite-num">[{b.citeNum}]</span> : null}
              {inline(b.text)}
            </li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };

  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*-\s+/.test(line)) {
      // [N] 引用解析的硬约束（review #7 注释明示）：
      // 仅当 stripped 紧接 [数字] + 空格 才赋 id="cite-N"——report-gen 的引用列表
      // 必须输出 "- [N] 「quote」— `ci`" 的扁平形式。任何嵌套（"  - 父项\n    - [1] xxx"）
      // 经 `^\s*-\s+` 一刀切前导空白后，第二级也会被解析为 cite 锚——目前 report-gen
      // 不输出嵌套列表所以安全；如需嵌套引用要先重做编号设计。
      const stripped = line.replace(/^\s*-\s+/, "");
      const m = stripped.match(/^\[(\d+)\]\s+(.*)$/);
      if (m) bullets.push({ text: m[2], id: `cite-${m[1]}`, citeNum: m[1] });
      else bullets.push({ text: stripped, id: null, citeNum: null });
      continue;
    }
    flush();
    if (line.startsWith("# ")) nodes.push(<h1 key={nodes.length}>{inline(line.slice(2))}</h1>);
    else if (line.startsWith("### ")) nodes.push(<h3 key={nodes.length}>{inline(line.slice(4))}</h3>);
    else if (line.startsWith("## ")) nodes.push(<h2 key={nodes.length}>{inline(line.slice(3))}</h2>);
    else if (line.startsWith("> "))
      nodes.push(
        <blockquote key={nodes.length} className="muted">
          {inline(line.slice(2))}
        </blockquote>,
      );
    else if (line.trim() !== "") nodes.push(<p key={nodes.length}>{inline(line)}</p>);
  }
  flush();
  return <article>{nodes}</article>;
}

/** 行内分词：`code` + 标准 markdown 链接 [text](url) + [N] 引用锚（C-2）。
 *  正则按优先级：链接（含括号 text + URL）→ code → [N] 数字锚。
 *  顺序重要：链接先匹配避免 [5](url) 被误识别成 [5] 锚。 */
const INLINE_PATTERN = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\[\d+\])/g;

function inline(text: string): ReactNode {
  const parts = text.split(INLINE_PATTERN);
  return parts.map((p, idx) => {
    if (!p) return null;
    // [text](url) markdown 链接（dogfood feedback：quote 可点跳源）
    const linkM = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkM) {
      return (
        <a key={`l-${idx}`} href={linkM[2]} target="_blank" rel="noopener noreferrer">{linkM[1]}</a>
      );
    }
    // `code`
    if (p.startsWith("`") && p.endsWith("`")) {
      return <code key={`c-${idx}`}>{p.slice(1, -1)}</code>;
    }
    // [N] 锚（仅纯数字）
    const refM = p.match(/^\[(\d+)\]$/);
    if (refM) {
      return (
        <sup key={`r-${idx}`} className="cite-ref">
          <a href={`#cite-${refM[1]}`}>[{refM[1]}]</a>
        </sup>
      );
    }
    return p;
  });
}
