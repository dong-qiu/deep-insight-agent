/** 极简内存限流（固定窗口，按 key 计数）。architecture 防滥用落点。
 *  纯实现（Map + Date.now），Edge 中间件可用；MVP 单实例够用，多实例/精细化再升级 rate-limit-flexible。 */
export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private opts: RateLimiterOptions) {}

  /** 记一次并返回是否放行。 */
  allow(key: string, now: number = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e || now >= e.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return true;
    }
    if (e.count >= this.opts.limit) return false;
    e.count++;
    return true;
  }

  /** 当前窗口剩余配额。 */
  remaining(key: string, now: number = Date.now()): number {
    const e = this.hits.get(key);
    if (!e || now >= e.resetAt) return this.opts.limit;
    return Math.max(0, this.opts.limit - e.count);
  }
}
