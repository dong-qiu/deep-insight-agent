/**
 * 模型计价 —— A1 切片版的 Cost Meter 雏形（architecture「共用运行时 · Cost Meter」）。
 * 价格 USD / 1M tokens，取自 claude-api skill「Current Models」（校对 2026-04-29）。
 * 价格会变，作 A5 成本判定前请核对官方价目。
 */
export interface ModelPricing {
  input: number;
  output: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { input: 5, output: 25 }, // Opus 4.8（2026 新版，与 4.7 同档）—— 2026-06-03 补：曾因不在表内致 amount=0 静默走过路径
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** 未知模型的"保守估算"上限：取已知表内最贵价格。用于 unknown-model 不再静默走 $0
 *  （计费数据偏低 → 成本控制误判）；同时 console.warn 暴露配置/价目表缺漏。 */
export const FALLBACK_PRICING: ModelPricing = (() => {
  const all = Object.values(PRICING);
  return {
    input: Math.max(...all.map((p) => p.input)),
    output: Math.max(...all.map((p) => p.output)),
  };
})();

const CACHE_WRITE_MULT = 1.25; // 缓存写入 = 1.25 × 输入价
const CACHE_READ_MULT = 0.1; // 缓存读取 = 0.1 × 输入价

/** SDK usage 的子集（只取计价需要的字段，便于纯函数测试） */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** 估算单次调用成本（USD）。未知模型返回 null（无法计价）。 */
export function costUSD(model: string, u: TokenUsage): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const inputUSD =
    (u.input_tokens * p.input +
      cacheWrite * p.input * CACHE_WRITE_MULT +
      cacheRead * p.input * CACHE_READ_MULT) /
    1_000_000;
  const outputUSD = (u.output_tokens * p.output) / 1_000_000;
  return inputUSD + outputUSD;
}
