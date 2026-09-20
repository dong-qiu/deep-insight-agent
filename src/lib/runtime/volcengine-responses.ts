/**
 * Narrow adapter for Volcengine's OpenAI Responses-compatible Coding Plan endpoint.
 *
 * Keep this on native fetch rather than adding a second provider SDK: the boundary is small,
 * deterministic in tests, and avoids turning a transient provider experiment into a broad
 * dependency migration.  It deliberately requests a forced function call so the existing Zod
 * validation remains the final authority on model output.
 */
import type { TokenUsage } from "./cost.js";

export const STRUCTURED_RESPONSE_TOOL_NAME = "respond_with_structured_output";

export class VolcengineResponsesError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "VolcengineResponsesError";
  }
}

export interface VolcengineResponsesRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  thinking: boolean;
  signal?: AbortSignal;
}

export interface VolcengineResponsesResult {
  input: unknown;
  usage: TokenUsage;
  /** `completed`, `incomplete`, etc. are evidence only; caller owns policy. */
  stopReason?: string;
}

type ResponseFunctionCall = { type?: string; name?: string; arguments?: unknown };
type ResponseBody = {
  status?: string;
  incomplete_details?: { reason?: unknown };
  output?: ResponseFunctionCall[];
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
  };
};

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function parseFunctionArguments(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      // Preserve the malformed value for the caller's Zod gate. That lets the runtime account
      // returned token usage before rejecting the model output instead of making a paid failed
      // response disappear from telemetry/cost evidence.
      return value;
    }
  }
  if (value && typeof value === "object") return value;
  return value;
}

/** Perform one non-streaming structured response. The caller supplies the wall-clock AbortSignal. */
export async function callVolcengineResponses(
  request: VolcengineResponsesRequest,
): Promise<VolcengineResponsesResult> {
  const response = await fetch(endpoint(request.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model,
      instructions: request.system,
      input: request.user,
      max_output_tokens: request.maxTokens,
      // Volcengine documents this extension as `thinking`; explicitly disabling it preserves the
      // current VALIDATOR_THINKING=0 decision rather than relying on a provider default.
      thinking: { type: request.thinking ? "enabled" : "disabled" },
      tools: [{
        type: "function",
        name: STRUCTURED_RESPONSE_TOOL_NAME,
        description: "Return the structured result strictly matching the parameters schema. Do not include text outside the function call.",
        parameters: request.jsonSchema,
        strict: true,
      }],
      tool_choice: { type: "function", name: STRUCTURED_RESPONSE_TOOL_NAME },
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    // Never interpolate a provider body here: it may echo source text, prompt material, or an
    // endpoint diagnostic. Status is enough for retry classification and safe A1 evidence.
    throw new VolcengineResponsesError(`Volcengine Responses 请求失败（HTTP ${response.status}）`, response.status);
  }

  let body: ResponseBody;
  try {
    body = await response.json() as ResponseBody;
  } catch {
    throw new VolcengineResponsesError("Volcengine Responses 返回了无效 JSON");
  }
  const call = body.output?.find((item) => item.type === "function_call" && item.name === STRUCTURED_RESPONSE_TOOL_NAME);

  return {
    // Missing/invalid function arguments deliberately reach the Zod gate as undefined/raw text,
    // after usage has been returned and accounted. HTTP failures still throw above.
    input: call ? parseFunctionArguments(call.arguments) : undefined,
    usage: {
      input_tokens: asNonNegativeInt(body.usage?.input_tokens),
      output_tokens: asNonNegativeInt(body.usage?.output_tokens),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: asNonNegativeInt(body.usage?.input_tokens_details?.cached_tokens),
    },
    stopReason: typeof body.incomplete_details?.reason === "string"
      ? body.incomplete_details.reason
      : typeof body.status === "string" ? body.status : undefined,
  };
}
