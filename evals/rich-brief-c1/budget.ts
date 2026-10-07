/** Request reservations for a future, frozen shadow runner. No model or DB entry point. */
import { z } from "zod";
import { createTaskCancellation } from "../../src/lib/runtime/cancellation.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const micros = z.string().regex(/^(?:0|[1-9]\d{0,29})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const limitsSchema = z.object({
  arm_id: z.string().min(1), frozen_protocol_sha256: digest,
  max_requests: count, max_tokens: count, max_usd_micros: micros,
  max_elapsed_ms: count.refine((n) => n > 0),
}).strict();
const reservationSchema = z.object({
  request_id: z.string().min(1), operation: z.string().min(1),
  input_sha256: digest, ceiling_evidence_sha256: digest,
  token_ceiling: count, usd_micros_ceiling: micros,
}).strict();
const settlementSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), tokens: count, usd_micros: micros, receipt_sha256: digest }).strict(),
  z.object({ status: z.literal("unknown"), reason: z.string().min(1) }).strict(),
]);
export type ShadowBudgetLimits = z.infer<typeof limitsSchema>;
export type RequestReservation = z.infer<typeof reservationSchema>;
export type RequestSettlement = z.infer<typeof settlementSchema>;
type Row = RequestReservation & { settlement: RequestSettlement | null };

/** Each arm owns its instance. Unsettled reservations count at their complete upper bound.
 * A caller must prove request ceilings against frozen resources before calling reserve().
 * This class checks arithmetic/control, not the truth of a caller's evidence hash. */
export class ShadowRequestBudget {
  readonly #limits: Readonly<ShadowBudgetLimits>;
  get limits(): Readonly<ShadowBudgetLimits> { return this.#limits; }
  private readonly controller = new AbortController();
  private readonly cancellation;
  readonly signal: AbortSignal;
  private readonly requests = new Map<string, Row>();
  private stopped: string | null = null;
  private closed = false;

  constructor(rawLimits: ShadowBudgetLimits) {
    this.#limits = Object.freeze(limitsSchema.parse(rawLimits));
    this.cancellation = createTaskCancellation({ signal: this.controller.signal, deadlineAt: Date.now() + this.#limits.max_elapsed_ms });
    this.signal = this.cancellation.signal;
  }

  private stop(reason: string): never {
    this.stopped ??= reason;
    this.controller.abort(new Error(`shadow_budget_${this.stopped}`));
    throw new Error(`shadow_budget_${this.stopped}`);
  }

  check(): void {
    if (this.stopped) throw new Error(`shadow_budget_${this.stopped}`);
    if (this.closed) throw new Error("shadow_budget_closed");
    try { this.cancellation.check(); } catch { this.stop("deadline_or_cancelled"); }
  }

  private totals(): { tokens: bigint; usd: bigint } {
    let tokens = 0n, usd = 0n;
    for (const row of this.requests.values()) {
      const actual = row.settlement?.status === "known" ? row.settlement : null;
      tokens += BigInt(actual?.tokens ?? row.token_ceiling);
      usd += BigInt(actual?.usd_micros ?? row.usd_micros_ceiling);
    }
    return { tokens, usd };
  }

  /** Invoke immediately before every transport dispatch, including SDK retries. */
  reserve(raw: RequestReservation): void {
    this.check();
    const request = reservationSchema.parse(raw);
    if (this.requests.has(request.request_id)) this.stop("duplicate_request");
    if (this.requests.size >= this.#limits.max_requests) this.stop("request_limit");
    const used = this.totals();
    if (used.tokens + BigInt(request.token_ceiling) > BigInt(this.#limits.max_tokens)) this.stop("token_limit");
    if (used.usd + BigInt(request.usd_micros_ceiling) > BigInt(this.#limits.max_usd_micros)) this.stop("cost_limit");
    this.requests.set(request.request_id, { ...request, settlement: null });
  }

  /** Terminal evidence may arrive after cancellation; never erase the dispatched attempt. */
  settle(requestId: string, raw: RequestSettlement): void {
    const row = this.requests.get(requestId);
    if (!row) throw new Error("shadow_budget_unreserved_request");
    if (row.settlement) throw new Error("shadow_budget_rewritten_receipt");
    const parsed = settlementSchema.safeParse(raw);
    if (!parsed.success) {
      row.settlement = { status: "unknown", reason: "invalid_terminal_receipt" };
      this.stop("unknown_charge_or_usage");
    }
    const settlement = parsed.data;
    row.settlement = settlement;
    if (settlement.status === "unknown") this.stop("unknown_charge_or_usage");
    if (settlement.tokens > row.token_ceiling || BigInt(settlement.usd_micros) > BigInt(row.usd_micros_ceiling)) this.stop("ceiling_violated");
  }

  snapshot() {
    const used = this.totals();
    return {
      schema_version: "rich-brief-c1-request-budget-v1", arm_id: this.#limits.arm_id,
      frozen_protocol_sha256: this.#limits.frozen_protocol_sha256,
      status: this.stopped ? "stopped" : this.requests.size ? "observed_reservations" : "not_executed",
      stop_reason: this.stopped, requests: [...this.requests.values()].map((row) => ({ ...row, settlement: row.settlement ? { ...row.settlement } : null })),
      reserved_or_known_tokens: used.tokens.toString(), reserved_or_known_usd_micros: used.usd.toString(),
      unknown_requests: [...this.requests.values()].filter((row) => row.settlement?.status !== "known").length,
      production_allowed: false,
    };
  }

  close(): void {
    this.closed = true;
    this.controller.abort(new Error("shadow_budget_closed"));
    this.cancellation.dispose();
  }
}
