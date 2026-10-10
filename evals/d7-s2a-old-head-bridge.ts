/** Zero-budget by default; permanent loopback transport only. No live execution/quality receipt. */
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSignatures, digest, OLD_FILES, OLD_HEAD, OLD_TREE, oldPromptStrings, type Operation, type WireSignature } from "./d7-s2a-old-head-signatures.js";

export const FAKE_KEY = "s2a-isolated-fake-key";
export const RESPONSES_LOGICAL_URL = "https://ark.cn-beijing.volces.com/api/coding/v3/responses";
export const REQUEST_LIMIT = 1_048_576, RESPONSE_LIMIT = 4_194_304, TASK_FILE_LIMIT = 536_870_912;
const neverFetch: typeof fetch = async () => { throw new Error("s2a_bridge_missing_or_stopped"); };
let installed = false;
let bridgeAlive = false;
export interface BridgeAttempt {
  admission: number; segment: string; operation: Operation; role: string; model: string; provider: "anthropic" | "volcengine-responses";
  body_sha256: string; request_bytes: number; retry: boolean; transport: "admitted" | "not_sent" | "send_started" | "response_received" | "unknown";
  response_bytes: number; complete: boolean;
}
export interface BridgeSnapshot {
  schema: "s2a-isolated-bridge-v1"; old_head: typeof OLD_HEAD; old_tree: typeof OLD_TREE; attribution: "wire-signature";
  quality_pass: false; live_permitted: false; failure: string | null; failure_persisted: boolean; disposed: boolean;
  deadline: number; max_admissions: number; max_retries: number; file_bytes: number; attempts: BridgeAttempt[];
}
export interface OldHeadBridge {
  snapshot(): BridgeSnapshot;
  segment(value: string): void;
  check(): void;
  finish(): void;
  dispose(): void;
  load(module: "llm" | "analyzer" | "validator"): Promise<Record<string, unknown>>;
}
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function git(candidate: string, args: string[]): string { return execFileSync("git", ["-C", candidate, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
function plain(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "s2a_unknown_envelope");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  requireValue(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), "s2a_unknown_envelope");
}
function loopback(raw: string): string {
  requireValue(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(raw), "s2a_invalid_loopback");
  const url = new URL(raw); requireValue(Number(url.port) <= 65535 && url.origin === raw, "s2a_invalid_loopback"); return raw;
}
function dependencyIdentity(candidate: string): Record<string, unknown> {
  const lock = JSON.parse(readFileSync(join(candidate, "package-lock.json"), "utf8"));
  const actual = JSON.parse(readFileSync(join(candidate, "node_modules/.package-lock.json"), "utf8"));
  for (const [name, entry] of Object.entries(actual.packages as Record<string, { version?: string; integrity?: string; resolved?: string }>)) {
    const expected = lock.packages[name];
    requireValue(expected && entry.version === expected.version && entry.integrity === expected.integrity && entry.resolved === expected.resolved, "s2a_old_dependency_mismatch");
  }
  const packages: Record<string, unknown> = {};
  for (const name of ["@anthropic-ai/sdk", "zod", "tsx"]) {
    const packagePath = join(candidate, "node_modules", name, "package.json"), resolved = realpathSync(packagePath);
    requireValue(resolved.startsWith(`${candidate}/node_modules/`), "s2a_old_dependency_outside_candidate");
    const version = JSON.parse(readFileSync(resolved, "utf8")).version;
    requireValue(version === lock.packages[`node_modules/${name}`].version, "s2a_old_dependency_mismatch");
    packages[name] = { path: resolved, version };
  }
  return { lock_sha256: digest(readFileSync(join(candidate, "package-lock.json"))), installed_lock_sha256: digest(readFileSync(join(candidate, "node_modules/.package-lock.json"))), packages };
}

export async function installOldHeadBridge(options: {
  candidate: string; root: string; loopbackOrigin: string; signal?: AbortSignal;
  /** Synthetic loopback only; omitted limits always authorize zero admissions. */
  syntheticLimits?: { admissions: number; retries: number; windowMs: number };
}): Promise<OldHeadBridge> {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = neverFetch; // Even failed identity/import/installation stays closed.
  requireValue(!installed, "s2a_bridge_already_installed"); installed = true;
  const origin = loopback(options.loopbackOrigin);
  const limits = options.syntheticLimits ?? { admissions: 0, retries: 0, windowMs: 2_700_000 };
  requireValue(Number.isSafeInteger(limits.admissions) && limits.admissions >= 0 && limits.admissions <= 100 && Number.isSafeInteger(limits.retries)
    && limits.retries >= 0 && limits.retries <= 20 && Number.isSafeInteger(limits.windowMs) && limits.windowMs > 0 && limits.windowMs <= 2_700_000, "s2a_invalid_limits");
  requireValue(options.signal === undefined || options.signal instanceof AbortSignal, "s2a_invalid_signal");
  requireValue(isAbsolute(options.root) && realpathSync(dirname(options.root)) === dirname(options.root), "s2a_invalid_root");
  mkdirSync(options.root, { mode: 0o700 });
  requireValue((lstatSync(options.root).mode & 0o777) === 0o700 && lstatSync(options.root).uid === process.getuid?.(), "s2a_invalid_root");
  const controller = new AbortController(), startedMono = performance.now();
  const state: BridgeSnapshot = { schema: "s2a-isolated-bridge-v1", old_head: OLD_HEAD, old_tree: OLD_TREE, attribution: "wire-signature", quality_pass: false,
    live_permitted: false, failure: null, failure_persisted: false, disposed: false, deadline: Date.now() + limits.windowMs,
    max_admissions: limits.admissions, max_retries: limits.retries, file_bytes: 0, attempts: [] };
  let sequence = 0, pending = 0, segment = "setup", finished = false;
  function writeNew(name: string, value: string): void {
    const bytes = Buffer.byteLength(value);
    requireValue(state.file_bytes + bytes <= TASK_FILE_LIMIT, "s2a_task_space_limit");
    const path = join(options.root, name); let fd: number | undefined;
    try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, value); fsyncSync(fd); requireValue(fstatSync(fd).size === bytes, "s2a_partial_write"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { const actual = statSync(path).size; state.file_bytes += actual; } catch { /* A failed create has no known bytes. */ }
    }
  }
  function persist(): void { writeNew(`state-${++sequence}.json`, `${JSON.stringify(state)}\n`); }
  function fail(reason: string): Error {
    state.failure ??= reason;
    const error = new Error(state.failure); controller.abort(error);
    if (!state.failure_persisted) {
      try { writeNew("STOP", state.failure); state.failure_persisted = true; } catch { /* In-memory sticky failure still forbids sends/finish. Durable status is unknown. */ }
    }
    return error;
  }
  function check(): void {
    if (state.failure) throw new Error(state.failure);
    if (state.disposed || finished) throw fail("s2a_bridge_stopped");
    if (options.signal?.aborted) throw fail("s2a_cancelled");
    if (Date.now() >= state.deadline || performance.now() - startedMono >= limits.windowMs) throw fail("s2a_deadline");
  }
  function safePersist(): void { try { persist(); } catch (error) { throw fail(error instanceof Error && error.message.startsWith("s2a_") ? error.message : "s2a_storage_failed"); } }
  let candidate: string, signatures: readonly WireSignature[], models: Record<string, string>;
  try {
    candidate = realpathSync(options.candidate);
    requireValue(candidate === options.candidate && git(candidate, ["rev-parse", "HEAD"]) === OLD_HEAD && git(candidate, ["rev-parse", "HEAD^{tree}"]) === OLD_TREE
      && git(candidate, ["status", "--porcelain", "--untracked-files=no"]) === "", "s2a_old_identity_mismatch");
    for (const [path, hash] of Object.entries(OLD_FILES)) requireValue(digest(readFileSync(join(candidate, path))) === hash, "s2a_old_source_mismatch");
    requireValue(process.versions.node.split(".")[0] === "24", "s2a_node_version_mismatch");
    requireValue(process.env.LLM_API_KEY === FAKE_KEY && process.env.ANTHROPIC_API_KEY === FAKE_KEY, "s2a_fake_credentials_required");
    const identity = dependencyIdentity(candidate);
    writeNew("identity.json", `${JSON.stringify({ head: OLD_HEAD, tree: OLD_TREE, files: OLD_FILES, dependencies: identity, logical_responses: RESPONSES_LOGICAL_URL,
      native_origin: origin, live_permitted: false })}\n`);
    const schemaModule = await import(pathToFileURL(join(candidate, "src/lib/types.ts")).href) as Record<string, unknown>;
    const { z } = await import(pathToFileURL(join(candidate, "node_modules/zod/v4/index.js")).href) as typeof import("zod/v4");
    const schemas = { ...schemaModule, ReaderLanguageRepairSchema: z.object({ statement: z.string().min(1).max(2000) }).strict() };
    signatures = buildSignatures(oldPromptStrings(candidate), schemas, value => z.toJSONSchema(value as Parameters<typeof z.toJSONSchema>[0]));
    models = { analyzer: process.env.ANALYZER_MODEL ?? "claude-sonnet-4-6", validator: process.env.VALIDATOR_MODEL ?? "claude-opus-4-7", coverage: process.env.COVERAGE_MODEL ?? "" };
    requireValue(models.coverage && new Set(Object.values(models)).size === 3, "s2a_model_identity_invalid");
    check(); safePersist();
  } catch (error) { fail(error instanceof Error && error.message.startsWith("s2a_") ? error.message : "s2a_setup_failed"); throw new Error(state.failure!); }
  const timer = setInterval(() => { try { check(); } catch { /* First cause is already sticky. */ } }, 10); timer.unref();
  const onAbort = (): void => { fail("s2a_cancelled"); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  function classify(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): { provider: BridgeAttempt["provider"]; match: WireSignature; body: string; model: string; destination: string } {
    requireValue(typeof input === "string" && init?.method === "POST" && typeof init.body === "string", "s2a_unknown_request");
    requireValue(Buffer.byteLength(init.body) <= REQUEST_LIMIT, "s2a_request_size_limit");
    const provider = input === RESPONSES_LOGICAL_URL ? "volcengine-responses" : "anthropic";
    requireValue(input === RESPONSES_LOGICAL_URL || input === `${origin}/v1/messages`, "s2a_unknown_destination");
    const headers = new Headers(init.headers);
    requireValue(provider === "anthropic" ? headers.get("x-api-key") === FAKE_KEY : headers.get("authorization") === `Bearer ${FAKE_KEY}`, "s2a_fake_credentials_required");
    const body = plain(JSON.parse(init.body));
    let system: unknown, schema: unknown;
    if (provider === "anthropic") {
      exactKeys(body, ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "stream"], ["thinking"]);
      requireValue(Array.isArray(body.system) && body.system.length === 1 && Array.isArray(body.messages) && body.messages.length === 1, "s2a_unknown_envelope");
      const prefix = plain(body.system[0]), message = plain(body.messages[0]); exactKeys(prefix, ["type", "text"], ["cache_control"]); exactKeys(message, ["role", "content"]);
      requireValue(prefix.type === "text" && message.role === "user" && typeof message.content === "string", "s2a_unknown_envelope");
      if (prefix.cache_control !== undefined) { const cache = plain(prefix.cache_control); exactKeys(cache, ["type"]); requireValue(cache.type === "ephemeral", "s2a_unknown_envelope"); }
      system = prefix.text;
      requireValue(Array.isArray(body.tools) && body.tools.length === 1, "s2a_unknown_envelope");
      const tool = plain(body.tools[0]); exactKeys(tool, ["name", "description", "input_schema"]);
      requireValue(tool.name === "respond_with_structured_output" && tool.description === "Return the structured result strictly matching the input_schema. Do not include any text outside the tool call.", "s2a_unknown_envelope"); schema = tool.input_schema;
      const choice = plain(body.tool_choice); exactKeys(choice, ["type", "name"]); requireValue(choice.type === "tool" && choice.name === tool.name, "s2a_unknown_envelope");
      requireValue(Number.isSafeInteger(body.max_tokens) && Number(body.max_tokens) > 0 && Number(body.max_tokens) <= 16000, "s2a_unknown_envelope");
      if (body.thinking !== undefined) { const thinking = plain(body.thinking); exactKeys(thinking, ["type", "budget_tokens"]); requireValue(thinking.type === "enabled" && thinking.budget_tokens === 1024, "s2a_unknown_envelope"); }
    } else {
      exactKeys(body, ["model", "instructions", "input", "max_output_tokens", "stream", "thinking", "tools", "tool_choice"]);
      system = body.instructions; requireValue(typeof body.input === "string" && Number.isSafeInteger(body.max_output_tokens) && Number(body.max_output_tokens) > 0 && Number(body.max_output_tokens) <= 16000, "s2a_unknown_envelope");
      const thinking = plain(body.thinking); exactKeys(thinking, ["type"]); requireValue(["enabled", "disabled"].includes(String(thinking.type)), "s2a_unknown_envelope");
      requireValue(Array.isArray(body.tools) && body.tools.length === 1, "s2a_unknown_envelope");
      const tool = plain(body.tools[0]); exactKeys(tool, ["type", "name", "description", "parameters", "strict"]);
      requireValue(tool.type === "function" && tool.name === "respond_with_structured_output" && tool.strict === true
        && tool.description === "Return the structured result strictly matching the parameters schema. Do not include text outside the function call.", "s2a_unknown_envelope"); schema = tool.parameters;
      const choice = plain(body.tool_choice); exactKeys(choice, ["type", "name"]); requireValue(choice.type === "function" && choice.name === tool.name, "s2a_unknown_envelope");
    }
    requireValue(body.stream === true && typeof system === "string" && typeof body.model === "string", "s2a_unknown_envelope");
    const matches = signatures.filter(entry => entry.system === digest(system as string) && entry.schema === digest(JSON.stringify(schema)) && models[entry.role] === body.model);
    requireValue(matches.length === 1, "s2a_unknown_or_ambiguous_operation");
    return { provider, match: matches[0], body: init.body, model: body.model as string, destination: `${origin}/${provider === "anthropic" ? "v1/messages" : "responses"}` };
  }
  function snapshotInit(raw: RequestInit | undefined): RequestInit {
    requireValue(raw && Object.getPrototypeOf(raw) === Object.prototype && Object.getOwnPropertySymbols(raw).length === 0, "s2a_unknown_request");
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    requireValue(Object.keys(descriptors).every(key => ["body", "method", "headers", "signal", "redirect"].includes(key)
      && descriptors[key].enumerable && Object.hasOwn(descriptors[key], "value")), "s2a_unknown_request");
    const body = descriptors.body?.value, method = descriptors.method?.value, signal = descriptors.signal?.value;
    requireValue(typeof body === "string" && method === "POST" && (signal == null || signal instanceof AbortSignal), "s2a_unknown_request");
    const rawHeaders = descriptors.headers?.value;
    let headers: Headers;
    if (rawHeaders instanceof Headers && Object.getPrototypeOf(rawHeaders) === Headers.prototype) {
      headers = new Headers([...Headers.prototype.entries.call(rawHeaders)]);
    } else {
      requireValue(rawHeaders && Object.getPrototypeOf(rawHeaders) === Object.prototype && Object.getOwnPropertySymbols(rawHeaders).length === 0, "s2a_unknown_headers");
      const fields = Object.getOwnPropertyDescriptors(rawHeaders);
      requireValue(Object.values(fields).every(field => field.enumerable && Object.hasOwn(field, "value") && typeof field.value === "string"), "s2a_unknown_headers");
      headers = new Headers(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])));
    }
    return Object.freeze({ method, body, headers, ...(signal ? { signal } : {}) });
  }
  globalThis.fetch = async (input, init) => {
    let attempt: BridgeAttempt | undefined, fd: number | undefined, enteredNative = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let released = false;
    const release = (): void => { if (!released) { released = true; if (fd !== undefined) { closeSync(fd); fd = undefined; } pending--; } };
    try {
      check(); const snapshot = snapshotInit(init); const request = classify(input, snapshot);
      const previous = state.attempts.filter(value => value.segment === segment);
      const retryHeader = new Headers(snapshot.headers).get("x-stainless-retry-count");
      requireValue(retryHeader === null || /^[0-9]+$/.test(retryHeader), "s2a_unknown_retry_header");
      const retry = Number(retryHeader ?? 0) > 0 || previous.some(value => value.model === request.model && value.body_sha256 === digest(request.body))
        || (request.match.operation === "analysis_generation" && previous.some(value => value.operation === "analysis_generation")) || /repair|backfill/.test(request.match.operation);
      requireValue(state.attempts.length < limits.admissions, "s2a_admission_limit");
      requireValue(!retry || state.attempts.filter(value => value.retry).length < limits.retries, "s2a_retry_limit");
      attempt = { admission: state.attempts.length + 1, segment, operation: request.match.operation, role: request.match.role, model: request.model, provider: request.provider,
        body_sha256: digest(request.body), request_bytes: Buffer.byteLength(request.body), retry, transport: "admitted", response_bytes: 0, complete: false };
      state.attempts.push(attempt); pending++;
      writeNew(`request-${attempt.admission}.json`, request.body);
      fd = openSync(join(options.root, `response-${attempt.admission}.bin`), "wx", 0o600);
      safePersist(); check();
      attempt.transport = "send_started"; safePersist(); check();
      enteredNative = true;
      const signal = snapshot.signal ? AbortSignal.any([snapshot.signal, controller.signal]) : controller.signal;
      const response = await nativeFetch(request.destination, { ...snapshot, redirect: "error", signal });
      check(); attempt.transport = "response_received";
      if (!response.body) { attempt.complete = true; release(); safePersist(); return response; }
      reader = response.body.getReader();
      const targetAttempt = attempt;
      const ingest = (bytes: Uint8Array): void => {
        requireValue(bytes.byteLength + targetAttempt.response_bytes <= RESPONSE_LIMIT, "s2a_response_size_limit");
        requireValue(state.file_bytes + bytes.byteLength <= TASK_FILE_LIMIT, "s2a_task_space_limit");
        const before = fstatSync(fd!).size;
        let written: number | undefined;
        try { written = writeSync(fd!, bytes); fsyncSync(fd!); }
        finally { const observed = fstatSync(fd!).size - before; targetAttempt.response_bytes += observed; state.file_bytes += observed; }
        requireValue(written === bytes.byteLength && fstatSync(fd!).size - before === bytes.byteLength, "s2a_partial_write");
        safePersist(); check();
      };
      // The actual SDK intentionally cancels an HTTP retry response without reading it.
      // Fully capture bounded error bytes first; cancelling the fresh returned buffer is harmless.
      if (!response.ok) {
        const chunks: Uint8Array[] = [];
        while (true) { check(); const next = await reader.read(); check(); if (next.done) break; ingest(next.value); chunks.push(next.value); }
        targetAttempt.complete = true; release(); safePersist();
        return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      const stream = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            check(); const next = await reader!.read(); check();
            if (next.done) { targetAttempt.complete = true; release(); safePersist(); target.close(); return; }
            ingest(next.value); target.enqueue(next.value);
          } catch (error) {
            targetAttempt.transport = "unknown";
            const failure = fail(error instanceof Error && error.message.startsWith("s2a_") ? error.message : "s2a_storage_or_transport_failed");
            release(); void reader!.cancel(failure).catch(() => undefined); target.error(failure);
          }
        },
        async cancel() { targetAttempt.transport = "unknown"; const error = fail("s2a_body_cancelled"); release(); await reader!.cancel(error).catch(() => undefined); },
      }, { highWaterMark: 0 });
      const wrapped = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
      return wrapped;
    } catch (error) {
      if (attempt) { attempt.transport = enteredNative ? "unknown" : "not_sent"; release(); }
      throw fail(error instanceof Error && error.message.startsWith("s2a_") ? error.message : "s2a_transport_failed");
    }
  };
  bridgeAlive = true;
  return {
    snapshot: () => structuredClone(state),
    segment(value) { check(); if (pending !== 0 || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw fail("s2a_segment_inflight_or_invalid"); segment = value; },
    check,
    finish() { check(); if (pending !== 0 || !state.attempts.every(value => value.complete)) throw fail("s2a_attempts_incomplete"); safePersist(); finished = true; clearInterval(timer); options.signal?.removeEventListener("abort", onAbort); },
    dispose() { state.disposed = true; bridgeAlive = false; globalThis.fetch = neverFetch; clearInterval(timer); options.signal?.removeEventListener("abort", onAbort); controller.abort(new Error("s2a_bridge_stopped")); },
    async load(module) {
      check(); requireValue(bridgeAlive && ["llm", "analyzer", "validator"].includes(module), "s2a_bridge_missing_or_stopped");
      const path = module === "llm" ? "src/lib/runtime/llm.ts" : `src/lib/agents/${module}.ts`;
      return import(pathToFileURL(resolve(candidate, path)).href) as Promise<Record<string, unknown>>;
    },
  };
}
