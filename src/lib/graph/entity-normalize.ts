/** 知识图谱 S1.6——实体归一化（变体归并）。
 *
 * 确定性 normKey（小写 + 去标点/空格）把 `GPT-5.5`=`GPT 5.5`、`NVIDIA`=`Nvidia` 等
 * **系统性变体**归并，但 `GPT-5.5`≠`GPT-5.6`（数字不同）、`Claude`≠`Claude Code`（词不同）
 * → 零语义误并。后缀类（`Sakana AI`→`Sakana`）确定性 key 漏掉的走人工别名表（显式可控）。
 *
 * 读时归一化（图派生 + drill 匹配用），不改 DB 里的 insight.entities，可回退。
 * 先量（生产 544 实体）：仅 5 候选变体簇，4 个 normKey 归并、1 个走别名表。
 */

/** 人工别名表：确定性 key 漏掉的变体（后缀/特殊）→ 规范写法。显式、零误并风险、可控增长。
 *  约束：① key 按 trim 后精确串匹配（大小写/空格变体须各列一条）；② value 禁止再作 key
 *  （不支持链式解析；单测 `:别名表无链式` 守此不变量——否则 drill 的「展示名∈簇」反查会破）。
 *  扩充别名表时须重核 eval 基线（别名是无条件改写，见 ADR S1.6 F5）。 */
export const ENTITY_ALIASES: Record<string, string> = {
  "Sakana AI": "Sakana",
};

/** 归一化 key：小写 + 去标点/空格。**只做安全变换**（大小写/标点），不剥后缀（后缀走别名表）。 */
export function normKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** 规范分组 key：先过别名表、再归一化。同 key = 同一实体——图归并与 drill 匹配都用它（频率无关、稳定）。 */
export function canonKey(name: string): string {
  const t = name.trim();
  return normKey(ENTITY_ALIASES[t] ?? t);
}

type Named = { entities?: { name: string }[] };

/**
 * 从洞察集构建「原始名 → 展示名」规范化器：同 canonKey 的变体归并，**展示名取簇内最高频写法**
 *（图上显示 `GPT-5.5` 而非 `gpt55`；平票按字典序定，结果确定）。无变体时为恒等。
 */
export function buildCanonicalizer(insights: readonly Named[]): (name: string) => string {
  const freq = new Map<string, number>(); // 别名解析后的名 → 频次
  for (const ins of insights) {
    for (const e of ins.entities ?? []) {
      const t = e.name?.trim();
      if (!t) continue;
      const aliased = ENTITY_ALIASES[t] ?? t;
      freq.set(aliased, (freq.get(aliased) ?? 0) + 1);
    }
  }
  const byKey = new Map<string, [string, number][]>();
  for (const [name, c] of freq) {
    const k = normKey(name);
    if (!k) continue;
    let arr = byKey.get(k);
    if (!arr) {
      arr = [];
      byKey.set(k, arr);
    }
    arr.push([name, c]);
  }
  const display = new Map<string, string>(); // canonKey → 展示名
  for (const [k, arr] of byKey) {
    arr.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    display.set(k, arr[0][0]);
  }
  return (name: string) => {
    const t = name.trim();
    return display.get(canonKey(t)) ?? ENTITY_ALIASES[t] ?? t;
  };
}
