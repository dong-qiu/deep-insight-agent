"use client";
/** 知识图谱 S1 力导向视图（ADR-0012 砖③）。
 *  d3-force 静态布局（确定性、SSR 与客户端同解）→ 自绘 SVG。
 *  边粗按「本图自身 maxW」归一化（先量校准：跨主题权值域差 ~4 倍）。
 *  点节点/边 → 拉 /api/graph/drill 溯源到洞察。⚠️ 共现≠因果。 */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useMemo, useState } from "react";
import type { EntityType } from "../../../lib/types.js";

export interface GNode {
  name: string;
  type: EntityType;
  mentions: number;
}
export interface GEdge {
  a: string;
  b: string;
  weight: number;
  strength: number;
}

interface SimNode extends GNode, SimulationNodeDatum {}
interface PlacedNode extends GNode {
  x: number;
  y: number;
}
interface DrillItem {
  id: string;
  headline: string;
  statement: string;
  importance: number;
  multi_source: boolean;
  quotes: string[];
}
type Selection = { kind: "node"; a: string } | { kind: "edge"; a: string; b: string };

const W = 820;
const H = 560;
const COLOR: Record<GNode["type"], string> = {
  organization: "#2563eb",
  person: "#db2777",
  product: "#16a34a",
  project: "#d97706",
};
const TYPE_LABEL: Record<GNode["type"], string> = {
  organization: "组织",
  person: "人物",
  product: "产品/模型",
  project: "项目/研究",
};

export function ForceGraph({
  nodes,
  edges,
  topic,
  since,
  metric = "frequency",
}: {
  nodes: GNode[];
  edges: GEdge[];
  topic: string;
  since?: string;
  metric?: "frequency" | "association";
}) {
  const [sel, setSel] = useState<Selection | null>(null);
  const [items, setItems] = useState<DrillItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const maxMentions = Math.max(1, ...nodes.map((n) => n.mentions));
  const radiusFor = (m: number): number => 6 + 13 * (Math.sqrt(m) / Math.sqrt(maxMentions));

  // 边粗按「当前口径」的值、且按本图自身值域归一化（先量：跨主题值域差大，绝对值会让低值图全细线）
  const edgeVal = (e: GEdge): number => (metric === "association" ? e.strength : e.weight);
  const vs = edges.map(edgeVal);
  const vMin = vs.length ? Math.min(...vs) : 0;
  const vMax = vs.length ? Math.max(...vs) : 0;
  const strokeFor = (e: GEdge): number =>
    vMax === vMin ? 2 : 1.2 + 4.8 * ((edgeVal(e) - vMin) / (vMax - vMin));

  // 静态布局：跑一次力模拟到收敛。d3-force 内部确定性 RNG → SSR/客户端同解、无水合错配
  const positioned = useMemo(() => {
    const sn: SimNode[] = nodes.map((n) => ({ ...n }));
    const links: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({ source: e.a, target: e.b }));
    forceSimulation<SimNode>(sn)
      .force(
        "link",
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
          .id((d) => d.name)
          .distance(80)
          .strength(0.35),
      )
      .force("charge", forceManyBody<SimNode>().strength(-340))
      .force("center", forceCenter(W / 2, H / 2))
      // 软性居中（弱）替代硬夹：把断开/孤立节点温和拉回画面，而非全压在边缘摞起来
      .force("x", forceX<SimNode>(W / 2).strength(0.06))
      .force("y", forceY<SimNode>(H / 2).strength(0.06))
      .force("collide", forceCollide<SimNode>().radius((d) => radiusFor(d.mentions) + 8))
      .stop()
      .tick(360);
    const placed: PlacedNode[] = sn.map((n) => ({
      name: n.name,
      type: n.type,
      mentions: n.mentions,
      x: Math.max(28, Math.min(W - 28, n.x ?? W / 2)),
      y: Math.max(28, Math.min(H - 28, n.y ?? H / 2)),
    }));
    return { placed, byName: new Map(placed.map((n) => [n.name, n])) };
    // radiusFor 仅依赖 maxMentions（由 nodes 派生），nodes 在 deps 里 → 无陈旧
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  useEffect(() => {
    if (!sel) {
      setItems(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ topic, a: sel.a });
    if (sel.kind === "edge") qs.set("b", sel.b);
    if (since) qs.set("since", since);
    fetch(`/api/graph/drill?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setItems(d.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sel, topic, since]);

  if (nodes.length === 0) {
    return (
      <p className="muted">
        该主题（窗口内）没有可连成图的实体共现——洞察太少、或实体彼此不在同一条洞察里出现。试试放宽时间窗或调低最小共现。
      </p>
    );
  }

  const { placed, byName } = positioned;

  return (
    <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-start" }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ border: "1px solid #e5e7eb", borderRadius: 8, background: "#fafafa", maxWidth: "100%" }}
        role="img"
        aria-label="实体共现图"
      >
        {edges.map((e, i) => {
          const a = byName.get(e.a);
          const b = byName.get(e.b);
          if (!a || !b) return null;
          const on = sel?.kind === "edge" && sel.a === e.a && sel.b === e.b;
          return (
            <line
              key={`${e.a}--${e.b}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={on ? "#111827" : "#9ca3af"}
              strokeWidth={strokeFor(e)}
              strokeOpacity={on ? 0.95 : 0.45}
              style={{ cursor: "pointer" }}
              onClick={() => setSel({ kind: "edge", a: e.a, b: e.b })}
            >
              <title>{`${e.a} ⇄ ${e.b}：共现 ${e.weight} 条 · 关联强度 ${e.strength}`}</title>
            </line>
          );
        })}
        {placed.map((n) => {
          const on = sel?.a === n.name || (sel?.kind === "edge" && sel.b === n.name);
          const r = radiusFor(n.mentions);
          return (
            <g key={n.name} style={{ cursor: "pointer" }} onClick={() => setSel({ kind: "node", a: n.name })}>
              <circle
                cx={n.x}
                cy={n.y}
                r={r}
                fill={COLOR[n.type]}
                fillOpacity={on ? 1 : 0.82}
                stroke={on ? "#111827" : "#fff"}
                strokeWidth={on ? 2 : 1}
              >
                <title>{`${n.name}（${TYPE_LABEL[n.type]}）：${n.mentions} 条洞察提及`}</title>
              </circle>
              <text x={n.x} y={n.y - r - 3} textAnchor="middle" fontSize={11} fill="#374151">
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>

      <aside style={{ flex: "1 1 280px", minWidth: 260 }}>
        <Legend metric={metric} />
        {!sel ? (
          <p className="muted">点节点看「提及它的洞察」，点边看「两实体共现的那些洞察」——溯源到原始分析判断。</p>
        ) : (
          <div className="card">
            <h4 style={{ marginTop: 0 }}>{sel.kind === "node" ? sel.a : `${sel.a} ⇄ ${sel.b}`}</h4>
            <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
              {sel.kind === "node" ? "提及该实体的洞察" : "两实体共现的洞察"}
              {" · "}
              <button
                type="button"
                onClick={() => setSel(null)}
                style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "#2563eb" }}
              >
                清除
              </button>
            </p>
            {loading ? (
              <p className="muted">加载中…</p>
            ) : !items || items.length === 0 ? (
              <p className="muted">无</p>
            ) : (
              <ul style={{ paddingLeft: "1rem", margin: 0 }}>
                {items.map((it) => (
                  <li key={it.id} style={{ marginBottom: 10 }}>
                    <span title={it.statement}>{it.headline}</span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {" · 重要度 "}
                      {it.importance}
                      {it.multi_source ? " · 多源" : ""}
                    </span>
                    {it.quotes.length > 0 ? (
                      <div className="muted" style={{ fontSize: 11, marginTop: 2, fontStyle: "italic" }}>
                        「{it.quotes[0]}」{it.quotes.length > 1 ? ` 等 ${it.quotes.length} 处` : ""}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Legend({ metric }: { metric: "frequency" | "association" }) {
  return (
    <p className="muted" style={{ fontSize: 12 }}>
      点大小 = 被提及洞察数 · 边粗 ={" "}
      {metric === "association" ? "关联强度 Jaccard" : "共现次数"}（本图内归一化）· 颜色：
      {(Object.keys(COLOR) as GNode["type"][]).map((t) => (
        <span key={t} style={{ marginLeft: 8 }}>
          <span
            style={{ display: "inline-block", width: 9, height: 9, borderRadius: 9, background: COLOR[t], marginRight: 3 }}
          />
          {TYPE_LABEL[t]}
        </span>
      ))}
      <br />
      <em>共现 ≠ 因果：边只表「在同一条洞察里被一起提及」，不代表语义关系。</em>
    </p>
  );
}
