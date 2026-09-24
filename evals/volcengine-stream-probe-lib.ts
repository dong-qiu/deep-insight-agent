/** Pure helpers for the live Volcengine stream probe. No provider call or env access lives here. */

export const VOLCENGINE_STREAM_PROBE_SCHEMA_VERSION = "volcengine-stream-probe-v1";

export interface VolcengineStreamProbeProfile {
  id: string;
  inputChars: number;
  maxTokens: number;
}

export const VOLCENGINE_STREAM_PROBE_PROFILES: readonly VolcengineStreamProbeProfile[] = [
  { id: "short_256", inputChars: 1_024, maxTokens: 256 },
  // Keep the requested structured result short in every profile. The probe is meant to measure
  // transport admission under different input/budget settings, not a model's willingness to emit
  // thousands of filler characters as a false proxy for SSE reliability.
  { id: "coverage_1024", inputChars: 8_192, maxTokens: 1_024 },
  { id: "coverage_2048", inputChars: 16_384, maxTokens: 2_048 },
  // These explicitly isolate the accepted output ceiling from input size.
  { id: "short_4096", inputChars: 1_024, maxTokens: 4_096 },
  { id: "short_8192", inputChars: 1_024, maxTokens: 8_192 },
];

export type ProbeFailure = {
  error_type: string;
  terminal?: "completed" | "incomplete" | "failed" | "error" | "eof_before_terminal";
  incomplete_reason?: "max_output_tokens" | "max_tokens" | "other";
  http_status?: number;
  saw_done?: boolean;
  function_arguments_done?: boolean;
};

export type ProbeAttempt = {
  profile_id: VolcengineStreamProbeProfile["id"];
  duration_ms: number;
  failure?: ProbeFailure;
};

const SAFE_PROBE_ERROR_TYPES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "ZodError",
  "VolcengineResponsesError", "APIConnectionError", "RateLimitError", "InternalServerError",
]);

/** `Error.name` is mutable, so retain only a code-owned allowlist in probe artifacts or CLI output. */
export function safeProbeErrorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return SAFE_PROBE_ERROR_TYPES.has(name) ? name : "UnknownError";
}

/** Failed HTTP status is useful transport evidence only inside the protocol range. */
export function safeProbeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export function probeAttemptsPerProfile(raw = process.env.VOLCENGINE_STREAM_PROBE_ATTEMPTS): number {
  // Nine small calls across the default profiles are enough to expose a recurring transport
  // failure while keeping this diagnostic materially cheaper than a full A1 run. Operators can
  // request the bounded ten-attempt sample when they need a deeper incident measurement.
  if (raw == null || raw.trim() === "") return 3;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error("VOLCENGINE_STREAM_PROBE_ATTEMPTS 必须是 1 到 10 的整数");
  }
  return value;
}

export function selectProbeProfiles(raw = process.env.VOLCENGINE_STREAM_PROBE_PROFILE_IDS): readonly VolcengineStreamProbeProfile[] {
  // Preserve the three-step default diagnostic; escalation profiles must be selected explicitly.
  if (raw == null || raw.trim() === "") return VOLCENGINE_STREAM_PROBE_PROFILES.slice(0, 3);
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (!requested.length) throw new Error("VOLCENGINE_STREAM_PROBE_PROFILE_IDS 必须至少包含一个 profile id");
  const byId = new Map(VOLCENGINE_STREAM_PROBE_PROFILES.map((profile) => [profile.id, profile]));
  return requested.map((id) => {
    const profile = byId.get(id);
    if (!profile) throw new Error(`未知的 VOLCENGINE_STREAM_PROBE_PROFILE_IDS: ${id}`);
    return profile;
  });
}

export function syntheticProbeInput(chars: number): string {
  const prefix = "Synthetic transport-only context. It contains no external source, credential, or user content. ";
  return prefix + "x".repeat(Math.max(0, chars - prefix.length));
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
}

function counts(values: readonly string[]): Record<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return Object.fromEntries([...result.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function summarizeProbeProfile(
  profile: VolcengineStreamProbeProfile,
  attempts: readonly ProbeAttempt[],
): {
  profile: VolcengineStreamProbeProfile;
  attempts: number;
  successes: number;
  failures: number;
  latency_ms: { p50: number; p95: number; max: number };
  error_types: Record<string, number>;
  terminal_events: Record<string, number>;
  incomplete_reasons: Record<string, number>;
  http_statuses: Record<string, number>;
  saw_done: Record<string, number>;
  function_arguments_done: Record<string, number>;
} {
  const failures = attempts.flatMap((attempt) => attempt.failure ? [attempt.failure] : []);
  const latency = attempts.map((attempt) => Math.max(0, attempt.duration_ms));
  return {
    profile,
    attempts: attempts.length,
    successes: attempts.length - failures.length,
    failures: failures.length,
    latency_ms: {
      p50: percentile(latency, 0.5),
      p95: percentile(latency, 0.95),
      max: latency.length ? Math.max(...latency) : 0,
    },
    error_types: counts(failures.map((failure) => failure.error_type)),
    terminal_events: counts(failures.flatMap((failure) => failure.terminal ? [failure.terminal] : [])),
    incomplete_reasons: counts(failures.flatMap((failure) => failure.incomplete_reason ? [failure.incomplete_reason] : [])),
    http_statuses: counts(failures.flatMap((failure) => failure.http_status == null ? [] : [String(failure.http_status)])),
    saw_done: counts(failures.flatMap((failure) => failure.saw_done == null ? [] : [String(failure.saw_done)])),
    function_arguments_done: counts(failures.flatMap((failure) => failure.function_arguments_done == null ? [] : [String(failure.function_arguments_done)])),
  };
}

/** A diagnostic run must not look successful when an entire requested shape was unavailable. */
export function probePassed(profiles: readonly ReturnType<typeof summarizeProbeProfile>[]): boolean {
  return profiles.length > 0 && profiles.every((profile) => profile.successes > 0);
}
