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
import { type MouseEvent as RMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { selectGraph } from "../../../lib/graph/cooccurrence.js";
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
  /** 该洞察所在已发布报告（blocked/未入报告则 null） */
  report_id: string | null;
  report_date: string | null;
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

export interface GraphData {
  nodes: GNode[];
  candidateEdges: GEdge[];
  insightCount: number;
  withEntities: number;
  maxEdges: number;
  suggestedMinWeight: number;
  maxWeight: number;
}

export function ForceGraph({
  data,
  topic,
  since,
  topicName,
}: {
  data: GraphData;
  topic: string;
  since?: string;
  topicName: string;
}) {
  const [sel, setSel] = useState<Selection | null>(null);
  const [items, setItems] = useState<DrillItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  // 实时口径/阈值（客户端 state，拖动即时重筛，不刷新、布局不动）
  const [metric, setMetric] = useState<"frequency" | "association">("frequency");
  // 初值夹进 [1, maxW]——dense 主题 suggestedMinWeight 可能超 maxWeight（pick 到顶仍超预算）→ 防初始空白
  const [minWeight, setMinWeight] = useState(Math.min(data.suggestedMinWeight, Math.max(2, data.maxWeight)));
  // 缩放平移视图：graph 内容 = translate(tx,ty) scale(k)
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number; moved: boolean; rw: number; rh: number } | null>(null);

  // 即时选边：从候选图按当前口径/阈值产出展示图（纯函数、毫秒级，不重算布局）
  const selected = useMemo(
    () => selectGraph(data.nodes, data.candidateEdges, { metric, minEdgeWeight: minWeight, maxEdges: data.maxEdges }),
    [data, metric, minWeight],
  );
  const nodes = selected.nodes;
  const edges = selected.edges;

  // 节点大小按全部候选实体的 mentions 归一化（稳定，不随滑块变）
  const maxMentions = Math.max(1, ...data.nodes.map((n) => n.mentions));
  const radiusFor = (m: number): number => 6 + 13 * (Math.sqrt(m) / Math.sqrt(maxMentions));

  // 边粗按「当前口径」的值、且按本图自身值域归一化（先量：跨主题值域差大，绝对值会让低值图全细线）
  const edgeVal = (e: GEdge): number => (metric === "association" ? e.strength : e.weight);
  const vs = edges.map(edgeVal);
  const vMin = vs.length ? Math.min(...vs) : 0;
  const vMax = vs.length ? Math.max(...vs) : 0;
  const strokeFor = (e: GEdge): number =>
    vMax === vMin ? 2 : 1.2 + 4.8 * ((edgeVal(e) - vMin) / (vMax - vMin));

  // 静态布局：对**全部候选节点 + 候选边**跑一次力模拟（确定性 RNG）。布局只随 data 重算、
  // 不随口径/阈值变 → 拖动滑块时节点位置不动、不跳。
  const positioned = useMemo(() => {
    const sn: SimNode[] = data.nodes.map((n) => ({ ...n }));
    const links: SimulationLinkDatum<SimNode>[] = data.candidateEdges.map((e) => ({ source: e.a, target: e.b }));
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
    // radiusFor 仅依赖 maxMentions（由 data.nodes 派生）；布局只依赖 data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

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

  // ego 聚焦：选中节点 → 它 + 直接邻居高亮、其余淡化；选中边 → 两端点 + 该边。
  const focus = useMemo(() => {
    if (!sel) return null;
    if (sel.kind === "node") {
      const set = new Set<string>([sel.a]);
      for (const e of edges) {
        if (e.a === sel.a) set.add(e.b);
        if (e.b === sel.a) set.add(e.a);
      }
      return {
        node: (n: string) => set.has(n),
        edge: (e: GEdge) => e.a === sel.a || e.b === sel.a,
      };
    }
    return {
      node: (n: string) => n === sel.a || n === sel.b,
      edge: (e: GEdge) => e.a === sel.a && e.b === sel.b,
    };
  }, [sel, edges]);

  // 滚轮缩放：用 ref 挂非被动监听（React onWheel 被动、preventDefault 无效），以光标为中心。
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const py = ((e.clientY - rect.top) / rect.height) * H;
      setView((v) => {
        const k = Math.min(5, Math.max(0.4, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const gx = (px - v.tx) / v.k;
        const gy = (py - v.ty) / v.k;
        return { k, tx: px - gx * k, ty: py - gy * k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [data.nodes.length]);

  if (data.nodes.length === 0) {
    return (
      <p className="muted">
        该主题（窗口内）没有可连成图的实体共现——洞察太少、或实体彼此不在同一条洞察里出现。试试放宽时间窗。
      </p>
    );
  }

  const { placed, byName } = positioned;

  const beginPan = (e: RMouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    panRef.current = {
      sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false,
      rw: rect?.width ?? W, rh: rect?.height ?? H, // 缓存盒尺寸，拖动期间不变、免每帧重排
    };
  };
  const onMove = (e: RMouseEvent) => {
    const p = panRef.current;
    if (!p) return;
    if (Math.abs(e.clientX - p.sx) + Math.abs(e.clientY - p.sy) > 3) p.moved = true;
    const dx = ((e.clientX - p.sx) / p.rw) * W;
    const dy = ((e.clientY - p.sy) / p.rh) * H;
    setView((v) => ({ ...v, tx: p.tx + dx, ty: p.ty + dy }));
  };
  const endPan = () => {
    const p = panRef.current;
    if (p && !p.moved) setSel(null); // 空白单击（未拖动）→ 复位选择/聚焦
    panRef.current = null;
  };
  // 拖出 svg：只取消平移，不判「空白单击」（避免移出即误清选择）
  const cancelPan = () => {
    panRef.current = null;
  };
  const reset = () => {
    setView({ k: 1, tx: 0, ty: 0 });
    setSel(null);
  };
  const zoomCenter = (factor: number) =>
    setView((v) => {
      const k = Math.min(5, Math.max(0.4, v.k * factor));
      const gx = (W / 2 - v.tx) / v.k;
      const gy = (H / 2 - v.ty) / v.k;
      return { k, tx: W / 2 - gx * k, ty: H / 2 - gy * k };
    });

  return (
    <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-start" }}>
      <div>
        <div
          className="card"
          style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", alignItems: "center", marginBottom: 8, padding: "8px 12px" }}
        >
          <label>
            口径{" "}
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value === "association" ? "association" : "frequency")}
            >
              <option value="frequency">频次</option>
              <option value="association">关联强度</option>
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            最小共现 <strong style={{ minWidth: 14, textAlign: "right" }}>{minWeight}</strong>
            <input
              type="range"
              min={1}
              max={Math.max(2, data.maxWeight)}
              value={minWeight}
              onChange={(e) => setMinWeight(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
          <strong>{topicName}</strong> · {data.insightCount} 洞察（{data.withEntities} 带实体）· {nodes.length} 节点 /{" "}
          {edges.length} 边 · {metric === "association" ? `关联强度（支持度≥${Math.max(2, minWeight)}·top${data.maxEdges}）` : "频次"}
        </div>
        {edges.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>当前阈值下无边——调低「最小共现」，或放宽时间窗。</p>
        ) : null}
        <svg
          ref={svgRef}
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          style={{ border: "1px solid #e5e7eb", borderRadius: 8, background: "#fafafa", maxWidth: "100%", height: "auto", touchAction: "none" }}
          role="img"
          aria-label="实体共现图"
          onMouseMove={onMove}
          onMouseUp={endPan}
          onMouseLeave={cancelPan}
        >
          {/* 背景：拖动平移 + 空白单击复位选择 */}
          <rect x={0} y={0} width={W} height={H} fill="transparent" style={{ cursor: "grab" }} onMouseDown={beginPan} />
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
            {edges.map((e) => {
              const a = byName.get(e.a);
              const b = byName.get(e.b);
              if (!a || !b) return null;
              const on = sel?.kind === "edge" && sel.a === e.a && sel.b === e.b;
              const dim = focus ? !focus.edge(e) : false;
              return (
                <line
                  key={`${e.a}--${e.b}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={on ? "#111827" : "#9ca3af"}
                  strokeWidth={strokeFor(e)}
                  strokeOpacity={dim ? 0.06 : on ? 0.95 : 0.45}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSel({ kind: "edge", a: e.a, b: e.b })}
                >
                  <title>{`${e.a} ⇄ ${e.b}：共现 ${e.weight} 条 · 关联强度 ${e.strength}`}</title>
                </line>
              );
            })}
            {nodes.map((nd) => {
              const p = byName.get(nd.name);
              if (!p) return null;
              const on = sel?.a === nd.name || (sel?.kind === "edge" && sel.b === nd.name);
              const dim = focus ? !focus.node(nd.name) : false;
              const r = radiusFor(nd.mentions);
              return (
                <g
                  key={nd.name}
                  style={{ cursor: "pointer", opacity: dim ? 0.12 : 1 }}
                  onClick={() => setSel({ kind: "node", a: nd.name })}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill={COLOR[nd.type]}
                    fillOpacity={on ? 1 : 0.82}
                    stroke={on ? "#111827" : "#fff"}
                    strokeWidth={on ? 2 : 1}
                  >
                    <title>{`${nd.name}（${TYPE_LABEL[nd.type]}）：${nd.mentions} 条洞察提及`}</title>
                  </circle>
                  <text x={p.x} y={p.y - r - 3} textAnchor="middle" fontSize={11} fill="#374151">
                    {nd.name}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => zoomCenter(1.25)}>＋</button>
          <button type="button" onClick={() => zoomCenter(1 / 1.25)}>－</button>
          <button type="button" onClick={reset}>复位</button>
          <span>滚轮缩放 · 拖动平移 · 点节点聚焦其邻居 · 点空白复位</span>
        </div>
      </div>

      <aside style={{ flex: "1 1 280px", minWidth: 260 }}>
        <Legend metric={metric} />
        {!sel ? (
          <p className="muted">点节点看「关于它的洞察」、点边看「两实体共现的洞察」——每条可点进所在报告。</p>
        ) : (
          <div className="card">
            <h4 style={{ marginTop: 0 }}>{sel.kind === "node" ? sel.a : `${sel.a} ⇄ ${sel.b}`}</h4>
            <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
              {sel.kind === "node" ? "关于该实体的洞察" : "两实体共现的洞察"}
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
                    {it.report_id ? (
                      <a href={`/reports/${it.report_id}`} title={it.statement}>
                        {it.headline}
                      </a>
                    ) : (
                      <span title={it.statement}>{it.headline}</span>
                    )}
                    <span className="muted" style={{ fontSize: 11 }}>
                      {" · 重要度 "}
                      {it.importance}
                      {it.multi_source ? " · 多源" : ""}
                      {it.report_date ? ` · ${it.report_date}` : " · 未入报告"}
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
