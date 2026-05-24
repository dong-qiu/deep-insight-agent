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
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

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
