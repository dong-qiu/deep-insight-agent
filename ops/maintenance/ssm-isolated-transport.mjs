/** Fixed AWS CLI -> loopback wire transport. It never grants remote execution authority. */
import { spawn } from "node:child_process";
import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isProxy } from "node:util/types";
import { isAbsolute, join } from "node:path";
import { bindingFor, check, hash, markerSchema, parse, same, tokenFor, tokenSchema } from "./contract.mjs";
import { openLedger } from "./ledger.mjs";
import { runControllerStep } from "./controller.mjs";
import { FIXTURE_WIRE } from "./ssm-response.mjs";

const INPUT_LIMIT = 65536, STDERR_LIMIT = 4096, CLEANUP_GRACE = 1000;
const binary = process.platform === "darwin" ? "/opt/homebrew/bin/aws" : process.platform === "linux" ? "/usr/local/bin/aws" : null;
const codes = new Set(["maintenance_owner_lost", "maintenance_revision_conflict", "maintenance_file_replaced", "maintenance_marker_changed",
  "unsafe_maintenance_path", "noncanonical_maintenance_root", "maintenance_response_mismatch", "maintenance_terminal_conflict",
  "invalid_maintenance_transition", "maintenance_submission_already_started", "invalid_controller_input", "transport_sidecar_present",
  "transport_input_invalid", "transport_binary_unavailable", "transport_output_limit", "transport_child_failed", "transport_response_invalid"]);
const safeCode = error => error instanceof Error && codes.has(error.message) ? error.message : "transport_ledger_failed";
const controllerInput = (token, event) => ({ schema: "a3-ssm-controller-v1", token, ...(event ? { event } : {}) });

function profile(root) {
  return { region: "isolated", instanceId: "fixture-controller-node", volumeId: "fixture-controller-volume", dataPath: root, serviceSet: ["fixture-controller"] };
}
function physical(root, prior) {
  check(typeof root === "string" && isAbsolute(root) && root === realpathSync(root), "noncanonical_maintenance_root");
  const directory = lstatSync(root);
  check(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid()
    && (directory.mode & 0o777) === 0o700, "unsafe_maintenance_path");
  // Reject even a valid hot journal before old openLedger can recover it. This is a prior
  // filesystem observation, not an atomic gate around all nested old SQLite statements.
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { lstatSync(join(root, `ledger.sqlite${suffix}`)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error("transport_sidecar_present");
  }
  const ids = {};
  for (const name of ["isolation.json", "ledger.sqlite"]) {
    const info = lstatSync(join(root, name));
    check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1
      && (info.mode & 0o777) === 0o600 && info.size <= (name === "isolation.json" ? 16384 : 16 * 1024 * 1024), "unsafe_maintenance_path");
    ids[name] = { dev: info.dev, ino: info.ino };
  }
  const fd = openSync(join(root, "isolation.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const info = fstatSync(fd);
    check(info.size <= 16384 && info.dev === ids["isolation.json"].dev && info.ino === ids["isolation.json"].ino, "maintenance_marker_changed");
    bytes = readFileSync(fd);
    check(bytes.length <= 16384 && Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes), "maintenance_marker_changed");
  } finally { closeSync(fd); }
  const marker = parse(markerSchema, JSON.parse(bytes.toString("utf8")));
  check(same(marker.target, profile(root)), "transport_input_invalid");
  const identity = { ...ids, markerHash: hash(bytes), root: { dev: directory.dev, ino: directory.ino } };
  check(!prior || same(prior, identity), "maintenance_file_replaced");
  return identity;
}
function input(root, action, inputJson, endpoint, signal) {
  check(["send", "invocation", "cancel"].includes(action) && typeof inputJson === "string"
    && Buffer.byteLength(inputJson) <= INPUT_LIMIT && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(endpoint), "transport_input_invalid");
  const port = Number(endpoint.slice("http://127.0.0.1:".length, -1));
  check(Number.isInteger(port) && port <= 65535 && (signal === undefined || signal instanceof AbortSignal), "transport_input_invalid");
  let raw; try { raw = JSON.parse(inputJson); } catch { throw new Error("transport_input_invalid"); }
  function exactOwn(value, keys) {
    check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
      && keys.every(key => Object.hasOwn(value, key)), "transport_input_invalid");
  }
  exactOwn(raw, ["schema", "token"]);
  check(raw.schema === "a3-isolated-ssm-transport-v1", "transport_input_invalid");
  // JSON.parse creates ordinary own data fields, but a polluted Object.prototype must
  // never fill a missing strict token/target field before the original Zod parser.
  exactOwn(raw.token, ["operationId", "ownerId", "fence", "revision", "target", "executionIdentity"]);
  exactOwn(raw.token.target, ["region", "instanceId", "volumeId", "dataPath", "serviceSet"]);
  let token; try { token = parse(tokenSchema, raw.token); } catch { throw new Error("transport_input_invalid"); }
  check(same(token.target, profile(root)) && token.executionIdentity === "fixture-controller-v1", "transport_input_invalid");
  Object.freeze(token.target.serviceSet); Object.freeze(token.target); Object.freeze(token);
  return token;
}
function control(deadlineAt, signal) {
  check(Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now() && deadlineAt - Date.now() <= 60000
    && (signal === undefined || signal instanceof AbortSignal), "transport_input_invalid");
  const started = performance.now(), initial = deadlineAt - Date.now();
  let cause = null;
  function remaining() { return Math.min(deadlineAt - Date.now(), initial - (performance.now() - started)); }
  function checkpoint() {
    if (!cause && signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason.message : "cancelled";
      cause = ["cancelled", "task_deadline_exceeded", "generation_fence_lost"].includes(reason) ? reason : "cancelled";
    }
    if (!cause && remaining() <= 0) cause = "task_deadline_exceeded";
    return cause;
  }
  return { signal, remaining, checkpoint, cause: () => cause };
}
function childEnv() {
  return { AWS_ACCESS_KEY_ID: "AKIAISOLATEDFIXTURE01", AWS_SECRET_ACCESS_KEY: "fixture-only-not-a-secret",
    AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1", AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off",
    AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null", LC_ALL: "C", PATH: "/usr/bin:/bin" };
}
async function invoke(cwd, args, window) {
  if (window.checkpoint()) return { started: false, reason: window.cause(), bytes: null, closed: true };
  return new Promise(resolve => {
    const proc = spawn(binary, args, { cwd, env: childEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let started = false, done = false, reason = null, stdoutSize = 0, stderrSize = 0, chunks = [];
    let timer, killTimer, cleanupTimer;
    function finish(closed, code) {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(cleanupTimer);
      window.signal?.removeEventListener("abort", aborted);
      proc.stdout.removeAllListeners(); proc.stderr.removeAllListeners();
      proc.stdout.destroy(); proc.stderr.destroy();
      // A reaper error listener prevents a late native error from becoming an uncaught exception.
      proc.removeAllListeners(); proc.on("error", () => {});
      resolve({ started, closed, reason: reason ?? (code === 0 ? null : "transport_child_failed"), bytes: reason || code !== 0 ? null : Buffer.concat(chunks) });
      chunks = [];
    }
    function stop(failure) {
      if (done || reason) return;
      reason = window.checkpoint() ?? failure;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* Local termination is still unknown. */ } }, CLEANUP_GRACE - 50);
      cleanupTimer = setTimeout(() => finish(false, null), CLEANUP_GRACE);
    }
    function aborted() { stop(window.checkpoint() ?? "cancelled"); }
    proc.on("spawn", () => { started = true; });
    proc.on("error", () => { reason ??= "transport_binary_unavailable"; finish(true, null); });
    proc.on("close", code => finish(true, code));
    proc.stdout.on("data", chunk => {
      stdoutSize += chunk.length;
      if (stdoutSize > INPUT_LIMIT) { stop("transport_output_limit"); return; }
      if (!reason) chunks.push(chunk);
    });
    proc.stderr.on("data", chunk => { stderrSize += chunk.length; if (stderrSize > STDERR_LIMIT) stop("transport_output_limit"); });
    window.signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => stop(window.checkpoint() ?? "task_deadline_exceeded"), Math.max(1, window.remaining()));
    // Catch an abort or expiry between the initial check and listener registration.
    if (window.checkpoint()) aborted();
  });
}
function inspect(root, identity, token) {
  physical(root, identity);
  const ledger = openLedger(root);
  try {
    const state = ledger.inspect(), op = state.operations[token.operationId];
    check(op && state.active === token.operationId && op.disposition !== "released"
      && same({ ...tokenFor(op), revision: 0 }, { ...token, revision: 0 }), "maintenance_owner_lost");
    check(op.revision === token.revision, "maintenance_revision_conflict");
    return op;
  } finally { try { ledger.close(); } catch { /* Do not overwrite a known inspection error. */ } }
}
function step(root, identity, action, token, event) {
  physical(root, identity);
  return runControllerStep(root, action, controllerInput(token, event));
}
function hold(root, identity, token, reason, result) {
  result.hold = "unknown";
  let ledger;
  try {
    physical(root, identity); ledger = openLedger(root); ledger.hold(token, reason); result.hold = "committed";
  } catch (error) { result.reason = safeCode(error); }
  finally { try { ledger?.close(); } catch { /* Preserve the known hold fact. */ } }
}
function apply(result, response) {
  result.commandId = response.commandId; result.observedStatus = response.observedStatus;
  result.hold = response.hold === "recorded" ? "committed" : response.hold === "unconfirmed" ? "unknown" : "not_attempted";
  result.response = response.outcome === "blocked" ? "invalid" : "accepted_or_replay";
  result.reason = response.reason;
  // The original allowStale bind/observe token is deliberately never consumed or exported.
}
async function run(options, window) {
  const { root, action, inputJson, endpoint, signal } = options;
  const ingress = input(root, action, inputJson, endpoint, signal), identity = physical(root);
  const result = { schema: "a3-isolated-ssm-transport-result-v1", scope: "loopback-aws-cli", production_permitted: false,
    maintenance_permitted: false, ready: false, termination: "unknown", safe_rollback: null, token: null,
    stage: "not_attempted", child: "not_started", response: "unavailable", hold: "not_attempted", commandId: null,
    observedStatus: null, reason: null, first_control_reason: null };
  if (window.checkpoint()) { result.reason = result.first_control_reason = window.cause(); return result; }
  // Never use the ledger root as the CLI working directory. This new private directory
  // is a real filesystem effect, separate from zero ledger/business/API preflight effects.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "insight-transport-cli-"))); chmodSync(cwd, 0o700);
  const directoryIdentity = lstatSync(cwd);
  try {
    let executable;
    try { executable = binary && lstatSync(binary); } catch { throw new Error("transport_binary_unavailable"); }
    check(executable && (executable.isSymbolicLink() || executable.isFile()), "transport_binary_unavailable");
    const version = await invoke(cwd, ["--version"], window);
    if (window.checkpoint()) { result.reason = result.first_control_reason = window.cause(); return result; }
    check(version.closed && !version.reason && /^aws-cli\/2\.[0-9]+\.[0-9]+\s/.test(version.bytes.toString("utf8")), "transport_binary_unavailable");
    let token = ingress, op;
    if (action !== "invocation") {
      const staged = step(root, identity, action === "send" ? "stage-submit" : "stage-cancel", token);
      if (staged.outcome === "blocked") { result.stage = "unknown"; apply(result, staged); return result; }
      check(staged.token !== null, "transport_ledger_failed"); token = staged.token; result.stage = "committed";
    }
    try {
      op = inspect(root, identity, token);
      check(action === "send" ? op.state === "submission_unknown" && op.disposition === "active"
        : op.commandId !== null && ["submitted", "running", "cancel_requested", "terminal_pending", "terminal_verified"].includes(op.state), "invalid_maintenance_transition");
      if (window.checkpoint()) {
        result.reason = result.first_control_reason = window.cause(); hold(root, identity, token, window.cause(), result); return result;
      }
      const binding = bindingFor(op);
      const request = action === "send" ? { InstanceIds: [FIXTURE_WIRE.InstanceId], DocumentName: FIXTURE_WIRE.DocumentName,
        DocumentVersion: FIXTURE_WIRE.DocumentVersion, TimeoutSeconds: 30, Comment: `a3:${binding.submitToken}:${binding.requestHash.slice(0, 56)}` }
        : action === "invocation" ? { CommandId: binding.commandId, InstanceId: FIXTURE_WIRE.InstanceId, PluginName: FIXTURE_WIRE.PluginName }
          : { CommandId: binding.commandId, InstanceIds: [FIXTURE_WIRE.InstanceId] };
      const timeout = String(Math.max(1, Math.ceil(window.remaining() / 1000)));
      const args = ["--endpoint-url", endpoint, "--region", "us-east-1", "--no-cli-pager", "--no-paginate", "--output", "json", "--color", "off",
        "--cli-connect-timeout", timeout, "--cli-read-timeout", timeout, "ssm",
        action === "send" ? "send-command" : action === "invocation" ? "get-command-invocation" : "cancel-command", "--cli-input-json", JSON.stringify(request)];
      // This last synchronous check is not a remote fence. A false signed stop declaration can
      // race after it; a sent request then remains unknown and cannot mutate a foreign operation.
      inspect(root, identity, token);
      const wire = await invoke(cwd, args, window);
      result.child = wire.closed ? wire.started ? "started" : "not_started" : "unknown";
      result.first_control_reason = window.checkpoint();
      if (wire.reason || result.first_control_reason) {
        result.reason = result.first_control_reason ?? wire.reason;
        hold(root, identity, token, result.reason, result); return result;
      }
      let body;
      try { body = wire.bytes.length ? JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(wire.bytes)) : action === "cancel" ? null : undefined; }
      catch { result.reason = "transport_response_invalid"; hold(root, identity, token, result.reason, result); result.response = "invalid"; return result; }
      const response = step(root, identity, action === "send" ? "receive-send" : action === "invocation" ? "receive-invocation" : "receive-cancel",
        token, { outcome: "response", body });
      apply(result, response); return result;
    } catch (error) { result.reason = safeCode(error); return result; }
  } finally {
    // Only this invocation's newly-created directory is eligible for cleanup. A local
    // cleanup diagnostic cannot overwrite durable stage/hold/response facts.
    try {
      const now = lstatSync(cwd);
      if (now.isDirectory() && !now.isSymbolicLink() && now.dev === directoryIdentity.dev && now.ino === directoryIdentity.ino
        && now.uid === process.getuid() && (now.mode & 0o777) === 0o700 && readdirSync(cwd).length === 0) rmdirSync(cwd);
    } catch { /* Unknown CLI artifacts or cleanup failure are retained, never recursively removed. */ }
  }
}

export async function runIsolatedSsmTransport(options) {
  try {
    check(options && !isProxy(options) && Object.getPrototypeOf(options) === Object.prototype, "transport_input_invalid");
    const required = ["root", "action", "inputJson", "endpoint", "deadlineAt"], descriptors = Object.getOwnPropertyDescriptors(options);
    check(required.every(key => Object.hasOwn(descriptors, key))
      && Reflect.ownKeys(descriptors).every(key => [...required, "signal"].includes(key)
        && descriptors[key].enumerable && Object.hasOwn(descriptors[key], "value"))
      && (Object.hasOwn(descriptors, "signal") || !("signal" in options)), "transport_input_invalid");
    const snapshot = Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])));
    check(["root", "action", "inputJson", "endpoint"].every(key => typeof snapshot[key] === "string")
      && typeof snapshot.deadlineAt === "number" && (!Object.hasOwn(snapshot, "signal")
        || snapshot.signal === undefined || !isProxy(snapshot.signal) && snapshot.signal instanceof AbortSignal), "transport_input_invalid");
    return await run(snapshot, control(snapshot.deadlineAt, Object.hasOwn(snapshot, "signal") ? snapshot.signal : undefined));
  } catch (error) { throw new Error(safeCode(error)); }
}

/** Fixed process adapter, preserving the original stdin absolute and monotonic window. */
export async function runIsolatedSsmTransportCli() {
  let window, controller;
  try {
    const [root, action, endpoint, deadline, ...extra] = process.argv.slice(2);
    check(extra.length === 0 && /^(0|[1-9][0-9]*)$/.test(deadline), "transport_input_invalid");
    controller = new AbortController(); window = control(Number(deadline), controller.signal);
    const interrupt = () => controller.abort(new Error("cancelled"));
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    try {
      const chunks = []; let size = 0;
      const bytes = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { controller.abort(new Error("task_deadline_exceeded")); }, Math.max(1, window.remaining()));
        const failure = () => { cleanup(); process.stdin.destroy(); reject(new Error(window.checkpoint() ?? "cancelled")); };
        function cleanup() { clearTimeout(timer); controller.signal.removeEventListener("abort", failure); process.stdin.removeAllListeners(); }
        controller.signal.addEventListener("abort", failure, { once: true });
        process.stdin.on("data", chunk => {
          size += chunk.length;
          if (size > INPUT_LIMIT) { cleanup(); process.stdin.destroy(); reject(new Error("transport_input_invalid")); }
          else chunks.push(chunk);
        });
        process.stdin.on("end", () => { cleanup(); resolve(Buffer.concat(chunks)); });
        process.stdin.on("error", () => { cleanup(); reject(new Error("transport_input_invalid")); });
        if (window.checkpoint()) failure();
      });
      const inputJson = new TextDecoder("utf8", { fatal: true }).decode(bytes);
      if (window.checkpoint()) throw new Error(window.cause());
      const result = await run({ root, action, endpoint, inputJson, signal: controller.signal }, window);
      await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result) + "\n", error => error ? reject(error) : resolve()));
      if (result.reason || result.response !== "accepted_or_replay") process.exitCode = 1;
    } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
  } catch (error) {
    process.stdin.destroy();
    const reason = window?.cause() ?? safeCode(error);
    process.stderr.write(`${reason}\n`); process.exitCode = 1;
  }
}
