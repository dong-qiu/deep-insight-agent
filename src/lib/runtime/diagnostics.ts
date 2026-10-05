/** Diagnostic copies only: never feed these summaries back into retry/acceptance decisions. */
import { classifyTransportFailure, TRANSPORT_FAILURE_LABELS } from "./transport-diagnostics.js";

const OMITTED = "[REDACTED]";
const TYPES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "TimeoutError", "Timeout", "AbortError",
  "APIError", "APIConnectionError", "APIConnectionTimeoutError", "RateLimitError", "InternalServerError",
  "AuthenticationError", "PermissionDeniedError", "BadRequestError", "NotFoundError", "SqliteError",
  "ZodError", "ValidationDegraded", "OrphanedOnRestart", "VolcengineResponsesError",
  "cancelled", "RuntimeConfigError", "RelayUnavailableError", "QuoteCoverageAuditError", "QuoteCoverageRejectedError"]);
const REASONS = new Set(["task_budget_exceeded", "task_budget_cost_invalid", "invalid_task_budget", "usage_persistence_failed", "cancelled", "task_deadline_exceeded", "generation_fence_lost", "operation_failed", "sqlite_busy", "sqlite_constraint", "validation_failed",
  "authentication_failed", "orphaned_run", "no_releasable_insight", ...TRANSPORT_FAILURE_LABELS]);

/** Only a bounded vocabulary survives; arbitrary provider messages, bodies and stacks do not. */
export function safeError(error: unknown): { type: string; message: string } {
  try {
    const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const name = e.name ?? e.type;
    const type = typeof name === "string" && TYPES.has(name) ? name : "Error";
    const status = e.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return { type, message: `http_error_${status}` };
    }
    const message = e.message;
    // Idempotence matters: runJob, repository and notification each enforce their own boundary.
    if (typeof message === "string" && (REASONS.has(message) || /^http_error_[45]\d\d$/.test(message))) return { type, message };
    if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED") return { type, message: "sqlite_busy" };
    if (typeof e.code === "string" && /^SQLITE_CONSTRAINT(?:_[A-Z]+)?$/.test(e.code)) return { type, message: "sqlite_constraint" };
    const transport = classifyTransportFailure(error);
    if (transport) return { type, message: transport };
    if (type === "ZodError" || type === "ValidationDegraded") return { type, message: "validation_failed" };
    if (type === "AuthenticationError" || type === "PermissionDeniedError") return { type, message: "authentication_failed" };
    if (type === "OrphanedOnRestart") return { type, message: "orphaned_run" };
    if (type === "Timeout") return { type, message: "transport_timeout" };
    return { type, message: "operation_failed" };
  } catch { return { type: "Error", message: "operation_failed" }; }
}

/** Defense in depth for code-owned log messages; NOT a classifier for arbitrary private prose. */
export function redactDiagnosticText(text: string): string {
  if (text.length > 8192) return "[OVERSIZE DIAGNOSTIC OMITTED]";
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, OMITTED)
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try { const url = new URL(raw); return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/${OMITTED}`; }
      catch { return OMITTED; }
    })
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, OMITTED)
    .replace(/\b((?:set-)?cookie|authorization)\s*:\s*[^\r\n]+/gi, `$1: ${OMITTED}`)
    .replace(/((?:[\w-]*(?:api[_-]?key|password|passwd|secret|token|authorization|cookie|credential)|SMTP_PASS|access[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, `$1${OMITTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, OMITTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, OMITTED);
}

const PRIVATE_FIELD = /(?:apikey|token|password|passwd|secret|credential|authorization|cookie|sessionversion|privatekey|accesskey|body|payload|prompt)|pass$|^(?:request|response|raw|content|quote|statement|stack|cause|email)$/;
// Only exact, numeric usage counters are exempt: a string under these names is still private.
const USAGE_COUNTER = /^(?:tokens|inputtokens|outputtokens|totaltokens|cachedtokens|cachereadinputtokens|cachecreationinputtokens)$/;

/** Bounded, non-mutating copy for structured diagnostics. Do not use on business data. */
export function redactDiagnostic(input: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): unknown {
    if (typeof value === "string") return redactDiagnosticText(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return "[UNSUPPORTED]";
    if (depth >= 12 || seen.has(value)) return "[NESTED DIAGNOSTIC OMITTED]";
    seen.add(value);
    try {
      if (value instanceof Error) return safeError(value);
      if (Array.isArray(value)) return value.length > 64 ? "[OVERSIZE DIAGNOSTIC OMITTED]" : value.map((v) => visit(v, depth + 1));
      const entries = Object.entries(value);
      if (entries.length > 64) return "[OVERSIZE DIAGNOSTIC OMITTED]";
      return Object.fromEntries(entries.map(([key, v]) => {
        const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        const safeKey = redactDiagnosticText(key);
        if (PRIVATE_FIELD.test(normalized) && !(USAGE_COUNTER.test(normalized) && typeof v === "number" && Number.isFinite(v))) return [safeKey, OMITTED];
        if (normalized === "err" || normalized === "error") return [safeKey, safeError(v)];
        return [safeKey, visit(v, depth + 1)];
      }));
    } catch { return "[UNREADABLE DIAGNOSTIC OMITTED]"; }
  }
  return visit(input, 0);
}

/** Pino's final JSON boundary also covers interpolation, child bindings and serializers/toJSON. */
export function redactLogLine(line: string): string {
  try {
    if (line.length > 65536) throw new Error("oversize");
    return `${JSON.stringify(redactDiagnostic(JSON.parse(line)))}\n`;
  } catch { return '{"level":50,"msg":"unreadable_or_oversize_diagnostic_omitted"}\n'; }
}
