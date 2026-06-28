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
  /** 两端实体共现的洞察条数 */
  weight: number;
}

export interface CooccurrenceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOptions {
  /** 边的最小权重，低于此不画（默认 2，滤一次性偶然同现） */
  minEdgeWeight?: number;
  /** 按 mentions 取前 N 个实体进图，防 hairball（默认 40） */
  topN?: number;
}

/** 顺序无关的对 key：字典序小的在前。用 JSON 数组编码——实体名含空格（"Sam Altman"/"Claude Code"）
 *  是常态，绝不能用分隔符 join 后再 split（会拆错多词名）。 */
function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

/**
 * 从洞察集派生实体共现图。
 *
 * 步骤：①统计每实体 mentions + type ②统计每对共现 weight
 * ③候选节点 = 按 mentions 取 top-N ④边 = weight≥阈值且两端都在候选集
 * ⑤最终节点 = 候选集里至少有一条边的（孤点剔除）。
 */
export function deriveCooccurrenceGraph(
  insights: readonly EntityBearing[],
  opts: GraphOptions = {},
): CooccurrenceGraph {
  const minEdgeWeight = opts.minEdgeWeight ?? 2;
  const topN = opts.topN ?? 40;

  // 每实体：mentions（提及洞察数）+ 各 type 计数（同名跨条 type 不一致时取众数）
  const mentions = new Map<string, number>();
  const typeVotes = new Map<string, Map<EntityType, number>>();
  // 每对：共现洞察数
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

    // 该洞察内所有无序对 +1
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const k = pairKey(names[i], names[j]);
        pairWeight.set(k, (pairWeight.get(k) ?? 0) + 1);
      }
    }
  }

  // 候选节点 = 按 mentions 降序 top-N（同频保插入序稳定）
  const candidates = new Set(
    [...mentions.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, topN)
      .map(([name]) => name),
  );

  // 边：weight≥阈值 且 两端都在候选集
  const edges: GraphEdge[] = [];
  const connected = new Set<string>();
  for (const [key, weight] of pairWeight) {
    if (weight < minEdgeWeight) continue;
    const [a, b] = JSON.parse(key) as [string, string];
    if (!candidates.has(a) || !candidates.has(b)) continue;
    edges.push({ a, b, weight });
    connected.add(a);
    connected.add(b);
  }
  // weight 降序、再按端点名稳定
  edges.sort((x, y) => y.weight - x.weight || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));

  // 最终节点 = 候选集里有边的（孤点剔除）
  const nodes: GraphNode[] = [];
  for (const name of candidates) {
    if (!connected.has(name)) continue;
    nodes.push({ name, type: dominantType(typeVotes.get(name)!), mentions: mentions.get(name)! });
  }
  nodes.sort((x, y) => y.mentions - x.mentions || (x.name < y.name ? -1 : 1));

  return { nodes, edges };
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
