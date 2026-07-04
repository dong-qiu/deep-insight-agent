/** 源健康自愈（ADR-0008 决定② / 切片3b）：熔断 / 半开探测复活 / 零产出看门狗。
 *  每轮日跑管线在采集后旁路执行（不引新 cron，与决定①一致）。从 scheduler.ts 抽出（行为中性）——
 *  三段各自 try/catch 兜底、绝不连累已采数据 / 后续分析，返回结果由编排端合并进 ScheduleSummary。
 *  纯决策逻辑在 run-stats.ts（evaluateCircuit/evaluateZeroYield）；接线特征化测试见 scheduler.source-health.test.ts。 */
import { appendAudit } from "../db/audit.js";
import type { DB } from "../db/index.js";
import { getSource, listProbeCandidates, listRuns, reviveSource, setCircuit, setLastProbe } from "../db/repos.js";
import { notifySourceCircuit, notifySourceRevived, notifySourceZeroYield } from "../runtime/alert.js";
import { circuitConfig, evaluateCircuit, evaluateZeroYield } from "../runtime/run-stats.js";
import type { Run, Source } from "../types.js";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** source_id → 其 ingest run 列表（按传入 run 集分组）。 */
function groupBySource(runs: Run[]): Map<string, Run[]> {
  const bySrc = new Map<string, Run[]>();
  for (const r of runs) {
    const sid = r.target.source_id;
    if (sid) (bySrc.get(sid) ?? bySrc.set(sid, []).get(sid)!).push(r);
  }
  return bySrc;
}

/** 1b 熔断判定：本轮采集后，对连续失败到阈值且多日无成功的源自动停采 + 按源告警，停止无谓重试。
 *  返回本轮被熔断的源 id（正常处置、独立记账、不计 errors）+ 兜底捕获的 error。 */
export function runCircuitCheck(db: DB, sources: Source[]): { opened: string[]; errors: string[] } {
  const opened: string[] = [];
  const errors: string[] = [];
  try {
    const cfg = circuitConfig();
    const recentIngest = listRuns(db, { kind: "ingest", limit: 1000 });
    const bySrc = groupBySource(recentIngest);
    const now = Date.now();
    for (const s of sources) {
      const fresh = getSource(db, s.id); // 取最新熔断态（本轮采集 run 已落库）
      if (!fresh) continue;
      const ev = evaluateCircuit(bySrc.get(s.id) ?? [], fresh, now, cfg);
      if (ev.open) {
        setCircuit(db, s.id);
        notifySourceCircuit({ sourceId: s.id, name: s.name, consecutiveFails: ev.consecutiveFails, lastError: ev.lastErrorMsg });
        opened.push(s.id);
      }
    }
  } catch (e) {
    errors.push(`circuit-check: ${errMsg(e)}`);
  }
  return { opened, errors };
}

/** 1c 半开自愈（切片3b-2）：对系统熔断源每天探一次，成功则自动复活。
 *  探测 silent（失败不刷告警）+ 单源超时 + 每轮上限。返回本轮复活的源 id + 兜底 error。 */
export async function runHalfOpenProbe(
  db: DB,
  collectSource: (db: DB, s: Source, opts?: { probe?: boolean }) => Promise<unknown>,
): Promise<{ revived: string[]; errors: string[] }> {
  const revived: string[] = [];
  const errors: string[] = [];
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
        revived.push(s.id);
      } catch {
        // 探测失败 → 维持熔断（last_probe_at 已记，下次按节流再探），不告警
      } finally {
        if (timer) clearTimeout(timer); // 快速胜出时清掉超时定时器，不留挂起 timer
      }
    }
  } catch (e) {
    errors.push(`half-open: ${errMsg(e)}`);
  }
  return { revived, errors };
}

/** 1d 零产出看门狗（切片3b-3）：曾稳定产出的源突然连续 N 轮采集成功但 0 入库
 *  （静默失败：feed 改版/解析失配/软封）→ 按源告警（边沿触发、只报不停用，交人核查）。
 *  须在半开探测之后调用（listRuns 含本轮采集 + 半开复活后的新 run）。返回本轮告警源 id + 兜底 error。 */
export function runZeroYieldWatch(db: DB, sources: Source[]): { zeroYield: string[]; errors: string[] } {
  const zeroYield: string[] = [];
  const errors: string[] = [];
  try {
    const zeroRounds = Number(process.env.SOURCE_ZERO_YIELD_ROUNDS) || 5;
    const recent = listRuns(db, { kind: "ingest", limit: 1000 });
    const bySrc = groupBySource(recent);
    for (const s of sources) {
      const ze = evaluateZeroYield(bySrc.get(s.id) ?? [], zeroRounds);
      if (ze.alert) {
        notifySourceZeroYield({ sourceId: s.id, name: s.name, consecutiveZero: ze.consecutiveZero });
        zeroYield.push(s.id);
      }
    }
  } catch (e) {
    errors.push(`zero-yield: ${errMsg(e)}`);
  }
  return { zeroYield, errors };
}
