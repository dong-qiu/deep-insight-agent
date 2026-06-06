import type { ReactNode } from "react";

/** 极简 Markdown 渲染：仅覆盖 report-gen 产出的子集（# / ## / ### / > / 列表 / 行内 code / 段落）。
 *  仅用于渲染本系统自产的受控 Markdown；React 自动转义文本，无 XSS 风险。
 *
 *  C-2 引用支持（全局连续编号）：
 *  - 段落 / 标题中的 `[N]` → 渲染 <sup><a href="#cite-N">[N]</a></sup>；
 *  - 列表项以 `[N] ` 开头 → 该 <li> 加 id="cite-N"、class="cite-li"、首列显式 [N] 序号。
 *
 *  dogfood feedback（2026-06-06）：
 *  - 标准 markdown 链接 [text](url) → <a target="_blank">；
 *  - 编号洞察标题 (`## N.` 或 `### N.`) 自动包入 <section class="insight-block">，
 *    使每条洞察可作为视觉"卡片"独立排版（CSS 在 globals.css）。 */
export function Markdown({ md }: { md: string }) {
  const rootNodes: ReactNode[] = [];
  /** 当前洞察 section 的内容容器；null = 不在某条洞察内 */
  let insightNodes: ReactNode[] | null = null;
  let bullets: { text: string; id: string | null; citeNum: string | null }[] = [];

  const target = (): ReactNode[] => insightNodes ?? rootNodes;
  const flushBullets = (): void => {
    if (!bullets.length) return;
    const items = bullets;
    target().push(
      <ul key={`ul-${target().length}`}>
        {items.map((b, i) => (
          <li key={i} id={b.id ?? undefined} className={b.citeNum ? "cite-li" : undefined}>
            {b.citeNum ? <span className="cite-num">[{b.citeNum}]</span> : null}
            {inline(b.text)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flushInsight = (): void => {
    flushBullets();
    if (insightNodes) {
      rootNodes.push(
        <section className="insight-block" key={`ins-${rootNodes.length}`}>
          {insightNodes}
        </section>,
      );
      insightNodes = null;
    }
  };
  /** 编号洞察标题：brief 用 `## 1.`，deep_dive 用 `### 1.`（节内三级） */
  const isInsightHeading = (line: string): boolean =>
    /^##\s+\d+\.\s/.test(line) || /^###\s+\d+\.\s/.test(line);

  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*-\s+/.test(line)) {
      const stripped = line.replace(/^\s*-\s+/, "");
      const m = stripped.match(/^\[(\d+)\]\s+(.*)$/);
      if (m) bullets.push({ text: m[2], id: `cite-${m[1]}`, citeNum: m[1] });
      else bullets.push({ text: stripped, id: null, citeNum: null });
      continue;
    }
    flushBullets();

    if (isInsightHeading(line)) {
      flushInsight(); // 上一条洞察收尾
      insightNodes = []; // 新洞察开始
      if (line.startsWith("## ")) {
        insightNodes.push(<h2 key={0}>{inline(line.slice(3))}</h2>);
      } else {
        insightNodes.push(<h3 key={0}>{inline(line.slice(4))}</h3>);
      }
    } else if (line.startsWith("# ")) {
      flushInsight();
      rootNodes.push(<h1 key={rootNodes.length}>{inline(line.slice(2))}</h1>);
    } else if (line.startsWith("### ")) {
      flushInsight();
      rootNodes.push(<h3 key={rootNodes.length}>{inline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      flushInsight(); // 非编号 ## 视作分节标题（deep_dive 的 "## 重点关注"），不进洞察卡
      rootNodes.push(<h2 key={rootNodes.length}>{inline(line.slice(3))}</h2>);
    } else if (line.startsWith("> ")) {
      // 报告 hero 元数据条：第一条顶层 blockquote 加强类供 CSS hero 样式锁定
      const isHero = !insightNodes && rootNodes.length <= 2;
      target().push(
        <blockquote key={target().length} className={isHero ? "hero-meta" : "muted"}>
          {inline(line.slice(2))}
        </blockquote>,
      );
    } else if (line.trim() !== "") {
      target().push(<p key={target().length}>{inline(line)}</p>);
    }
  }
  flushBullets();
  flushInsight();
  return <article className="report-body">{rootNodes}</article>;
}

/** 行内分词：`code` + 标准 markdown 链接 [text](url) + [N] 引用锚（C-2）。
 *  正则按优先级：链接（含括号 text + URL）→ code → [N] 数字锚。
 *  顺序重要：链接先匹配避免 [5](url) 被误识别成 [5] 锚。 */
const INLINE_PATTERN = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\[\d+\])/g;

function inline(text: string): ReactNode {
  const parts = text.split(INLINE_PATTERN);
  return parts.map((p, idx) => {
    if (!p) return null;
    const linkM = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkM) {
      return (
        <a key={`l-${idx}`} href={linkM[2]} target="_blank" rel="noopener noreferrer">{linkM[1]}</a>
      );
    }
    if (p.startsWith("`") && p.endsWith("`")) {
      return <code key={`c-${idx}`}>{p.slice(1, -1)}</code>;
    }
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
