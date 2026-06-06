/** 引用校验判定的共享语义帮手（纯函数，仅依赖类型）：纳入闸门 + flagged 标签文案。
 *  单点收口，避免 validator / report-gen / ppt-* 各写一份导致口径漂移；
 *  放 utils（而非 agents/report-gen）以免 service 层反向依赖 agent 层。 */
import type { CitationCheck } from "../types.js";

/** flagged 两类（验证器约定，见 CitationCheck.consistency 注释）：
 *  reachability=pass + consistency=not_evaluated = 一致性「调用失败」；否则 genuine uncertain。 */
export function isValidationError(c: Pick<CitationCheck, "verdict" | "consistency">): boolean {
  return c.verdict === "flagged" && c.consistency === "not_evaluated";
}

/** 一条引用是否"已成功校验且可纳入"：pass，或 genuine uncertain 的 flagged。
 *  「校验失败」(isValidationError) 不算——不让零条成功校验的洞察出街（闸门完整性）。 */
export function isIncludableCheck(c: Pick<CitationCheck, "verdict" | "consistency">): boolean {
  if (c.verdict === "pass") return true;
  if (c.verdict === "flagged") return !isValidationError(c);
  return false;
}

/** flagged 标签文案：genuine uncertain 优先（更实质的告警），其次校验失败；都无返空串。 */
export function flagLabel(x: { flaggedUncertain: boolean; flaggedError: boolean }): string {
  if (x.flaggedUncertain) return "待核实";
  if (x.flaggedError) return "校验失败·待重试";
  return "";
}
