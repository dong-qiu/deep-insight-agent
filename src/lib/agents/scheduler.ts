/** 定时管线编排（architecture「系统 cron + 容器内进程」的被触发端）。
 *  一次完整跑：采集所有启用 Source → 按启用 Topic 切窗口内 ContentItem → 分析→校验→生成 brief。
 *  每个 Source / Topic 独立 try/catch，单点失败不连累其余（与 collector / validateBatch 的韧性一致）。
 *  由 /api/cron 触发（系统 cron / supercronic 定时 curl）；含真模型调用，需 ANTHROPIC_API_KEY。 */
import type { DB } from "../db/index.js";
import { getEffectiveSources, loadStaticConfig } from "../config/index.js";
import { appendAudit } from "../db/audit.js";
import { getSource, getTopic, listContentForTopic, listProbeCandidates, listRuns, listTopics, reviveSource, setCircuit, setLastProbe } from "../db/repos.js";
import { listRecentBriefEvents, previousReportForTopic, topicHasReport } from "../db/reports.js";
import { notifyBudget, notifySourceCircuit, notifySourceRevived, notifySourceZeroYield } from "../runtime/alert.js";
import { getBudgetStatus } from "../runtime/cost-guard.js";
import { runLogger } from "../runtime/logger.js";
import { circuitConfig, evaluateCircuit, evaluateZeroYield } from "../runtime/run-stats.js";
import type { ContentItem, Report, Run, Topic } from "../types.js";
import { archetypeProfile } from "../topics/archetype.js";
import { collectSource } from "./collector.js";
import { runAnalysis, runReportGen, runValidation } from "./pipeline.js";

export interface ScheduleSummary {
  startedAt: string;
  finishedAt: string;
  windowHours: number;
  collected: Array<{ source: string; fetched?: number; inserted?: number; updated?: number; error?: string }>;
  topics: Array<{ topic: string; items: number; reportId?: string; included?: number; status: string; type?: Report["type"] }>;
  errors: string[];
  /** 成本预算触顶 → 本轮剩余 topic 被自动熔断跳过（A5）；未配预算或未触顶时省略。 */
  budgetStopped?: boolean;
  /** 本轮被系统熔断停采的源 id（ADR-0008 决定②）：正常处置、不计入 errors（评审）。 */
  circuitOpened?: string[];
  /** 本轮半开探测成功、自动复活的源 id（切片3b-2）。 */
  circuitRevived?: string[];
  /** 本轮触发零产出告警的源 id（切片3b-3）。 */
  zeroYield?: string[];
}

/** 冷启动决策（纯函数，可测）：topic 无历史报告 → 首版综述 initial_digest（更宽窗口 / 更多条，
 *  给新主题一份有份量的首报）；否则按常规 reportType（brief / deep_dive）。 */
export function reportPlan(
  cold: boolean,
  warm: { type: "brief" | "deep_dive"; windowHours: number; items: number },
  coldCfg: { windowHours: number; items: number },
): { type: Report["type"]; windowHours: number; items: number } {
  return cold
    ? { type: "initial_digest", windowHours: coldCfg.windowHours, items: coldCfg.items }
    : { type: warm.type, windowHours: warm.windowHours, items: warm.items };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 把关键词拆成可匹配 token：英文按词、≥3 字符；CJK 片段 ≥2 字符。
 *  整短语子串匹配过脆（中文关键词永不命中英文摘要、英文长短语少见原样出现，曾把 arXiv 研究全过滤掉），
 *  按 token 命中可让英文研究摘要靠 software/agent/retrieval/inference 等词被识别为相关。 */
export function keywordTokens(keywords: string[]): string[] {
  const toks = new Set<string>();
  for (const kw of keywords) {
    for (const t of kw.toLowerCase().split(/[\s/]+/)) {
      const minLen = /[a-z]/.test(t) ? 3 : 2;
      if (t.length >= minLen) toks.add(t);
    }
  }
  return [...toks];
}

/** 相关度 = 命中的不同关键词 token 数（title+body 小写子串匹配）。 */
function relevanceScore(item: ContentItem, tokens: string[]): number {
  const hay = `${item.title} ${item.body}`.toLowerCase();
  return tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
}

/** 纯函数：从候选池按「相关度优先 + 来源多样」选出 ≤ limit 条用于分析。
 *  - 全量按相关度（token 命中数）降序，同分保持 recency；默认**不硬过滤 0 命中**（软策略，deep_vertical）——
 *    研究源（如 arXiv）即便措辞不同也多能命中 token；万一全 0 也由来源多样化兜底纳入；
 *  - 每源最多 ceil(limit/3) 条，避免高产源（如 OpenAI 全历史 backlog）独占切片淹没相关内容；
 *  - 名额没填满则放开每源上限补齐。
 *
 *  ADR-0010：`opts.relevanceFloor`（horizontal_pulse 主题给）= **相关性硬下限**——命中 token 数 < floor 的
 *  候选先滤掉再排选（砍纯噪声）。两条保护：① **滤空回退**（全被滤则退回软策略，避免 0 条 → `skipped-no-content`/空 brief）；
 *  ② cap+兜底在**已滤池**上进行（兜底不会捞回被滤离题项，故无需「跳兜底」、也不损 brief 厚度）。
 *  软策略（无 floor）下「候选 ≤ limit 整池返回」短路保留（行为不变）。 */
export function rankAndDiversify(
  candidates: ContentItem[],
  keywords: string[],
  limit: number,
  opts: { relevanceFloor?: number } = {},
): ContentItem[] {
  const { relevanceFloor } = opts;
  if (relevanceFloor === undefined && candidates.length <= limit) return candidates; // 软策略短路（护研究源）
  const tokens = keywordTokens(keywords);
  let scored = candidates.map((it, i) => ({ it, s: relevanceScore(it, tokens), i }));
  if (relevanceFloor !== undefined) {
    const kept = scored.filter((x) => x.s >= relevanceFloor);
    scored = kept.length > 0 ? kept : scored; // floor 保护：滤空则回退软策略（不产 0 条）
  }
  const ranked = scored.sort((a, b) => b.s - a.s || a.i - b.i);

  const perSourceCap = Math.max(2, Math.ceil(limit / 3));
  const bySource = new Map<string, number>();
  const out: ContentItem[] = [];
  // review #8c：用 Set<id> 取代 out.includes(it) 的 O(n) 线性扫描——批补齐阶段命中率高时收益明显
  const takenIds = new Set<string>();
  for (const { it } of ranked) {
    if (out.length >= limit) break;
    const c = bySource.get(it.source_id) ?? 0;
    if (c >= perSourceCap) continue;
    bySource.set(it.source_id, c + 1);
    takenIds.add(it.id);
    out.push(it);
  }
  if (out.length < limit) {
    for (const { it } of ranked) {
      if (out.length >= limit) break;
      if (!takenIds.has(it.id)) {
        takenIds.add(it.id);
        out.push(it);
      }
    }
  }
  return out;
}

/** 取某主题窗口内候选（recency 前 candidatePool 条）→ 相关+多样选 ≤ limit 条喂给 analyzer。
 *  ADR-0010：按 topic.archetype 取 profile.relevanceFloor 驱动 rankAndDiversify（horizontal_pulse 砍纯噪声）；
 *  **冷启动（initial_digest 首报）豁免硬下限**（用软策略给足份量，避免新横向主题首报被掐空）。 */
export function selectAnalysisItems(
  db: DB,
  topic: Topic,
  opts: { since: string; limit?: number; candidatePool?: number; coldStart?: boolean },
): ContentItem[] {
  const limit = opts.limit ?? 15;
  // 候选池放大到覆盖 F1 后全行业量（每源 ≤50 × 源数），避免高产源按 recency 把研究源（arXiv）
  // 挤出候选窗口、scoring 根本看不到它。打分是内存子串匹配，候选多也廉价。
  const candidates = listContentForTopic(db, topic.id, {
    since: opts.since,
    limit: opts.candidatePool ?? 800,
  });
  // ADR-0010：冷启动豁免硬下限（首报用软策略）；否则按 archetype profile 取 relevanceFloor。
  const relevanceFloor = opts.coldStart ? undefined : archetypeProfile(topic.archetype).relevanceFloor;
  return rankAndDiversify(candidates, topic.keywords, limit, { relevanceFloor });
}

/** 触发一次完整管线。库为空时 getEffectiveSources 会先播种默认 Topic/Source（首跑自举）。 */
export async function runScheduledPipeline(
  db: DB,
  opts: { windowHours?: number; itemsPerTopic?: number; reportType?: "brief" | "deep_dive" } = {},
): Promise<ScheduleSummary> {
  const startedAt = new Date().toISOString();
  const windowHours = opts.windowHours ?? Number(process.env.PIPELINE_WINDOW_HOURS ?? 168);
  const itemsPerTopic = opts.itemsPerTopic ?? (Number(process.env.PIPELINE_ITEMS_PER_TOPIC) || 15);
  const reportType = opts.reportType ?? "brief"; // 每日 brief / 周报 deep_dive（cron 按周期传入）
  // 冷启动（topic 无历史报告）→ 首版综述：更宽窗口 + 更多条，给新主题有份量的首报
  const coldWindowHours = Number(process.env.INITIAL_DIGEST_WINDOW_HOURS) || 720; // 30 天
  const coldItems = Number(process.env.INITIAL_DIGEST_ITEMS) || 25;
  const end = Date.now();
  const endIso = new Date(end).toISOString();

  const summary: ScheduleSummary = {
    startedAt,
    finishedAt: startedAt,
    windowHours,
    collected: [],
    topics: [],
    errors: [],
  };

  // 1. 采集：所有启用 Source（库空则同时播种默认配置）
  const sources = getEffectiveSources(db, loadStaticConfig()).filter((s) => s.enabled);
  for (const s of sources) {
    try {
      const r = await collectSource(db, s);
      summary.collected.push({ source: s.id, fetched: r.fetched, inserted: r.inserted, updated: r.updated });
    } catch (e) {
      summary.collected.push({ source: s.id, error: errMsg(e) });
      summary.errors.push(`collect ${s.id}: ${errMsg(e)}`);
    }
  }

  // 1b. 源健康自愈——本轮采集后判熔断（ADR-0008 决定② / 切片3b）：连续失败到阈值且多日无成功的源
  // 自动停采 + 按源告警，停止无谓重试。整段 try/catch 兜底，绝不连累已采数据 / 后续分析。
  try {
    const cfg = circuitConfig();
    const recentIngest = listRuns(db, { kind: "ingest", limit: 1000 });
    const bySrc = new Map<string, Run[]>();
    for (const r of recentIngest) {
      const sid = r.target.source_id;
      if (sid) (bySrc.get(sid) ?? bySrc.set(sid, []).get(sid)!).push(r);
    }
    const now = Date.now();
    for (const s of sources) {
      const fresh = getSource(db, s.id); // 取最新熔断态（本轮采集 run 已落库）
      if (!fresh) continue;
      const ev = evaluateCircuit(bySrc.get(s.id) ?? [], fresh, now, cfg);
      if (ev.open) {
        setCircuit(db, s.id);
        notifySourceCircuit({ sourceId: s.id, name: s.name, consecutiveFails: ev.consecutiveFails, lastError: ev.lastErrorMsg });
        (summary.circuitOpened ??= []).push(s.id); // 正常处置、独立字段，不污染 errors 语义
      }
    }
  } catch (e) {
    summary.errors.push(`circuit-check: ${errMsg(e)}`);
  }

  // 1c. 半开自愈（ADR-0008 决定② / 切片3b-2）：对系统熔断源每天探一次，成功则自动复活。
  // 落点=日跑管线旁路（不引新 cron，与决定①一致）；探测 silent（失败不刷告警）+ 单源超时 + 每轮上限。
  try {
    const max = Number(process.env.SOURCE_PROBE_MAX_PER_RUN) || 5;
    const probeTimeoutMs = Number(process.env.SOURCE_PROBE_TIMEOUT_MS) || 15_000;
    const candidates = listProbeCandidates(db, new Date().toISOString(), 86_400_000, max); // 节流 1 天
    for (const s of candidates) {
      setLastProbe(db, s.id); // 探测前先记（即便探测崩溃也已节流，防探测风暴）
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 单源超时：探测挂住不拖垮当天 brief（后台 fetch 自行结束，无害）。
        await Promise.race([
          collectSource(db, s, { probe: true }),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error("probe timeout")), probeTimeoutMs);
          }),
        ]);
        reviveSource(db, s.id); // 探测成功（collectSource 未抛）→ 复活
        notifySourceRevived({ sourceId: s.id, name: s.name });
        appendAudit(db, { actor: "system", action: "source_circuit_revive", target: s.id, detail: null });
        (summary.circuitRevived ??= []).push(s.id);
      } catch {
        // 探测失败 → 维持熔断（last_probe_at 已记，下次按节流再探），不告警
      } finally {
        if (timer) clearTimeout(timer); // 快速胜出时清掉超时定时器，不留挂起 timer
      }
    }
  } catch (e) {
    summary.errors.push(`half-open: ${errMsg(e)}`);
  }

  // 1d. 零产出看门狗（ADR-0008 决定② / 切片3b-3）：曾稳定产出的源突然连续 N 轮采集成功但 0 入库
  // （静默失败：feed 改版/解析失配/软封）→ 按源告警（边沿触发、只报不停用，交人核查）。整段 try/catch 兜底。
  try {
    const zeroRounds = Number(process.env.SOURCE_ZERO_YIELD_ROUNDS) || 5;
    const recent = listRuns(db, { kind: "ingest", limit: 1000 }); // 含本轮采集 + 半开复活后的新 run
    const bySrc = new Map<string, Run[]>();
    for (const r of recent) {
      const sid = r.target.source_id;
      if (sid) (bySrc.get(sid) ?? bySrc.set(sid, []).get(sid)!).push(r);
    }
    for (const s of sources) {
      const ze = evaluateZeroYield(bySrc.get(s.id) ?? [], zeroRounds);
      if (ze.alert) {
        notifySourceZeroYield({ sourceId: s.id, name: s.name, consecutiveZero: ze.consecutiveZero });
        (summary.zeroYield ??= []).push(s.id);
      }
    }
  } catch (e) {
    summary.errors.push(`zero-yield: ${errMsg(e)}`);
  }

  // 2-4. 每个启用 Topic：冷启动决策 → 分析→校验→生成报告（首版综述 / brief / deep_dive）
  // A5 自动熔断：每个 topic 前查预算，触顶则跳过本 topic 及之后全部（过冲上界 = 单 topic 一轮）。
  // 成本在每段 Run 完成后即落库，故此处拿到的是近实时已花额。告警每进程去重（cron 每 6h 一跑 → ≤4 条/天）。
  let budgetStopped = false;
  let budgetAlerted = false;
  for (const topic of listTopics(db, { enabledOnly: true })) {
    if (!budgetStopped) {
      const budget = getBudgetStatus(db);
      if (budget.verdict === "exceeded") {
        budgetStopped = true;
        summary.budgetStopped = true;
        notifyBudget({
          verdict: "exceeded", reason: budget.reason ?? "成本预算触顶",
          spentToday: budget.spentToday, spentMonth: budget.spentMonth, context: "auto",
        });
      } else if (budget.verdict === "alert" && !budgetAlerted) {
        budgetAlerted = true;
        notifyBudget({
          verdict: "alert", reason: budget.reason ?? "成本预算接近上限",
          spentToday: budget.spentToday, spentMonth: budget.spentMonth, context: "auto",
        });
      }
    }
    if (budgetStopped) {
      summary.topics.push({ topic: topic.id, items: 0, status: "skipped-budget-exceeded" });
      continue;
    }
    const plan = reportPlan(
      !topicHasReport(db, topic.id),
      { type: reportType, windowHours, items: itemsPerTopic },
      { windowHours: coldWindowHours, items: coldItems },
    );
    const since = new Date(end - plan.windowHours * 3_600_000).toISOString();
    // ADR-0010：initial_digest（冷启动首报）豁免 archetype 硬下限——给新横向主题足量首报。
    const items = selectAnalysisItems(db, topic, {
      since, limit: plan.items, coldStart: plan.type === "initial_digest",
    });
    if (items.length === 0) {
      summary.topics.push({ topic: topic.id, items: 0, status: "skipped-no-content", type: plan.type });
      continue;
    }
    try {
      // P1 不复报：brief 喂"近 14 天已报告 event"清单做事件对齐；deep_dive/initial_digest 不喂
      // （前者是用户触发的回顾、与日度复报概念不同；后者是冷启动首报，清单必空，无需查）。
      const history = plan.type === "brief" ? listRecentBriefEvents(db, topic.id) : [];
      const batch = await runAnalysis(db, topic, items, { start: since, end: endIso }, { history });
      const validation = await runValidation(db, batch, items);
      // 前情链接：把同主题同链上一篇 done 报告记为 prev_report_id，串成可回溯的演化链
      // （本报告尚未落库，此刻"最新 done"即上一篇，不自指）。
      const prevReportId = previousReportForTopic(db, topic.id, plan.type);
      const report = await runReportGen(db, { topic, batch, validation, type: plan.type, prevReportId });
      summary.topics.push({
        topic: topic.id,
        items: items.length,
        reportId: report.id,
        included: report.insight_ids.length,
        status: "done",
        type: plan.type,
      });
    } catch (e) {
      summary.topics.push({ topic: topic.id, items: items.length, status: `failed: ${errMsg(e)}`, type: plan.type });
      summary.errors.push(`pipeline ${topic.id}: ${errMsg(e)}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

/** 单主题端到端跑（C-1 用户触发深挖）：
 *  - 不做全局 collect（cron 已每 6h 跑，深挖不应再灌全源）；
 *  - 强制 reportType=deep_dive（不走冷启动 initial_digest 重写，"深挖"语义就要深，不要首版综述）；
 *  - 窗口默认更宽 / 条数更多（与默认 brief 区分）；
 *  - 单步失败 → 抛出（不像 runScheduledPipeline 包裹），让调用方决定告警/记录。
 *  - 复用 runAnalysis/runValidation/runReportGen 三个 Job Runner——管理看板 /admin 自然能看进度。
 *
 *  @throws
 *  - `Error("topic X 不存在")` —— topicId 找不到对应 topic；
 *  - `Error("topic X 已停用")` —— topic.enabled=false；
 *  - `Error("窗口 Nh 内无可分析内容…")` —— selectAnalysisItems 返空；
 *  - runAnalysis/runValidation/runReportGen 内部任一 runJob 抛出的错误（被 runJob 落 failed Run + notifyFailure）。
 *
 *  @remark
 *  fire-and-forget 调用方（如 `/api/topics/[id]/deep-dive`）**必须** `void p.then(_, e => log)`
 *  显式 catch reject，否则 Node runtime 下未处理 promise rejection 会触发 unhandledRejection 警告。 */
export async function runPipelineForTopic(
  db: DB,
  topicId: string,
  opts: { windowHours?: number; items?: number } = {},
): Promise<Report> {
  const topic = getTopic(db, topicId);
  if (!topic) throw new Error(`topic ${topicId} 不存在`);
  if (!topic.enabled) throw new Error(`topic ${topicId} 已停用，启用后再深挖`);

  // A5 手动路径：预算触顶不硬拦（深挖是用户主动意图，保留应急能力），但记日志 + 告警一次（放行但提示，见 decisions）。
  const budget = getBudgetStatus(db);
  if (budget.verdict === "exceeded") {
    runLogger({ stage: "deep-dive" }).warn(
      { spentToday: budget.spentToday, spentMonth: budget.spentMonth },
      `成本预算已触顶仍放行手动深挖：${budget.reason ?? ""}`,
    );
    notifyBudget({
      verdict: "exceeded", reason: budget.reason ?? "成本预算触顶",
      spentToday: budget.spentToday, spentMonth: budget.spentMonth, context: "manual",
    });
  }

  // 深挖窗口对齐 spec report-generation.md:27「最近 90 天」（#19 / ADR-0004）。成本由 itemsLimit
  // 封顶（selectAnalysisItems 排序后取前 N，候选池更大只是选得更准），不随窗口宽度线性涨，故可放宽。
  const windowHours = opts.windowHours ?? (Number(process.env.DEEP_DIVE_WINDOW_HOURS) || 2160); // 90 天
  const itemsLimit = opts.items ?? (Number(process.env.DEEP_DIVE_ITEMS) || 25);
  const end = Date.now();
  const endIso = new Date(end).toISOString();
  const since = new Date(end - windowHours * 3_600_000).toISOString();

  // ADR-0010：与定时路径口径一致——topic 首报（无历史报告）豁免 archetype 硬下限，给足份量首报；
  // 已有历史的深挖则套用 horizontal 相关性过滤（用户要的是相关深挖、非噪声）。floor-empty 保护防 0 条。
  const items = selectAnalysisItems(db, topic, {
    since, limit: itemsLimit, coldStart: !topicHasReport(db, topic.id),
  });
  if (items.length === 0) {
    throw new Error(`窗口 ${windowHours}h 内无可分析内容（请先触发 /api/cron 采集或扩大窗口）`);
  }

  const batch = await runAnalysis(db, topic, items, { start: since, end: endIso });
  const validation = await runValidation(db, batch, items);
  const prevReportId = previousReportForTopic(db, topic.id, "deep_dive");
  return runReportGen(db, { topic, batch, validation, type: "deep_dive", prevReportId });
}
