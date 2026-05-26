import type { ReactNode } from "react";

/** 极简 Markdown 渲染：仅覆盖 report-gen 产出的子集（# / ## / > / 列表 / 行内 code / 段落）。
 *  仅用于渲染本系统自产的受控 Markdown；React 自动转义文本，无 XSS 风险。 */
export function Markdown({ md }: { md: string }) {
  const nodes: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      nodes.push(
        <ul key={`ul-${nodes.length}`}>
          {items.map((t, i) => (
            <li key={i}>{inline(t)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };

  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*-\s+/.test(line)) {
      bullets.push(line.replace(/^\s*-\s+/, ""));
      continue;
    }
    flush();
    if (line.startsWith("# ")) nodes.push(<h1 key={nodes.length}>{inline(line.slice(2))}</h1>);
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

/** 行内 `code` */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p,
  );
}
