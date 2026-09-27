/** Fixed protocol vocabulary only. Unknown strings must never reach logs or artifacts. */
export type IncompleteReason = "max_output_tokens" | "max_tokens" | "content_filter" | "other";
export type IncompleteDiagnostic = {
  reason?: IncompleteReason;
  reasonShape: "missing" | "string" | "invalid";
  contentFilterPresent: boolean;
  usagePresent: boolean;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function reason(value: unknown): IncompleteReason | undefined {
  if (value === "max_output_tokens" || value === "max_tokens" || value === "content_filter") return value;
  return value == null ? undefined : "other";
}

/** Re-project at the telemetry sink as well: even typed errors may be mutated by callers. */
export function sanitizeIncompleteDiagnostic(value: unknown): IncompleteDiagnostic {
  const data = record(value);
  const numeric = Object.fromEntries(["inputTokens", "outputTokens", "reasoningTokens"]
    .flatMap((key) => token(data?.[key]) === undefined ? [] : [[key, token(data?.[key])]]));
  return {
    ...(reason(data?.reason) === undefined ? {} : { reason: reason(data?.reason) }),
    reasonShape: data?.reasonShape === "missing" || data?.reasonShape === "string" ? data.reasonShape : "invalid",
    contentFilterPresent: data?.contentFilterPresent === true,
    usagePresent: data?.usagePresent === true,
    ...(data?.usagePresent === true ? numeric : {}),
  };
}

/** Presence is not a causal diagnosis; absent/malformed usage is not a reported zero. */
export function readIncompleteDiagnostic(body: unknown): IncompleteDiagnostic {
  const data = record(body);
  const details = record(data?.incomplete_details);
  const usage = record(data?.usage);
  return sanitizeIncompleteDiagnostic({
    reason: reason(details?.reason),
    reasonShape: details?.reason == null ? "missing" : typeof details.reason === "string" ? "string" : "invalid",
    contentFilterPresent: !!record(details?.content_filter),
    usagePresent: !!usage,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    reasoningTokens: record(usage?.output_tokens_details)?.reasoning_tokens,
  });
}
