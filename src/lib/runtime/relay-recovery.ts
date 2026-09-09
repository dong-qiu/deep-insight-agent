/**
 * A bounded, shared recovery gate for a relay that temporarily has no route to a model.
 *
 * This is deliberately narrower than generic retry: schema errors, refusals and auth errors are
 * useful failure evidence and must retain their normal caller behaviour.  Only an explicit relay
 * capacity/routing failure opens the gate.  A gate is process-local and keyed by endpoint+model,
 * so concurrent validators wait for one half-open probe instead of stampeding the relay.
 */
export const RELAY_RECOVERY_POLICY_VERSION = "relay-half-open-v1";
export const RELAY_RECOVERY_PROBE_DELAYS_MS = [10_000, 20_000, 40_000] as const;
export const RELAY_RECOVERY_MAX_PROBES = RELAY_RECOVERY_PROBE_DELAYS_MS.length;
/** Jitter is deliberately bounded so the recovery budget remains predictable and auditable. */
export const RELAY_RECOVERY_MAX_JITTER_MS = 250;
export const RELAY_RECOVERY_MAX_BACKOFF_WAIT_MS = RELAY_RECOVERY_PROBE_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
  + RELAY_RECOVERY_MAX_JITTER_MS * RELAY_RECOVERY_MAX_PROBES;
/** After an exhausted cycle, fail fast for one bounded cooldown before allowing one new
 * half-open cycle. This prevents a persistent outage from multiplying per claim or batch. */
export const RELAY_RECOVERY_EXHAUSTED_COOLDOWN_MS = RELAY_RECOVERY_MAX_BACKOFF_WAIT_MS;

export class RelayUnavailableError extends Error {
  readonly policyVersion = RELAY_RECOVERY_POLICY_VERSION;

  constructor(readonly cause: unknown) {
    super("relay capacity recovery exhausted");
    this.name = "RelayUnavailableError";
  }
}

function structuredHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const candidate = record.status ?? record.statusCode ?? record.response?.status;
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : null;
}

/** Do not treat arbitrary 5xx/model output problems as a capacity event. HTTP 429 is a stable
 * SDK-level signal even if a relay changes its message; route/capacity wording covers relays that
 * expose only text. */
export function isRelayCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (structuredHttpStatus(error) === 429) return true;
  return /无可用渠道|无可用路由|no available (?:channel|route)|all (?:groups?|routes?) .*no available|(?:service )?overload(?:ed)?|capacity (?:exhausted|unavailable)|rate limit(?:ed)?|\b429\b/i.test(message);
}

export interface RelayRecoveryStats {
  policy_version: string;
  capacity_errors: number;
  recovery_cycles: number;
  probes: number;
  recovered: number;
  exhausted: number;
  fast_failed_while_open: number;
  total_backoff_wait_ms: number;
  gate_count: number;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("relay recovery wait aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function newStats(): RelayRecoveryStats {
  return {
    policy_version: RELAY_RECOVERY_POLICY_VERSION,
    capacity_errors: 0,
    recovery_cycles: 0,
    probes: 0,
    recovered: 0,
    exhausted: 0,
    fast_failed_while_open: 0,
    total_backoff_wait_ms: 0,
    gate_count: 0,
  };
}

export interface RelayRecoveryGateOptions {
  delaysMs?: readonly number[];
  maxJitterMs?: number;
  random?: () => number;
  sleep?: Sleep;
  stats?: RelayRecoveryStats;
  exhaustedCooldownMs?: number;
  now?: () => number;
}

/** One gate owns at most one recovery probe sequence. Its initial failed call is never retried by
 * a second fast loop: it waits 10/20/40 seconds (plus bounded jitter) and probes serially. */
export class RelayRecoveryGate {
  private recovery: Promise<unknown> | null = null;
  private open: { error: RelayUnavailableError; retryAfterMs: number } | null = null;
  private readonly delaysMs: readonly number[];
  private readonly maxJitterMs: number;
  private readonly random: () => number;
  private readonly sleep: Sleep;
  private readonly stats: RelayRecoveryStats;
  private readonly exhaustedCooldownMs: number;
  private readonly now: () => number;

  constructor(options: RelayRecoveryGateOptions = {}) {
    this.delaysMs = options.delaysMs ?? RELAY_RECOVERY_PROBE_DELAYS_MS;
    this.maxJitterMs = options.maxJitterMs ?? RELAY_RECOVERY_MAX_JITTER_MS;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? sleep;
    this.stats = options.stats ?? newStats();
    this.exhaustedCooldownMs = options.exhaustedCooldownMs ?? RELAY_RECOVERY_EXHAUSTED_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  async execute<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError(signal);
    if (this.open) {
      if (this.now() < this.open.retryAfterMs) {
        this.stats.fast_failed_while_open++;
        throw this.open.error;
      }
      // Register the probe synchronously before it calls `operation()`.  At the cooldown boundary
      // concurrent callers must wait behind this promise, never each send an optimistic probe.
      this.open = null;
      return this.shareRecovery(Promise.resolve().then(() => this.resumeAfterCooldown(operation)), signal);
    }
    const inProgress = this.recovery;
    if (inProgress) {
      await waitFor(inProgress, signal);
      return this.execute(operation, signal);
    }
    try {
      return await operation();
    } catch (error) {
      if (!isRelayCapacityError(error)) throw error;
      this.stats.capacity_errors++;
      // A concurrent request can fail before the first failure's catch continuation gets here.
      // Re-check after the await boundary so only that first continuation opens the gate.
      const recoveryStartedByPeer = this.recovery;
      if (recoveryStartedByPeer) {
        await waitFor(recoveryStartedByPeer, signal);
        return this.execute(operation, signal);
      }
      // JavaScript executes this assignment without an await boundary, so every later caller sees
      // the same promise and cannot create a competing half-open probe sequence.
      // A probe belongs to the gate, not the leader: cancelling one caller must only cancel that
      // caller's wait, never the probe on which every follower depends.
      return this.shareRecovery(this.recover(operation, error), signal);
    }
  }

  private shareRecovery<T>(recovering: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.recovery = recovering;
    void recovering.then(
      () => { if (this.recovery === recovering) this.recovery = null; },
      () => { if (this.recovery === recovering) this.recovery = null; },
    );
    return waitFor(recovering, signal);
  }

  /** The first request after cooldown is itself a half-open probe and is counted even if the relay
   * has already recovered. A fresh capacity error resumes the bounded delayed probes. */
  private async resumeAfterCooldown<T>(operation: () => Promise<T>): Promise<T> {
    this.stats.recovery_cycles++;
    this.stats.probes++;
    try {
      const result = await operation();
      this.stats.recovered++;
      return result;
    } catch (error) {
      if (!isRelayCapacityError(error)) throw error;
      this.stats.capacity_errors++;
      return this.recover(operation, error, false);
    }
  }

  private async recover<T>(operation: () => Promise<T>, initialError: unknown, countCycle = true): Promise<T> {
    if (countCycle) this.stats.recovery_cycles++;
    let lastError = initialError;
    for (const delay of this.delaysMs) {
      const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * this.maxJitterMs);
      const waitMs = delay + jitter;
      this.stats.total_backoff_wait_ms += waitMs;
      await this.sleep(waitMs);
      this.stats.probes++;
      try {
        const result = await operation();
        this.stats.recovered++;
        return result;
      } catch (error) {
        lastError = error;
        if (!isRelayCapacityError(error)) throw error;
        this.stats.capacity_errors++;
      }
    }
    this.stats.exhausted++;
    const error = new RelayUnavailableError(lastError);
    this.open = { error, retryAfterMs: this.now() + this.exhaustedCooldownMs };
    throw error;
  }
}

const sharedStats = newStats();
const gates = new Map<string, RelayRecoveryGate>();

function keyFor(baseUrl: string | undefined, model: string): string {
  return `${baseUrl ?? "anthropic-default"}\u0000${model}`;
}

/** Execute a validator request behind its shared endpoint+model gate. The endpoint is retained
 * only in process memory and never written to A1 artifacts. */
export function withRelayRecovery<T>(
  input: { baseUrl: string | undefined; model: string },
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = keyFor(input.baseUrl, input.model);
  let gate = gates.get(key);
  if (!gate) {
    gate = new RelayRecoveryGate({ stats: sharedStats });
    gates.set(key, gate);
    sharedStats.gate_count = gates.size;
  }
  return gate.execute(operation, signal);
}

/** Snapshot only aggregate, non-sensitive recovery facts for A1 artifacts. */
export function relayRecoveryStats(): RelayRecoveryStats {
  return { ...sharedStats, gate_count: gates.size };
}

/** Test-only hygiene for the process-global gate registry. */
export function resetRelayRecoveryStateForTest(): void {
  gates.clear();
  Object.assign(sharedStats, newStats());
}
