/**
 * Provider selection and credential resolution for the LLM runtime.
 *
 * `anthropic` remains the compatibility default.  The Volcengine route is intentionally
 * opt-in: a Coding Plan key must never be sent to an arbitrary OpenAI-compatible endpoint,
 * and an old Anthropic relay key must never be sent to Volcengine by accident.
 */
export type LlmProvider = "anthropic" | "volcengine-responses";

const PROVIDERS: readonly LlmProvider[] = ["anthropic", "volcengine-responses"];

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Explicitly choose a provider; missing configuration preserves the established Anthropic path. */
export function llmProvider(raw = process.env.LLM_PROVIDER): LlmProvider {
  const value = nonEmpty(raw) ?? "anthropic";
  if ((PROVIDERS as readonly string[]).includes(value)) return value as LlmProvider;
  throw new Error(`不支持的 LLM_PROVIDER=${value}；支持值：${PROVIDERS.join("、")}`);
}

/**
 * Resolve the key without exposing it. `ANTHROPIC_API_KEY` is retained only for the legacy
 * provider; Volcengine requires the unambiguous `LLM_API_KEY` name.
 */
export function llmApiKey(provider = llmProvider()): string | undefined {
  const explicit = nonEmpty(process.env.LLM_API_KEY);
  if (explicit) return explicit;
  return provider === "anthropic" ? nonEmpty(process.env.ANTHROPIC_API_KEY) : undefined;
}

export function requireLlmApiKey(provider = llmProvider()): string {
  const key = llmApiKey(provider);
  if (key) return key;
  const envName = provider === "anthropic" ? "LLM_API_KEY（或兼容的 ANTHROPIC_API_KEY）" : "LLM_API_KEY";
  throw new Error(`${provider} 调用需要设置 ${envName}`);
}

/**
 * Normalise an explicitly supplied endpoint. Anthropic keeps the old relay alias; the
 * Volcengine Responses route deliberately has no legacy fallback so a target endpoint is always
 * visible in deployment configuration.
 */
export function llmBaseUrl(provider = llmProvider(), raw = process.env.LLM_BASE_URL): string | undefined {
  const configured = nonEmpty(raw) ?? (provider === "anthropic" ? nonEmpty(process.env.ANTHROPIC_BASE_URL) : undefined);
  return configured?.replace(/\/+$/, "");
}

export function requireLlmBaseUrl(provider = llmProvider()): string {
  const baseUrl = llmBaseUrl(provider);
  if (baseUrl) return baseUrl;
  if (provider === "volcengine-responses") {
    throw new Error("volcengine-responses 调用需要设置 LLM_BASE_URL（Coding Plan: https://ark.cn-beijing.volces.com/api/coding/v3）");
  }
  throw new Error(`${provider} 调用需要设置 LLM_BASE_URL`);
}

/** A vendor label for the cost ledger; it is intentionally distinct from the protocol name. */
export function llmCostProvider(provider = llmProvider()): "anthropic" | "volcengine" {
  return provider === "volcengine-responses" ? "volcengine" : "anthropic";
}

/** A change in provider transport changes A1 behaviour and therefore invalidates comparability. */
export function structuredTransportVersion(provider = llmProvider()): string {
  return provider === "volcengine-responses" ? "volcengine-responses-forced-function-v1" : "forced-tool-enabled-v1";
}
