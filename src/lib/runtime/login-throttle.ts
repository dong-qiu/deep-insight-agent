/** Single-process admission control, before DB/password work. Never trust forwarded IP headers.
 * Fixed windows do not slide on rejection; no live account bucket is evicted to admit a new one. */
const WINDOW_MS = 60_000;
const ACCOUNT_LIMIT = 5;
const GLOBAL_LIMIT = 60;
type Bucket = { count: number; expiresAt: number };

export class LoginThrottle {
  private readonly accounts = new Map<string, Bucket>();
  private global: Bucket = { count: 0, expiresAt: 0 };
  private readonly maxAccounts: number;

  constructor({ maxAccounts = 120 }: { maxAccounts?: number } = {}) {
    if (!Number.isSafeInteger(maxAccounts) || maxAccounts <= 0) throw new Error("invalid login throttle capacity");
    this.maxAccounts = maxAccounts;
  }

  take(accountKey: string, now: number = performance.now()): boolean {
    for (const [key, bucket] of this.accounts) {
      if (now >= bucket.expiresAt) this.accounts.delete(key);
    }
    if (now >= this.global.expiresAt) this.global = { count: 0, expiresAt: now + WINDOW_MS };
    if (this.global.count >= GLOBAL_LIMIT) return false;
    const existing = this.accounts.get(accountKey);
    if (existing && existing.count >= ACCOUNT_LIMIT) return false;
    if (!existing && this.accounts.size >= this.maxAccounts) return false;
    const bucket = existing ?? { count: 0, expiresAt: now + WINDOW_MS };
    bucket.count++;
    this.accounts.set(accountKey, bucket);
    this.global.count++;
    return true;
  }

  succeeded(accountKey: string): void {
    this.accounts.delete(accountKey);
  }
}
