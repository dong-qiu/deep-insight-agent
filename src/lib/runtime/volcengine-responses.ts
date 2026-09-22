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
type StreamEvent = {
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  response?: unknown;
};

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Consume the small subset of the Responses SSE contract that has been admission-probed against
 * Coding Plan: the completed event carries status/usage and the function-arguments done event
 * carries our forced structured result. Do not log event bodies: they can contain model output.
 */
async function readResponsesStream(response: Response): Promise<{ body: ResponseBody; functionArguments: unknown }> {
  const reader = response.body?.getReader();
  if (!reader) throw new VolcengineResponsesError("Volcengine Responses 流式响应缺少 body");
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: ResponseBody | undefined;
  let functionArguments: unknown;
  let functionArgumentsDone = false;
  let anonymousFunctionArguments: unknown[] = [];

  const consumeBlock = (block: string): void => {
    const data = block.split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      throw new VolcengineResponsesError("Volcengine Responses 流式响应包含无效 JSON");
    }
    if (event.type === "response.function_call_arguments.done" && event.name === STRUCTURED_RESPONSE_TOOL_NAME) {
      functionArgumentsDone = true;
      functionArguments = event.arguments;
      return;
    }
    if (event.type === "response.function_call_arguments.done" && event.name === undefined) {
      // Some Coding Plan gateway streams omit `name` on the arguments-done event, while their
      // paired completed event retains the function_call name. Do not accept an anonymous event
      // by itself: it is resolved only below against exactly one expected completed output item.
      anonymousFunctionArguments.push(event.arguments);
      return;
    }
    if (event.type === "response.completed") {
      const completedBody = asRecord(event.response);
      if (!completedBody) throw new VolcengineResponsesError("Volcengine Responses 完成事件缺少 response");
      completed = completedBody as ResponseBody;
      return;
    }
    if (event.type === "response.failed") throw new VolcengineResponsesError("Volcengine Responses 流式请求失败");
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const boundary = separator.index;
      consumeBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + separator[0].length);
    }
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!completed) throw new VolcengineResponsesError("Volcengine Responses 流式响应在完成事件前结束");
  if (!functionArgumentsDone && anonymousFunctionArguments.length === 1) {
    const expectedFunctionCalls = completed.output?.filter(
      (item) => item.type === "function_call" && item.name === STRUCTURED_RESPONSE_TOOL_NAME,
    ) ?? [];
    if (expectedFunctionCalls.length === 1) {
      functionArgumentsDone = true;
      functionArguments = anonymousFunctionArguments[0];
    }
  }
  if (!functionArgumentsDone) throw new VolcengineResponsesError("Volcengine Responses 流式响应缺少函数参数完成事件");
  return { body: completed, functionArguments };
}

/** Perform one streaming structured response. The caller supplies the wall-clock AbortSignal. */
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
      // Long analyzer outputs must start arriving before a gateway's whole-response timeout. This
      // exact event contract was admission-probed against the Coding Plan endpoint on 2026-09-21.
      stream: true,
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

  const { body, functionArguments } = await readResponsesStream(response);

  return {
    // Missing/invalid function arguments deliberately reach the Zod gate as undefined/raw text,
    // after usage has been returned and accounted. HTTP failures still throw above.
    input: parseFunctionArguments(functionArguments),
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
