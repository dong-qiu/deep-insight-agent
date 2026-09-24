export const PROVIDER_ADMISSION_ROLES = ["analyzer", "validator", "coverage"] as const;
export type ProviderAdmissionRole = typeof PROVIDER_ADMISSION_ROLES[number];

type Usage = { input_tokens: number; output_tokens: number };

export interface ProviderAdmissionCall {
  (input: { role: ProviderAdmissionRole; thinking: boolean }): Promise<{ ok: boolean; usage: Usage }>;
}

export interface ProviderAdmissionResult {
  role: ProviderAdmissionRole;
  model: string;
  thinking: boolean;
  supported: boolean;
  usage?: Usage;
  error_type?: string;
  status?: number;
}

export interface ProviderAdmissionCanaryInput {
  provider: string;
  structuredTransportVersion: string;
  models: Record<ProviderAdmissionRole, string>;
  thinking: Record<ProviderAdmissionRole, boolean>;
  call: ProviderAdmissionCall;
}

/**
 * Keep provider failures useful without writing upstream error bodies, prompts, or credentials.
 * `Error.name` is mutable and must not be treated as already-safe upstream metadata.
 */
export function safeProviderAdmissionError(error: unknown): Pick<ProviderAdmissionResult, "error_type" | "status"> {
  const status = typeof error === "object" && error != null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  const name = error instanceof Error ? error.name : "UnknownError";
  const errorType = new Set([
    "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "ZodError",
    "VolcengineResponsesError", "APIConnectionError", "RateLimitError", "InternalServerError",
  ]).has(name) ? name : "UnknownError";
  return {
    error_type: errorType,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
  };
}

/** Calls roles serially so the admission probe neither hides a per-model failure nor creates a
 * burst against a new provider. This is a compatibility check, not a quality evaluation. */
export async function runProviderAdmissionCanary(input: ProviderAdmissionCanaryInput): Promise<{
  supported: boolean;
  provider: string;
  structured_transport_version: string;
  results: ProviderAdmissionResult[];
}> {
  const results: ProviderAdmissionResult[] = [];
  for (const role of PROVIDER_ADMISSION_ROLES) {
    const model = input.models[role];
    const thinking = input.thinking[role];
    try {
      const response = await input.call({ role, thinking });
      results.push({
        role,
        model,
        thinking,
        supported: response.ok === true,
        usage: response.usage,
      });
    } catch (error) {
      results.push({ role, model, thinking, supported: false, ...safeProviderAdmissionError(error) });
    }
  }
  return {
    supported: results.every((result) => result.supported),
    provider: input.provider,
    structured_transport_version: input.structuredTransportVersion,
    results,
  };
}
