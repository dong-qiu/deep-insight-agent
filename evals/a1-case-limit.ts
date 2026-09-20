/**
 * Eval-only subset controls. A limit never changes the semantic contract of a full A1 run;
 * callers must carry `truncated` into the run's smoke/non-promotable state.
 */
export interface A1CaseSelection<T> {
  cases: T[];
  requested_limit: number;
  truncated: boolean;
}

export function parseA1CaseLimit(raw: string | undefined, name: string): number {
  if (raw == null || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数（0=全量）`);
  }
  return value;
}

/** Keep the requested control in the artifact even when its value happens to include the
 * current fixture. A non-zero control is still a bounded diagnostic invocation, not a
 * promotable full run. */
export function selectA1Cases<T>(all: T[], raw: string | undefined, name: string): A1CaseSelection<T> {
  const requested_limit = parseA1CaseLimit(raw, name);
  const cases = requested_limit === 0 ? all : all.slice(0, requested_limit);
  return { cases, requested_limit, truncated: cases.length < all.length };
}

/** A formal full run must not carry any A1 subset control. A value above today's fixture is
 * operationally equivalent for this one run, but it could silently become a subset when the
 * fixture grows; classify it as smoke now rather than letting it enter a baseline. */
export function isA1Smoke(...selections: ReadonlyArray<Pick<A1CaseSelection<unknown>, "requested_limit" | "truncated">>): boolean {
  return selections.some((selection) => selection.requested_limit !== 0 || selection.truncated);
}

/** A dedicated fast-path wrapper may force non-promotable status even when a tiny custom fixture
 * happens to fit inside every limit.  `0` is accepted only as the normal (not forced) setting;
 * any other value fails closed rather than silently changing the evidence class. */
export function a1SmokeMode(
  forced: string | undefined,
  ...selections: ReadonlyArray<Pick<A1CaseSelection<unknown>, "requested_limit" | "truncated">>
): boolean {
  if (forced != null && forced !== "" && forced !== "0" && forced !== "1") {
    throw new Error("A1_FORCE_SMOKE 只能是 0 或 1");
  }
  return forced === "1" || isA1Smoke(...selections);
}
