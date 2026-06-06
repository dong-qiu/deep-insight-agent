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
  let bullets: { text: string; id: string | null }[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      nodes.push(
        <ul key={`ul-${nodes.length}`}>
          {items.map((b, i) => (
            <li key={i} id={b.id ?? undefined}>{inline(b.text)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };

  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*-\s+/.test(line)) {
      const stripped = line.replace(/^\s*-\s+/, "");
      const m = stripped.match(/^\[(\d+)\]\s+(.*)$/);
      if (m) bullets.push({ text: m[2], id: `cite-${m[1]}` });
      else bullets.push({ text: stripped, id: null });
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

/** 行内 `code` + [N] 引用锚链接（C-2）。
 *  分词规则：先按 `code` 切；非 code 段再按 `[N]`（贪婪不跨字符）切，逐段决定 ReactNode。 */
function inline(text: string): ReactNode {
  const codeSplits = text.split(/(`[^`]+`)/g);
  const out: ReactNode[] = [];
  codeSplits.forEach((seg, segIdx) => {
    if (seg.startsWith("`") && seg.endsWith("`")) {
      out.push(<code key={`c-${segIdx}`}>{seg.slice(1, -1)}</code>);
      return;
    }
    // 非 code 段：把 [N] 切出来
    const refSplits = seg.split(/(\[\d+\])/g);
    refSplits.forEach((p, idx) => {
      const m = p.match(/^\[(\d+)\]$/);
      if (m) {
        out.push(
          <sup key={`r-${segIdx}-${idx}`} className="cite-ref">
            <a href={`#cite-${m[1]}`}>[{m[1]}]</a>
          </sup>,
        );
      } else if (p.length > 0) {
        out.push(p);
      }
    });
  });
  return out;
}
