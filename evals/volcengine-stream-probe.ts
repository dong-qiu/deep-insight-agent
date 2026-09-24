/**
 * Bounded live probe for a Coding Plan Responses stream. It deliberately calls the production
 * `callStructured` path, but supplies only synthetic input and persists aggregate protocol data.
 */
import "./load-env.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { coverageThinking, llmTimeoutMs, llmTransientRetries } from "../src/lib/runtime/env.js";
import { assertCoverageModelSeparation, callStructured, getRoleCallTelemetry, MODELS } from "../src/lib/runtime/llm.js";
import { llmApiKey, llmProvider, structuredTransportVersion } from "../src/lib/runtime/llm-provider.js";
import { VolcengineResponsesError } from "../src/lib/runtime/volcengine-responses.js";
import {
  VOLCENGINE_STREAM_PROBE_SCHEMA_VERSION,
  probeAttemptsPerProfile,
  probePassed,
  safeProbeErrorType,
  safeProbeHttpStatus,
  selectProbeProfiles,
  summarizeProbeProfile,
  syntheticProbeInput,
  type ProbeAttempt,
  type ProbeFailure,
} from "./volcengine-stream-probe-lib.js";

function safeFailure(error: unknown): ProbeFailure {
  if (!(error instanceof VolcengineResponsesError)) return { error_type: safeProbeErrorType(error) };
  const diagnostic = error.streamDiagnostic;
  const status = safeProbeHttpStatus(error.status);
  return {
    error_type: "VolcengineResponsesError",
    ...(diagnostic ? {
      terminal: diagnostic.terminal,
      ...(diagnostic.incompleteReason ? { incomplete_reason: diagnostic.incompleteReason } : {}),
      saw_done: diagnostic.sawDone,
      function_arguments_done: diagnostic.functionArgumentsDone,
    } : {}),
    ...(status != null ? { http_status: status } : {}),
  };
}

function probeOutputPath(): string {
  const root = resolve("evals/out/volcengine-stream-probes");
  const configured = process.env.VOLCENGINE_STREAM_PROBE_OUT?.trim();
  const candidate = configured
    ? resolve(configured)
    : resolve(root, `volcengine-stream-probe-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}.json`);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("VOLCENGINE_STREAM_PROBE_OUT 必须位于 evals/out/volcengine-stream-probes 下");
  }
  return candidate;
}

function writeProbe(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function main(): Promise<void> {
  const provider = llmProvider();
  if (provider !== "volcengine-responses") throw new Error("Volcengine stream probe 仅支持 LLM_PROVIDER=volcengine-responses");
  if (!llmApiKey(provider)) throw new Error("Volcengine stream probe 需要 LLM_API_KEY");
  assertCoverageModelSeparation();

  const startedAt = new Date().toISOString();
  const attemptsPerProfile = probeAttemptsPerProfile();
  const profiles = selectProbeProfiles();
  const attempts: ProbeAttempt[] = [];
  const outputPath = probeOutputPath();
  const output = (status: "running" | "completed" | "failed") => ({
    schema_version: VOLCENGINE_STREAM_PROBE_SCHEMA_VERSION,
    status,
    started_at: startedAt,
    ...(status !== "running" ? { ended_at: new Date().toISOString() } : {}),
    config: {
      provider,
      coverage_model: MODELS.coverage,
      coverage_thinking: coverageThinking(),
      structured_transport_version: structuredTransportVersion(),
      llm_timeout_ms: llmTimeoutMs(),
      transient_retries: llmTransientRetries(),
      attempts_per_profile: attemptsPerProfile,
      profile_ids: profiles.map((profile) => profile.id),
    },
    profiles: profiles.map((profile) =>
      summarizeProbeProfile(profile, attempts.filter((attempt) => attempt.profile_id === profile.id))),
    llm_role_telemetry: getRoleCallTelemetry().coverage,
  });
  writeProbe(outputPath, output("running"));
  for (const profile of profiles) {
    const schema = z.object({
      accepted: z.literal(true),
      synthetic_evidence: z.literal("ok"),
    });
    for (let index = 0; index < attemptsPerProfile; index++) {
      const started = performance.now();
      try {
        await callStructured({
          role: "coverage",
          telemetryOperation: "volcengine_stream_probe",
          system: "This is a transport probe. Return only the forced structured response. The input is synthetic and contains no external facts.",
          user: [
            'Set accepted=true. Set synthetic_evidence to the literal string "ok".',
            "Synthetic context follows:",
            syntheticProbeInput(profile.inputChars),
          ].join("\n"),
          schema,
          maxTokens: profile.maxTokens,
          thinking: coverageThinking(),
        });
        attempts.push({ profile_id: profile.id, duration_ms: performance.now() - started });
      } catch (error) {
        attempts.push({ profile_id: profile.id, duration_ms: performance.now() - started, failure: safeFailure(error) });
      }
      writeProbe(outputPath, output("running"));
    }
  }

  const profilesSummary = output("running").profiles;
  const completed = output(probePassed(profilesSummary) ? "completed" : "failed");
  writeProbe(outputPath, completed);
  console.log(JSON.stringify({
    status: completed.status,
    output: outputPath,
    profiles: completed.profiles.map((profile) => ({
      id: profile.profile.id,
      attempts: profile.attempts,
      successes: profile.successes,
      failures: profile.failures,
      terminal_events: profile.terminal_events,
    })),
  }));
  if (completed.status === "failed") process.exitCode = 1;
}

main().catch((error) => {
  // Never expose an upstream body, a prompt, a source, or an opaque request id from a CLI error.
  console.error(JSON.stringify({ status: "failed", error_type: safeProbeErrorType(error) }));
  process.exit(1);
});
