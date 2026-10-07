import type { PreparedData, SourceOccurrence } from "./data.js";

/** Private human work only: source bodies never go to console, Git, or an AI reviewer. */
export function renderReviewWorksheet(data: PreparedData, inherited: unknown): string {
  const legacy = inherited as { events: { event_key: string; topic: string; criticality: unknown; fixed_questions: unknown;
    source_evidence: { source_ref: SourceOccurrence["ref"]; source_spans: unknown }[] }[] };
  const groups = new Map<string, SourceOccurrence[]>();
  for (const source of data.occurrences) groups.set(source.source_key, [...(groups.get(source.source_key) ?? []), source]);
  const softwareEvents = legacy.events.filter((e) => e.topic === data.topic);
  const lines = ["# 阶段 0 软件工程完整输入人工工作表（私有探索材料）", "",
    `读者目标：${data.reader_goal}`, "",
    `固定分母：${data.runs.length} 次预登记运行、${data.attempts.length} 次实际尝试、${data.occurrences.length} 个输入 occurrence、${groups.size} 个 exact revision。正式留出为 0。`, "",
    "这份表只补完整输入的新缺项。此前人工确认的重要性和固定问题沿用，下面按精确来源 revision 列出确认出处；没有匹配则不自动套到新材料。", "",
    `原确认索引：${data.inherited_labels.path}；SHA-256：${data.inherited_labels.sha256}。原有 ${legacy.events.length} 个事件，其中软件工程 ${softwareEvents.length} 个。`, "",
    "填写规则：以完整来源为依据先标事件和重要维度，再看任何实验臂输出；AI 可准备材料，不能代填人工金标/阅读成绩。每个输入必须归到事件或说明无在范围内事件，不能只选已刊或模型已提取的材料。", "",
    "## 运行和失败分母", "",
    ...data.runs.map((run) => `- ${run.run_id} / ${run.scheduled_at} / ${run.status} / 尝试 ${run.attempt_ids.length}`), "",
    ...data.attempts.map((attempt) => `- ${attempt.run_id} / ${attempt.attempt_id} / ${attempt.kind} / 已观测候选 ${attempt.observed_candidates} / 总候选 ${attempt.total_candidates} / 历史截点 ${attempt.cutoff}`), "",
    "## 逐 revision 审阅", ""];
  let ordinal = 0;
  for (const [sourceKey, sources] of groups) {
    const source = sources[0]; ordinal++;
    const existing = softwareEvents.filter((event) => event.source_evidence.some((e) => {
      const r = e.source_ref;
      return r.locator.kind === "id" && JSON.stringify([r.locator.id, r.revision]) === sourceKey;
    }));
    const fence = "`".repeat(Math.max(3, ...(source.body?.match(/`+/g) ?? []).map((m) => m.length + 1)));
    lines.push(`### R${String(ordinal).padStart(2, "0")} — ${source.title.replace(/\n/g, " ")}`, "",
      `来源：${source.url}；形态：${source.body_kind}。`, "", `exact revision：${sourceKey}`, "",
      `正文 SHA-256：${source.body_sha256 ?? "unknown"}；证据缺口：${source.evidence_gaps.join(", ") || "none"}；来源家族：${source.family_component ?? "unknown"}（仍需语义核对，unknown 隔离）。`, "",
      "输入 occurrence：", "", ...sources.map((s) => `- ${s.occurrence_id} / ${s.run_id} / ${s.attempt_id}`), "");
    if (existing.length) lines.push("**沿用确认（无需重新审批这些确认项）**", "", ...existing.flatMap((event) => [
      `- 原事件 ${event.event_key}；重要性 ${JSON.stringify(event.criticality)}。`,
      `- 固定题及答案：${JSON.stringify(event.fixed_questions)}。`,
      `- 原来源 span 出处：${JSON.stringify(event.source_evidence.filter((e) => e.source_ref.locator.kind === "id" && JSON.stringify([e.source_ref.locator.id, e.source_ref.revision]) === sourceKey).map((e) => e.source_spans))}。`,
    ]), "");
    else lines.push("没有与这份 exact revision 匹配的已确认软件工程标签；下面只填写新增缺项。", "");
    lines.push("待补事项（每个 occurrence 分别确认适用；同 revision 可沿用一次来源审阅，但事件/历史/运行归属不得假定相同）：", "",
      "- [ ] 事件身份：主体 / 行动 / 对象或版本 / 时间；是否与其他来源为同一真实事件？（不确定写 unknown）", "",
      "| 事件 ID 或无范围内事件理由 | 重要性与读者决策理由 | 必须维度 / 次要维度 | 来源连续 span（字符 start/end） | 必要限定 | 独立性/重复理由 |", "| --- | --- | --- | --- | --- | --- |", "| 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |", "",
      "- [ ] 固定理解题：主要主张、关键依据、适用条件/局限；写来源可支持的答案及 dimension ID。已有确认题直接引用原 event_key。", "",
      "- [ ] 家族：同研究/同节目/转载/镜像/版本续报/交叉复述；已见家族永不进入正式留出，unknown 隔离。", "",
      "- [ ] 人工审阅者与日期、确认记录文件及 SHA；填写完再转入 human-labels.json。", "",
      "完整冻结正文（字符位置以 input-worklist.json 中 body 为准，不以 Markdown 行号替代）：", "", fence + "text", source.body ?? "unknown — 不得充作负例或完整金标", fence, "");
  }
  lines.push("## T04 数值与阅读预算（先探索，后冻结，再收集前瞻留出）", "",
    "这里没有预填任意阈值。需要依据探索金标供给与人工阅读初测，逐项确认样本下限、新增可刊重要维度门、重要事件/维度非劣门、错误零容忍、全刊事实/阅读预算、盲评规模、前瞻运行数、失败/成本/token/时间和停止门。每项写数值、依据资源 SHA 和人工确认收据。", "",
    "人工阅读初测另记读者、材料逐字文本/hash、固定题答案、整刊阅读时间及负担；旧非盲阅读不能算正式盲评。T04 未冻结前不收集/打开正式留出结果；当前 B1 no-go，本次未启用新模式；未访问生产，未核现场开关。", "");
  return lines.join("\n");
}
