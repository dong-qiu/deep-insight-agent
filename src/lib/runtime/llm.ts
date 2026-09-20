/**
 * 最小 LLM Client —— A1 切片版。
 * 后续建骨架时扩为完整 runtime（重试 / 限流 / token 计量 / Job Runner），见 architecture「Agent 运行时」。
 *
 * 当前职责：
 *  - 模型可配（按子任务分别指定，默认 分析=sonnet-4-6 / 校验=opus-4-7）
 *  - 结构化输出（messages.stream + finalMessage + zodOutputFormat；流式避免长输出网关超时）
 *  - prompt caching（稳定 system 前缀打 cache_control）
 *  - 启动校验「校验模型 ID ≠ 分析模型 ID」（同源偏差约束）
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import type { Cost } from "../types.js";
import { FALLBACK_PRICING, costUSD, type TokenUsage } from "./cost.js";
import { llmMaxRetries, llmTimeoutMs, llmTransientRetries, llmTransientRetryBackoffMs, promptCacheOn } from "./env.js";
import { isTransientApiError } from "./errors.js";
import { llmProvider, requireLlmApiKey, requireLlmBaseUrl } from "./llm-provider.js";
import { callVolcengineResponses } from "./volcengine-responses.js";

// 已警告过的未知模型集合（每模型仅警告一次，防日志刷屏）
const warnedUnpriced = new Set<string>();
function fallbackCostUSD(model: string, u: TokenUsage): number {
  if (!warnedUnpriced.has(model)) {
    warnedUnpriced.add(model);
    console.warn(
      `⚠️ 未知模型「${model}」不在价目表（PRICING）；按已知最贵价（input $${FALLBACK_PRICING.input}/M, output $${FALLBACK_PRICING.output}/M）保守估算成本。补全 src/lib/runtime/cost.ts 的 PRICING。`,
    );
  }
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const inputUSD =
    (u.input_tokens * FALLBACK_PRICING.input +
      cacheWrite * FALLBACK_PRICING.input * 1.25 +
      cacheRead * FALLBACK_PRICING.input * 0.1) /
    1_000_000;
  const outputUSD = (u.output_tokens * FALLBACK_PRICING.output) / 1_000_000;
  return inputUSD + outputUSD;
}

export type Role = "analyzer" | "validator" | "coverage" | "followup";

/** Admission-tested against the configured relay with forced tool_choice (2026-09-10). Any
 * transport/budget change is part of EvalConfig because it changes validator behaviour. */
export const STRUCTURED_THINKING_TRANSPORT_VERSION = "forced-tool-enabled-v1";
export const STRUCTURED_THINKING_BUDGET_TOKENS = 1024;

export const MODELS: Record<Role, string> = {
  analyzer: process.env.ANALYZER_MODEL ?? "claude-sonnet-4-6",
  validator: process.env.VALIDATOR_MODEL ?? "claude-opus-4-7",
  // 展示级引用覆盖的反扩写复核必须由部署显式指定，避免它在未配置环境里与 analyzer
  // 默认同模型却要到深层 LLM 路径才失败。assertCoverageModelSeparation 给出可操作错误。
  coverage: process.env.COVERAGE_MODEL ?? "",
  // 追问生成（A4）：成本敏感、非校验路径，默认与 analyzer 同档 sonnet；
  // 一致性兜底仍走独立的 validator 角色（opus），同源偏差约束不受影响。
  followup: process.env.FOLLOWUP_MODEL ?? "claude-sonnet-4-6",
};

/** 同源偏差约束：主校验必须独立于分析模型（citation-validation 行为规约 3 / AC7）。 */
export function assertModelSeparation(): void {
  if (MODELS.analyzer === MODELS.validator) {
    throw new Error(
      `校验模型必须独立于分析模型（同源偏差约束）：` +
        `analyzer=${MODELS.analyzer} validator=${MODELS.validator}`,
    );
  }
}

/** 展示引用反扩写复核实际启用时，复核模型还必须独立于生成器与主校验。 */
export function assertCoverageModelSeparation(): void {
  assertModelSeparation();
  if (!MODELS.coverage) {
    throw new Error(
      "展示引用反扩写复核要求显式设置 COVERAGE_MODEL，且它必须不同于 ANALYZER_MODEL 与 VALIDATOR_MODEL。",
    );
  }
  if (new Set([MODELS.analyzer, MODELS.validator, MODELS.coverage]).size !== 3) {
    throw new Error(
      `展示引用反扩写复核模型必须独立于分析与主校验模型：` +
        `analyzer=${MODELS.analyzer} validator=${MODELS.validator} coverage=${MODELS.coverage}`,
    );
  }
}

// 懒加载：首次调用时才构造客户端，确保 .env.local 已被注入 process.env
// （模块 import 早于 run-a1 的 loadEnvLocal，过早 new Anthropic() 会拿不到 key）
let _client: Anthropic | null = null;
/**
 * Keep relay configuration explicit and testable. The official SDK defaults to Anthropic's
 * public API, so merely documenting ANTHROPIC_BASE_URL is insufficient: an unrecognised relay
 * credential then produces long, misleading timeouts against the wrong endpoint.
 */
export function anthropicBaseUrl(raw = process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL): string | undefined {
  const value = raw?.trim();
  return value ? value.replace(/\/+$/, "") : undefined;
}

function getClient(): Anthropic {
  // 超时取舍：原 45s 是为快速失败中转站「卡死」；但 Opus 生成 8k token 输出的合法调用可能 >45s，
  // 且每次重试也只等 45s → 合法慢生成永远成功不了（F4 live 确认暴露）。改 120s（env LLM_TIMEOUT_MS 可配），
  // 让合法慢生成跑完；中转站现已支持长响应（带思考已验证），不再需要 45s 那么激进。
  const timeout = llmTimeoutMs();
  // maxRetries 可调（LLM_MAX_RETRIES，默认 2）：中转站抖动期可临时调高兜网络层；
  // 与 validator.judgeWithRetry 的应用层重试叠加（前者管网络/5xx，后者覆盖 SDK 重试耗尽后的短窗）。
  const maxRetries = llmMaxRetries();
  const baseURL = anthropicBaseUrl();
  return (_client ??= new Anthropic({
    apiKey: requireLlmApiKey("anthropic"),
    timeout,
    maxRetries,
    ...(baseURL ? { baseURL } : {}),
  })); // key from env
}

// ── Cost Meter（进程内累计本次运行的 token / 成本） ──
export interface ModelUsage {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  usd: number;
  unpriced: boolean; // 命中未在价目表里的模型
}
export interface CostReport {
  byModel: Array<{ model: string } & ModelUsage>;
  totalUSD: number;
}

/**
 * Aggregate that is safe to persist in an A1 artifact: it contains no prompt, source body,
 * endpoint or credential. The operation name is an application-owned constant, never model
 * output or user data, so it is suitable for narrowing a stop reason to a pipeline phase.
 */
export interface CallTelemetryAggregate {
  calls: number;
  failures: number;
  /** Underlying relay requests; may exceed calls when refusal is retried. */
  requests: number;
  /** Terminal reasons returned by completed model requests. `max_tokens` remains evidence even
   * when the relay supplied a schema-valid tool use. */
  output_stop_reasons: Record<string, number>;
  latency_ms: { p50: number; p95: number; max: number };
}

export interface RoleCallTelemetry extends CallTelemetryAggregate {
  /** The role-level aggregate alone cannot identify which validator phase was truncated. */
  by_operation: Record<string, CallTelemetryAggregate>;
}

const meter = new Map<string, ModelUsage>();
type MutableCallTelemetryAggregate = {
  calls: number;
  failures: number;
  requests: number;
  outputStopReasons: Map<string, number>;
  latency: number[];
};

const roleMeter = new Map<Role, {
  aggregate: MutableCallTelemetryAggregate;
  byOperation: Map<string, MutableCallTelemetryAggregate>;
}>();

function emptyMutableCallTelemetry(): MutableCallTelemetryAggregate {
  return { calls: 0, failures: 0, requests: 0, outputStopReasons: new Map<string, number>(), latency: [] };
}

function readonlyCallTelemetry(aggregate: MutableCallTelemetryAggregate): CallTelemetryAggregate {
  return {
    calls: aggregate.calls,
    failures: aggregate.failures,
    requests: aggregate.requests,
    output_stop_reasons: Object.fromEntries([...aggregate.outputStopReasons.entries()].sort(([a], [b]) => a.localeCompare(b))),
    latency_ms: {
      p50: percentile(aggregate.latency, 0.5),
      p95: percentile(aggregate.latency, 0.95),
      max: aggregate.latency.length ? Math.max(...aggregate.latency) : 0,
    },
  };
}

function recordCallTelemetry(
  aggregate: MutableCallTelemetryAggregate,
  latencyMs: number,
  requests: number,
  failed: boolean,
  outputStopReasons: readonly string[],
): void {
  aggregate.calls++;
  aggregate.requests += requests;
  if (failed) aggregate.failures++;
  for (const reason of outputStopReasons) {
    if (!reason) continue;
    aggregate.outputStopReasons.set(reason, (aggregate.outputStopReasons.get(reason) ?? 0) + 1);
  }
  aggregate.latency.push(Math.max(0, latencyMs));
}

const percentile = (values: readonly number[], fraction: number): number => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
};

/** Exported for deterministic tests and non-LLM harnesses; production calls record it in
 * callStructured's finally block so failures and retries cannot disappear from A1 evidence. */
export function recordRoleCallTelemetry(
  role: Role,
  latencyMs: number,
  requests: number,
  failed: boolean,
  outputStopReasons: readonly string[] = [],
  /** Use a code-owned, bounded operation identifier; omitted calls remain visibly unclassified. */
  operation = "unclassified",
): void {
  const meter = roleMeter.get(role) ?? { aggregate: emptyMutableCallTelemetry(), byOperation: new Map<string, MutableCallTelemetryAggregate>() };
  const operationMeter = meter.byOperation.get(operation) ?? emptyMutableCallTelemetry();
  recordCallTelemetry(meter.aggregate, latencyMs, requests, failed, outputStopReasons);
  recordCallTelemetry(operationMeter, latencyMs, requests, failed, outputStopReasons);
  meter.byOperation.set(operation, operationMeter);
  roleMeter.set(role, meter);
}

export function getRoleCallTelemetry(): Record<Role, RoleCallTelemetry> {
  return Object.fromEntries((["analyzer", "validator", "coverage", "followup"] as Role[]).map((role) => {
    const meter = roleMeter.get(role) ?? { aggregate: emptyMutableCallTelemetry(), byOperation: new Map<string, MutableCallTelemetryAggregate>() };
    return [role, {
      ...readonlyCallTelemetry(meter.aggregate),
      by_operation: Object.fromEntries([...meter.byOperation.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([operation, aggregate]) => [operation, readonlyCallTelemetry(aggregate)])),
    }];
  })) as Record<Role, RoleCallTelemetry>;
}

export function resetRoleCallTelemetry(): void {
  roleMeter.clear();
}

function record(model: string, u: TokenUsage): void {
  const agg = meter.get(model) ?? {
    calls: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    usd: 0,
    unpriced: false,
  };
  agg.calls += 1;
  agg.input += u.input_tokens ?? 0;
  agg.output += u.output_tokens ?? 0;
  agg.cacheWrite += u.cache_creation_input_tokens ?? 0;
  agg.cacheRead += u.cache_read_input_tokens ?? 0;
  // 未知模型：标 unpriced 同时**走保守估算**（不静默 $0）。曾因 VALIDATOR_MODEL 配为
  // 未入表型号致 amount=0、56 万 token 被记成 \$0，掩盖真实成本（2026-06-03）。
  const c = costUSD(model, u);
  if (c === null) {
    agg.unpriced = true;
    agg.usd += fallbackCostUSD(model, u);
  } else {
    agg.usd += c;
  }
  meter.set(model, agg);
}

export function getCostReport(): CostReport {
  const byModel = [...meter.entries()].map(([model, m]) => ({ model, ...m }));
  return { byModel, totalUSD: byModel.reduce((s, m) => s + m.usd, 0) };
}

export function resetCostMeter(): void {
  meter.clear();
}

/** 单次调用的 token/成本（按返回值透传给调用方做 per-Run 记账，避免读全局 meter 做差——并发不隔离）。
 *  未知模型用 fallbackCostUSD 保守估算（最贵已知价），不静默 \$0。 */
function usageToCost(model: string, u: TokenUsage): Cost {
  const tokens =
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const known = costUSD(model, u);
  return known === null
    ? { tokens, amount: fallbackCostUSD(model, u), estimated: true }
    : { tokens, amount: known };
}

function addCost(left: Cost, right: Cost): Cost {
  const estimated = Boolean(left.estimated || right.estimated);
  return {
    tokens: left.tokens + right.tokens,
    amount: left.amount + right.amount,
    ...(estimated ? { estimated: true } : {}),
  };
}

export interface StructuredCall<T extends z.ZodType> {
  role: Role;
  /** Code-owned pipeline phase for redaction-safe stop-reason telemetry. */
  telemetryOperation?: string;
  /** 稳定指令前缀 —— 命中 prompt cache */
  system: string;
  /** 每请求变化的内容 */
  user: string;
  schema: T;
  maxTokens?: number;
  /** 启用自适应思考 + effort=high（校验等精度敏感子任务建议开） */
  thinking?: boolean;
  /** 每次底层调用（含重试）的成本回调 —— 调用方据此做 per-Run 记账（并发隔离） */
  onCost?: (cost: Cost) => void;
  /** AbortSignal——透传到 SDK 流式请求，用于"成本上限到达 → 取消未完成调用"等场景。
   *  abort 后 SDK 抛 AbortError；调用方应当外层 catch 并按"失败"路径处理（保留已成功子结果）。 */
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  usage: TokenUsage;
  /** 本次（含内部重试）累计成本 */
  cost: Cost;
}

export function structuredThinkingConfig(enabled: boolean, maxTokens: number): Anthropic.Messages.ThinkingConfigParam | undefined {
  if (!enabled) return undefined;
  if (maxTokens <= STRUCTURED_THINKING_BUDGET_TOKENS) {
    throw new Error(`启用 thinking 时 maxTokens 必须大于 ${STRUCTURED_THINKING_BUDGET_TOKENS}`);
  }
  return { type: "enabled", budget_tokens: STRUCTURED_THINKING_BUDGET_TOKENS, display: "omitted" };
}

const STRUCTURED_TOOL_NAME = "respond_with_structured_output";

/** 模型/中转站偶发把应为 array/object 的字段返成 JSON 字符串（6b 真机：opus-4-7 经中转站把 insights 返字符串）。
 *  按 zod invalid_type 报错路径，对「期望 array/object、实得 string」的字段就地 JSON.parse；返修正副本，无可修正返 null。
 *  仅对否则会被丢弃的非法输出生效，不触碰合法输出。 */
export function coerceStringifiedFields(
  input: unknown,
  issues: readonly { code: string; path: readonly PropertyKey[]; expected?: string }[],
): unknown | null {
  if (typeof input !== "object" || input === null) return null;
  const clone = structuredClone(input);
  let changed = false;
  for (const issue of issues) {
    if (issue.code !== "invalid_type" || (issue.expected !== "array" && issue.expected !== "object")) continue;
    if (!issue.path.length) continue;
    let node: any = clone;
    for (let i = 0; i < issue.path.length - 1; i++) node = node?.[issue.path[i]];
    const key = issue.path[issue.path.length - 1];
    if (node && typeof node[key] === "string") {
      try {
        node[key] = JSON.parse(node[key]);
        changed = true;
      } catch {
        /* 不可解析则放弃该字段 */
      }
    }
  }
  return changed ? clone : null;
}

/**
 * 为一次 LLM 请求建立硬性的墙钟超时，并合并调用方的取消信号。
 *
 * Anthropic SDK 的 `timeout` 不保证会终止仍持续传输数据的 SSE 流；因此长时间不完成的
 * 中转站响应必须由我们自己的 AbortController 兜底。调用方 signal 的 reason 原样保留，
 * 便于成本上限等上层策略区分主动取消与超时。
 */
export function createRequestAbortSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    onCallerAbort();
    return { signal: controller.signal, dispose: () => {} };
  }

  if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort, { once: true });

  const delay = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM stream exceeded wall-clock timeout of ${delay}ms`));
  }, delay);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export interface TransientRetryOptions {
  /** Extra attempts after the initial call; the environment getter already bounds this to 2. */
  retries: number;
  backoffMs: number;
  signal?: AbortSignal;
  onRetry?: (error: unknown, retryNumber: number) => void;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!delayMs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("LLM request aborted before retry"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason ?? new Error("LLM request aborted before retry"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

/**
 * The SDK retries transport failures it owns, but an explicit SSE wall-clock abort is surfaced
 * by our Promise.race and bypasses those retries. Retry only classified infrastructure failures;
 * never turn a caller cancellation, refusal, or schema violation into extra model calls.
 */
export async function retryTransientOperation<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions,
): Promise<T> {
  const retries = Math.min(2, Math.max(0, options.retries));
  const sleep = options.sleep ?? abortableDelay;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("LLM request aborted before start");
    try {
      return await operation();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (!isTransientApiError(error) || attempt >= retries) throw error;
      const retryNumber = attempt + 1;
      options.onRetry?.(error, retryNumber);
      await sleep(options.backoffMs, options.signal);
    }
  }
}

/**
 * Responses-compatible implementation kept separate from the established Anthropic streaming
 * path. The Coding Plan SSE contract was admission-probed before this reader was enabled; the
 * adapter still keeps the same LLM_TIMEOUT_MS wall-clock guard and fails closed without a final
 * completion event.
 */
async function callVolcengineStructured<T extends z.ZodType>(
  opts: StructuredCall<T>,
): Promise<StructuredResult<z.infer<T>>> {
  const startedAt = performance.now();
  let underlyingRequests = 0;
  let succeeded = false;
  const outputStopReasons: string[] = [];
  try {
    const model = MODELS[opts.role];
    const maxTokens = opts.maxTokens ?? 16_000;
    // Keep the existing thinking budget guard, even though its provider-specific request shape is
    // represented by the adapter. This prevents a true setting from silently receiving too small
    // an output allowance.
    if (opts.thinking) structuredThinkingConfig(true, maxTokens);
    const jsonSchema = z.toJSONSchema(opts.schema) as Record<string, unknown>;
    if (jsonSchema.type !== "object") {
      throw new Error(`callStructured schema 根类型必须是 object（当前 ${String(jsonSchema.type ?? "<未知>")}）`);
    }

    let cost: Cost = { tokens: 0, amount: 0 };
    const account = (usage: TokenUsage): void => {
      record(model, usage);
      const next = usageToCost(model, usage);
      cost = addCost(cost, next);
      opts.onCost?.(next);
    };
    const oneRequest = async () => {
      underlyingRequests++;
      const request = createRequestAbortSignal(llmTimeoutMs(), opts.signal);
      try {
        if (request.signal.aborted) throw request.signal.reason ?? new Error("LLM request aborted before start");
        return await callVolcengineResponses({
          apiKey: requireLlmApiKey("volcengine-responses"),
          baseUrl: requireLlmBaseUrl("volcengine-responses"),
          model,
          system: opts.system,
          user: opts.user,
          jsonSchema,
          maxTokens,
          thinking: Boolean(opts.thinking),
          signal: request.signal,
        });
      } finally {
        request.dispose();
      }
    };
    const withRetry = () => retryTransientOperation(oneRequest, {
      retries: llmTransientRetries(),
      backoffMs: llmTransientRetryBackoffMs(),
      signal: opts.signal,
      onRetry: (error, retryNumber) => {
        const kind = error instanceof Error && error.name ? error.name : "UnknownError";
        console.warn(`  ⚠️ LLM 瞬态失败，应用层重试 ${retryNumber}/${llmTransientRetries()}（role=${opts.role}，${kind}）`);
      },
    });

    let response = await withRetry();
    if (response.stopReason) outputStopReasons.push(response.stopReason);
    account(response.usage);
    // Retain the existing bounded refusal retry policy where the provider represents a refusal as
    // a completed structured response. Other incomplete reasons remain evidence, not retries.
    for (let attempt = 1; response.stopReason === "refusal" && attempt < 3; attempt++) {
      response = await withRetry();
      if (response.stopReason) outputStopReasons.push(response.stopReason);
      account(response.usage);
    }
    if (response.stopReason === "max_output_tokens" || response.stopReason === "max_tokens") {
      console.warn(`  ⚠️ 输出达 maxTokens(${maxTokens}) 截断（role=${opts.role}）——建议提高预算或缩小批`);
    }

    const parsed = opts.schema.safeParse(response.input);
    if (!parsed.success) {
      const coerced = coerceStringifiedFields(response.input, parsed.error.issues);
      const retry = coerced != null ? opts.schema.safeParse(coerced) : null;
      if (retry?.success) {
        console.warn(`  ⚠️ 结构化输出字段被序列化成字符串、已定点 JSON.parse 修正（role=${opts.role}）`);
        succeeded = true;
        return { data: retry.data, usage: response.usage, cost };
      }
      throw new Error(
        `结构化输出 schema 校验失败（role=${opts.role}）：${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    succeeded = true;
    return { data: parsed.data, usage: response.usage, cost };
  } finally {
    recordRoleCallTelemetry(
      opts.role,
      performance.now() - startedAt,
      underlyingRequests,
      !succeeded,
      outputStopReasons,
      opts.telemetryOperation,
    );
  }
}

export async function callStructured<T extends z.ZodType>(
  opts: StructuredCall<T>,
): Promise<StructuredResult<z.infer<T>>> {
  if (llmProvider() === "volcengine-responses") return callVolcengineStructured(opts);
  const startedAt = performance.now();
  let underlyingRequests = 0;
  let succeeded = false;
  const outputStopReasons: string[] = [];
  try {
  const model = MODELS[opts.role];
  const maxTokens = opts.maxTokens ?? 16000;
  // 默认对稳定 system 前缀打 prompt cache；PROMPT_CACHE=0 时关闭——某些第三方中转站只写不读，
  // 缓存从不命中却仍计写入开销（见 a1-runs），此时关闭更省。
  const useCache = promptCacheOn();
  // 中转站兼容性（2026-06-03）：yibuapi 不再接受 SDK 0.98 的 output_config.format 字段。
  // 改走通用 tool_use：把目标 schema 包装成单个强制工具调用（tool_choice 锁定），从工具
  // 调用块取 input 当结构化输出。tool_use 是 Anthropic 长稳定接口，被所有中转站支持。
  const jsonSchema = z.toJSONSchema(opts.schema) as { type?: string };
  if (jsonSchema.type !== "object") {
    throw new Error(`callStructured schema 根类型必须是 object（当前 ${jsonSchema.type ?? "<未知>"}）`);
  }
  const tools = [
    {
      name: STRUCTURED_TOOL_NAME,
      description: "Return the structured result strictly matching the input_schema. Do not include any text outside the tool call.",
      input_schema: jsonSchema as Anthropic.Messages.Tool.InputSchema,
    },
  ];
  const params = {
    model,
    max_tokens: maxTokens,
    system: [
      { type: "text" as const, text: opts.system, ...(useCache ? { cache_control: { type: "ephemeral" as const } } : {}) },
    ],
    messages: [{ role: "user" as const, content: opts.user }],
    tools,
    tool_choice: { type: "tool" as const, name: STRUCTURED_TOOL_NAME },
    // 该 relay 的 exact endpoint/key/model 已经由 eval:canary-thinking 验证可以同时接受
    // thinking + forced tool_choice；仍由每个 role 的显式开关控制，不把 thinking 传给 analyzer。
    thinking: structuredThinkingConfig(Boolean(opts.thinking), maxTokens),
  };

  let cost: Cost = { tokens: 0, amount: 0 };
  const account = (u: Anthropic.Usage): void => {
    record(model, u);
    const c = usageToCost(model, u);
    cost = addCost(cost, c);
    opts.onCost?.(c);
  };

  // 流式生成（messages.stream + finalMessage）：长输出（dense 批 / 高 max_tokens）下避免中转站
  // 缓冲整段响应再返回导致的网关超时。流尾内容块中找 tool_use → 取 input 当结构化输出。
  // 敏感领域内容偶发安全拒答（stop_reason=refusal）——多为非确定性，重试至多 3 次。
  // 每次流式调用同时受调用方取消和 LLM_TIMEOUT_MS 的硬性墙钟超时约束；无论 SSE 是否持续有
  // 心跳/分片数据，超时后都必须终止，避免中转站永不 finalMessage() 时卡住整个 Job。
  const streamFinalMessage = async (): Promise<Anthropic.Message> => {
    underlyingRequests++;
    const request = createRequestAbortSignal(llmTimeoutMs(), opts.signal);
    let onAbort: (() => void) | undefined;
    try {
      if (request.signal.aborted) throw request.signal.reason ?? new Error("LLM request aborted before start");

      const stream = getClient().messages.stream(params, { signal: request.signal });
      // SDK 0.98 会把 signal 透传给 fetch，但个别 SSE 中转站在连接已建立后可能忽略取消，导致
      // finalMessage() 继续等待。这里同时显式 stream.abort()，并以 race 让本层立即返回；即使
      // SDK 后台迟迟不结算该 Promise，reject handler 也已附着，不会形成未处理拒绝。
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          stream.abort();
          reject(request.signal.reason ?? new Error("LLM request aborted"));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([stream.finalMessage(), aborted]);
    } finally {
      if (onAbort) request.signal.removeEventListener("abort", onAbort);
      request.dispose();
    }
  };

  const streamFinalMessageWithTransientRetry = (): Promise<Anthropic.Message> => retryTransientOperation(
    streamFinalMessage,
    {
      retries: llmTransientRetries(),
      backoffMs: llmTransientRetryBackoffMs(),
      signal: opts.signal,
      onRetry: (error, retryNumber) => {
        const kind = error instanceof Error && error.name ? error.name : "UnknownError";
        console.warn(`  ⚠️ LLM 瞬态失败，应用层重试 ${retryNumber}/${llmTransientRetries()}（role=${opts.role}，${kind}）`);
      },
    },
  );

  let res = await streamFinalMessageWithTransientRetry();
  if (res.stop_reason) outputStopReasons.push(res.stop_reason);
  account(res.usage);
  for (let attempt = 1; res.stop_reason === "refusal" && attempt < 3; attempt++) {
    res = await streamFinalMessageWithTransientRetry();
    if (res.stop_reason) outputStopReasons.push(res.stop_reason);
    account(res.usage);
  }

  if (res.stop_reason === "max_tokens") {
    console.warn(`  ⚠️ 输出达 max_tokens(${params.max_tokens}) 截断（role=${opts.role}）——可能漏洞察，建议提高预算或缩小批`);
  }

  // 找 tool_use 内容块；模型可能先输出文本块再调用工具，遍历全部块取第一个 tool_use。
  const toolUse = res.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === STRUCTURED_TOOL_NAME,
  );
  if (!toolUse) {
    throw new Error(
      `结构化输出解析失败（role=${opts.role} stop_reason=${res.stop_reason}）：模型未调用 ${STRUCTURED_TOOL_NAME} 工具`,
    );
  }
  // zod 校验：模型偶发产出不符 schema（如多余字段被 additionalProperties:false 拒）；
  // 走 safeParse 拿明确错误而非 ZodError 黑盒。
  const parsed = opts.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    // 防御：模型偶发把应为 array/object 的字段返成 JSON 字符串（6b 真机）——按报错路径定点 parse 后重试一次。
    const coerced = coerceStringifiedFields(toolUse.input, parsed.error.issues);
    const retry = coerced != null ? opts.schema.safeParse(coerced) : null;
    if (retry?.success) {
      console.warn(`  ⚠️ 结构化输出字段被序列化成字符串、已定点 JSON.parse 修正（role=${opts.role}）`);
      succeeded = true;
      return { data: retry.data, usage: res.usage, cost };
    }
    throw new Error(
      `结构化输出 schema 校验失败（role=${opts.role}）：${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  succeeded = true;
  return { data: parsed.data, usage: res.usage, cost };
  } finally {
    recordRoleCallTelemetry(
      opts.role,
      performance.now() - startedAt,
      underlyingRequests,
      !succeeded,
      outputStopReasons,
      opts.telemetryOperation,
    );
  }
}
