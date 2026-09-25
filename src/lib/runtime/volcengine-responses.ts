/**
 * Narrow adapter for Volcengine's OpenAI Responses-compatible Coding Plan endpoint.
 *
 * Keep this on native fetch rather than adding a second provider SDK: the boundary is small,
 * deterministic in tests, and avoids turning a transient provider experiment into a broad
 * dependency migration.  It deliberately requests a forced function call so the existing Zod
 * validation remains the final authority on model output.
 */
import type { TokenUsage } from "./cost.js";
import { llmBaseUrl } from "./llm-provider.js";

export const STRUCTURED_RESPONSE_TOOL_NAME = "respond_with_structured_output";

/**
 * Bounded, protocol-only evidence for a failed Responses stream. It deliberately excludes
 * event payloads: those payloads may contain the prompt, source material, or model output.
 */
export type VolcengineResponsesTerminal = "completed" | "completed_invalid_status" | "completed_protocol_violation" | "incomplete" | "failed" | "error" | "eof_before_terminal";

export interface VolcengineResponsesStreamDiagnostic {
  terminal: VolcengineResponsesTerminal;
  sawDone: boolean;
  functionArgumentsDone: boolean;
  /** Provider vocabulary is allowlisted before it can leave the SSE reader. */
  incompleteReason?: "max_output_tokens" | "max_tokens" | "other";
}

export class VolcengineResponsesError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly streamDiagnostic?: VolcengineResponsesStreamDiagnostic,
    /** Safely normalized paid-response usage, including formal terminal failures. */
    readonly usage?: TokenUsage,
  ) {
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
  /** Fixed provider-state vocabulary only; no raw SSE field is persisted beyond this boundary. */
  stopReason?: "completed" | "incomplete" | "failed" | "refusal" | "max_output_tokens" | "max_tokens" | "other";
  /** Protocol booleans are safe aggregate telemetry, including Zod-rejected completed responses. */
  streamDiagnostic: Pick<VolcengineResponsesStreamDiagnostic, "sawDone" | "functionArgumentsDone">;
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

function incompleteReason(body: ResponseBody | undefined): VolcengineResponsesStreamDiagnostic["incompleteReason"] {
  const value = body?.incomplete_details?.reason;
  if (value === "max_output_tokens" || value === "max_tokens") return value;
  return value == null ? undefined : "other";
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Extract only numeric usage fields; never retain a provider response body in a failure. */
function normalizeUsage(body: ResponseBody): TokenUsage {
  return {
    input_tokens: asNonNegativeInt(body.usage?.input_tokens),
    output_tokens: asNonNegativeInt(body.usage?.output_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: asNonNegativeInt(body.usage?.input_tokens_details?.cached_tokens),
  };
}

function endpoint(baseUrl: string): string {
  // This adapter is exported and may acquire callers beyond callStructured. Re-admit the target
  // here so no future caller can send a Coding Plan bearer key to an arbitrary compatible relay.
  const normalized = llmBaseUrl("volcengine-responses", baseUrl);
  if (!normalized) throw new VolcengineResponsesError("Volcengine Responses 缺少受控 Coding Plan endpoint");
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
async function readResponsesStream(
  response: Response,
  signal?: AbortSignal,
): Promise<{ body: ResponseBody; functionArguments: unknown; streamDiagnostic: Pick<VolcengineResponsesStreamDiagnostic, "sawDone" | "functionArgumentsDone"> }> {
  const reader = response.body?.getReader();
  if (!reader) throw new VolcengineResponsesError("Volcengine Responses 流式响应缺少 body");
  if (signal?.aborted) {
    void reader.cancel(signal.reason).catch(() => undefined);
    throw signal.reason ?? new Error("Volcengine Responses 流式请求已取消");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: ResponseBody | undefined;
  let functionArguments: unknown;
  let functionArgumentsDone = false;
  let anonymousFunctionArguments: unknown[] = [];
  let sawDone = false;
  let readsSinceYield = 0;
  let blocksSinceYield = 0;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    const reason = signal?.reason ?? new Error("Volcengine Responses 流式请求已取消");
    // A fetch signal normally aborts the body too, but do this explicitly: once a Response has
    // been returned, an already-buffered SSE reader can otherwise remain pending in runtimes or
    // test doubles that do not wire fetch cancellation through to reader.read().
    void reader.cancel(reason).catch(() => undefined);
    rejectAbort?.(reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const yieldToTimers = async (): Promise<void> => {
    // Undici may fulfil a long sequence of buffered reader.read() calls as microtasks. Yielding
    // periodically lets wall-clock abort timers run, so an A1 deadline cannot be starved by an
    // otherwise valid but never-completing SSE stream.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const streamError = (
    message: string,
    terminal: VolcengineResponsesTerminal,
    retryable = false,
    body?: ResponseBody,
  ): VolcengineResponsesError => new VolcengineResponsesError(
    message,
    undefined,
    retryable,
    {
      terminal,
      sawDone,
      functionArgumentsDone,
      ...(terminal === "incomplete" ? { incompleteReason: incompleteReason(body) } : {}),
    },
    body ? normalizeUsage(body) : undefined,
  );

  // Once a completed event carries usage, it is the only cost envelope we may trust for this
  // request. A later malformed or contradictory block must not overwrite it with a second,
  // potentially provider-private response body, nor make the paid call disappear from evidence.
  const completedProtocolError = (message: string): VolcengineResponsesError => streamError(
    message,
    "completed_protocol_violation",
    false,
    completed,
  );

  const consumeBlock = (block: string): void => {
    const data = block.split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      if (completed) {
        throw completedProtocolError("Volcengine Responses 完成事件后包含无效 JSON");
      }
      throw streamError("Volcengine Responses 流式响应包含无效 JSON", "error");
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
      if (!completedBody) throw completedProtocolError("Volcengine Responses 完成事件缺少 response");
      if (completed) throw completedProtocolError("Volcengine Responses 流式响应包含重复完成事件");
      completed = completedBody as ResponseBody;
      return;
    }
    if (event.type === "response.incomplete") {
      const body = asRecord(event.response) as ResponseBody | undefined;
      if (completed) throw completedProtocolError("Volcengine Responses 完成事件后收到矛盾终态");
      throw streamError("Volcengine Responses 流式请求未完成", "incomplete", false, body);
    }
    if (event.type === "response.failed") {
      if (completed) throw completedProtocolError("Volcengine Responses 完成事件后收到矛盾终态");
      throw streamError("Volcengine Responses 流式请求失败", "failed", false, asRecord(event.response) as ResponseBody | undefined);
    }
    if (event.type === "response.error" || event.type === "error") {
      if (completed) throw completedProtocolError("Volcengine Responses 完成事件后收到矛盾终态");
      throw streamError("Volcengine Responses 流式请求返回错误事件", "error", false, asRecord(event.response) as ResponseBody | undefined);
    }
  };

  try {
    while (true) {
      const { value, done } = signal ? await Promise.race([reader.read(), aborted]) : await reader.read();
      // `reader.cancel()` may make an in-flight read resolve as `{ done: true }` before the
      // abort rejection wins the race. Preserve the caller's terminal reason in that ordering.
      if (signal?.aborted) throw signal.reason ?? new Error("Volcengine Responses 流式请求已取消");
      buffer += decoder.decode(value, { stream: !done });
      if (++readsSinceYield >= 64) {
        readsSinceYield = 0;
        await yieldToTimers();
      }
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const boundary = separator.index;
        consumeBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + separator[0].length);
        if (++blocksSinceYield >= 64) {
          blocksSinceYield = 0;
          await yieldToTimers();
        }
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => undefined);
  }
  if (buffer.trim()) consumeBlock(buffer);
  // The remote peer may close an otherwise healthy SSE connection before emitting its terminal
  // event. The partial response remains unusable and is never accepted; mark only this transport
  // condition retryable so callStructured can make a bounded fresh request.
  if (!completed) {
    throw streamError("Volcengine Responses 流式响应在完成事件前结束", "eof_before_terminal", true);
  }
  if (!functionArgumentsDone && anonymousFunctionArguments.length === 1) {
    const expectedFunctionCalls = completed.output?.filter(
      (item) => item.type === "function_call" && item.name === STRUCTURED_RESPONSE_TOOL_NAME,
    ) ?? [];
    if (expectedFunctionCalls.length === 1) {
      functionArgumentsDone = true;
      functionArguments = anonymousFunctionArguments[0];
    }
  }
  // Keep completed usage and protocol booleans together; the caller may use them for bounded
  // transport recovery while still accounting every paid response.
  return { body: completed, functionArguments, streamDiagnostic: { sawDone, functionArgumentsDone } };
}

/** Perform one streaming structured response. The caller supplies the wall-clock AbortSignal. */
export async function callVolcengineResponses(
  request: VolcengineResponsesRequest,
): Promise<VolcengineResponsesResult> {
  const response = await fetch(endpoint(request.baseUrl), {
    method: "POST",
    // The admission check above applies to this request only. Node fetch strips Authorization on
    // a cross-origin redirect but still forwards the POST body, which contains prompts/source
    // material. Never follow any redirect so neither credentials nor protected input escape the
    // allowlisted Coding Plan origin.
    redirect: "error",
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

  const { body, functionArguments, streamDiagnostic } = await readResponsesStream(response, request.signal);
  const usage = normalizeUsage(body);
  // A `response.completed` event is valid only when its own response status confirms completion.
  // Never allow contradictory, missing, or provider-private status text to carry schema-valid
  // arguments into an analyzer/validator result. Usage is retained for paid failure accounting.
  if (body.status !== "completed") {
    throw new VolcengineResponsesError(
      "Volcengine Responses 完成事件包含无效终态",
      undefined,
      false,
      { terminal: "completed_invalid_status", ...streamDiagnostic },
      usage,
    );
  }
  if (!streamDiagnostic.functionArgumentsDone) {
    // This is a transport-contract defect after a completed, paid response, not a semantic model
    // refusal. Account its usage, then fail closed: a provider-declared completion is not a
    // connection loss, so resubmitting protected input would add an unapproved paid request.
    throw new VolcengineResponsesError(
      "Volcengine Responses 完成事件缺少函数参数完成事件",
      undefined,
      false,
      { terminal: "completed", ...streamDiagnostic },
      usage,
    );
  }

  return {
    // Missing/invalid function arguments deliberately reach the Zod gate as undefined/raw text,
    // after usage has been returned and accounted. HTTP failures still throw above.
    input: parseFunctionArguments(functionArguments),
    usage,
    stopReason: "completed",
    streamDiagnostic,
  };
}
