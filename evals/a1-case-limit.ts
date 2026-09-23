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

/**
 * A named subset keeps a small safety fixture representative without reordering or copying the
 * formal benchmark. Named selection is always non-promotable: fixture growth must not silently
 * turn a curated sample into a full A1 run.
 */
export function selectA1CasesByIds<T extends { id: string }>(all: T[], raw: string | undefined, name: string): A1CaseSelection<T> {
  const requested = raw?.trim();
  if (!requested) return { cases: all, requested_limit: 0, truncated: false };
  const ids = requested.split(",").map((id) => id.trim());
  if (!ids.length || ids.some((id) => !id)) throw new Error(`${name} 必须是逗号分隔的非空 case id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${name} 不能包含重复 case id`);
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  if (byId.size !== all.length) throw new Error(`${name} 的 fixture 含重复 case id`);
  const cases = ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`${name} 包含 fixture 中不存在的 case id: ${id}`);
    return entry;
  });
  return { cases, requested_limit: ids.length, truncated: cases.length < all.length };
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
