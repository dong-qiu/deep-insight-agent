/**
 * 知识图谱 S1——实体共现图（ADR-0012）。
 *
 * 边 = 同一条洞察的 entities 里共同出现的两实体；无向；weight = 共现的洞察条数。
 * 纯确定性派生（零 LLM、零新抽取、不读 DB），全从 `Insight.entities` 出。
 * 节点大小 ∝ mentions（提及它的洞察条数）、颜色 ∝ type。
 *
 * ⚠️ 共现 ≠ 因果：边只表「在同一分析判断里被一起提及」，不表语义关系（谁影响/收购/对立谁）。
 * 有向语义边是 S2（LLM 抽取），见 ADR-0012。
 */
import type { Entity, EntityType } from "../types.js";

/** 共现派生只需要 entities——洞察或任何带 entities 的轻量行均可（避免热路径 N+1 查 citation） */
export type EntityBearing = { entities?: Entity[] };

export interface GraphNode {
  name: string;
  type: EntityType;
  /** 提及该实体的洞察条数，决定节点大小 */
  mentions: number;
}

export interface GraphEdge {
  /** 端点实体名；恒满足 a < b（字典序），使无序对有稳定 key */
  a: string;
  b: string;
  /** 两端实体共现的洞察条数（生频次） */
  weight: number;
  /** 关联强度 = Jaccard = cooc / |A∪B| ∈ (0,1]，圆到 3 位小数。
   *  天然压低 hub（和谁都连的实体 Jaccard 低）→ 浮出「异常绑定」的非显然关联。 */
  strength: number;
}

export interface CooccurrenceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOptions {
  /** 边的最小权重/支持度下限，低于此不画（默认 2，滤一次性偶然同现 + 挡 Jaccard=1 噪声） */
  minEdgeWeight?: number;
  /** 按 mentions 取前 N 个实体进图，防 hairball（默认 40） */
  topN?: number;
  /** 选边口径：frequency=按共现次数（默认，hub 主导）；association=按 Jaccard 关联强度取 top（浮出非显然紧密对） */
  metric?: "frequency" | "association";
  /** association 模式保留的最大边数（按 strength 取 top；默认 40） */
  maxEdges?: number;
}

/** 顺序无关的对 key：字典序小的在前。用 JSON 数组编码——实体名含空格（"Sam Altman"/"Claude Code"）
 *  是常态，绝不能用分隔符 join 后再 split（会拆错多词名）。 */
function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

export interface CandidateGraph {
  /** top-N 候选实体（全部，未剔孤点；mentions/type 已定） */
  nodes: GraphNode[];
  /** top-N 内全部共现对（weight≥1，带 strength）——供客户端按阈值/口径即时选边、布局只算一次 */
  candidateEdges: GraphEdge[];
}

const cmpEnds = (x: GraphEdge, y: GraphEdge): number =>
  x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0;

/**
 * 派生「候选图」：扫洞察 → top-N 候选节点 + 全部候选边（weight≥1，带 Jaccard）。
 * 重活（扫洞察）只算一次；选边/孤点剔除交 {@link selectGraph}（纯函数、客户端可即时重筛）。
 */
export function deriveCandidateGraph(
  insights: readonly EntityBearing[],
  opts: { topN?: number } = {},
): CandidateGraph {
  const topN = opts.topN ?? 40;
  const mentions = new Map<string, number>();
  const typeVotes = new Map<string, Map<EntityType, number>>();
  const pairWeight = new Map<string, number>();

  for (const ins of insights) {
    // 一条洞察内：trim、去空、按名去重（防脏数据虚增）
    const seen = new Map<string, EntityType>();
    for (const e of ins.entities ?? []) {
      const name = e.name?.trim();
      if (!name) continue;
      if (!seen.has(name)) seen.set(name, e.type);
    }
    const names = [...seen.keys()];
    for (const [name, type] of seen) {
      mentions.set(name, (mentions.get(name) ?? 0) + 1);
      let votes = typeVotes.get(name);
      if (!votes) {
        votes = new Map();
        typeVotes.set(name, votes);
      }
      votes.set(type, (votes.get(type) ?? 0) + 1);
    }
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const k = pairKey(names[i], names[j]);
        pairWeight.set(k, (pairWeight.get(k) ?? 0) + 1);
      }
    }
  }

  // 候选节点 = 按 mentions 降序 top-N（同频保插入序稳定）
  const top = [...mentions.entries()].sort((x, y) => y[1] - x[1]).slice(0, topN).map(([name]) => name);
  const inTop = new Set(top);

  const candidateEdges: GraphEdge[] = [];
  for (const [key, weight] of pairWeight) {
    const [a, b] = JSON.parse(key) as [string, string];
    if (!inTop.has(a) || !inTop.has(b)) continue;
    const union = mentions.get(a)! + mentions.get(b)! - weight; // |A∪B|
    const strength = union > 0 ? Math.round((weight / union) * 1000) / 1000 : 0;
    candidateEdges.push({ a, b, weight, strength });
  }

  const nodes: GraphNode[] = top.map((name) => ({
    name,
    type: dominantType(typeVotes.get(name)!),
    mentions: mentions.get(name)!,
  }));
  return { nodes, candidateEdges };
}

/**
 * 从候选图按口径/阈值产出最终展示图。**纯函数、客户端可用**（滑块/口径即时重筛、布局不动）。
 * frequency=weight≥阈值全留按 weight 排；association=支持度下限 max(2,阈值) 后按 strength 取 top-maxEdges。
 * 末了按最终边集剔孤点。
 */
export function selectGraph(
  candidateNodes: readonly GraphNode[],
  candidateEdges: readonly GraphEdge[],
  opts: GraphOptions = {},
): CooccurrenceGraph {
  const minEdgeWeight = opts.minEdgeWeight ?? 2;
  const metric = opts.metric ?? "frequency";
  // association 恒保支持度下限 ≥2（挡「各 1 次恰好同条 → Jaccard=1」噪声），不受滑块降到 1 影响
  const support = metric === "association" ? Math.max(2, minEdgeWeight) : minEdgeWeight;
  const kept = candidateEdges.filter((e) => e.weight >= support);
  // kept 已是 filter 产出的新数组，可原地排序（不动入参）
  const edges: GraphEdge[] =
    metric === "association"
      ? kept
          .sort((x, y) => y.strength - x.strength || y.weight - x.weight || cmpEnds(x, y))
          .slice(0, opts.maxEdges ?? 40)
      : kept.sort((x, y) => y.weight - x.weight || y.strength - x.strength || cmpEnds(x, y));

  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.a);
    connected.add(e.b);
  }
  const nodes = candidateNodes
    .filter((n) => connected.has(n.name))
    .map((n) => ({ ...n }))
    .sort((x, y) => y.mentions - x.mentions || (x.name < y.name ? -1 : 1));
  return { nodes, edges };
}

/** 从洞察集派生实体共现图（候选派生 + 选边一步到位；服务端/eval 用）。 */
export function deriveCooccurrenceGraph(
  insights: readonly EntityBearing[],
  opts: GraphOptions = {},
): CooccurrenceGraph {
  const { nodes, candidateEdges } = deriveCandidateGraph(insights, { topN: opts.topN });
  return selectGraph(nodes, candidateEdges, opts);
}

export interface BudgetOptions {
  topN?: number;
  /** 目标最大边数，超过则升阈值（默认 60，先量校准值） */
  targetMaxEdges?: number;
  /** 阈值上限，到顶仍超预算就返回上限（默认 8） */
  maxWeight?: number;
}

/**
 * 自适应初始边阈值：从 weight=2 起逐步升，取首个使边数 ≤ targetMaxEdges 的阈值。
 *
 * **按图自身边密度自适应，不按洞察数**——ADR-0012 先量证：洞察数不预测密度
 * （生产 t_ai_industry 55 洞察反比 t_prompt_injection 123 洞察更密）。
 * 用于 UI 初始默认；用户仍可用滑块下调到 1 看全量。
 */
export function pickEdgeWeightForBudget(insights: readonly EntityBearing[], opts: BudgetOptions = {}): number {
  const topN = opts.topN ?? 40;
  const targetMaxEdges = opts.targetMaxEdges ?? 60;
  const maxWeight = opts.maxWeight ?? 8;
  for (let w = 2; w < maxWeight; w++) {
    if (deriveCooccurrenceGraph(insights, { minEdgeWeight: w, topN }).edges.length <= targetMaxEdges) {
      return w;
    }
  }
  return maxWeight;
}

/** 同名跨条 type 不一致时取众数；平票取首个达到该票数的（Map 迭代序≈首见序） */
function dominantType(votes: Map<EntityType, number>): EntityType {
  let best: EntityType | null = null;
  let bestN = -1;
  for (const [type, n] of votes) {
    if (n > bestN) {
      best = type;
      bestN = n;
    }
  }
  return best!;
}
