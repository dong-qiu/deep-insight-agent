/**
 * Provider admission check for every role that participates in the A1 safety path. It uses one
 * tiny, forced structured call per role and reports only safe transport metadata.
 */
import "./load-env.js";
import { z } from "zod/v4";
import { coverageThinking, validatorThinking } from "../src/lib/runtime/env.js";
import { assertCoverageModelSeparation, callStructured, MODELS } from "../src/lib/runtime/llm.js";
import { llmApiKey, llmProvider, structuredTransportVersion } from "../src/lib/runtime/llm-provider.js";
import { runProviderAdmissionCanary, safeProviderAdmissionError } from "./provider-admission-canary-lib.js";

const provider = llmProvider();
if (!llmApiKey(provider)) {
  console.error(JSON.stringify({
    supported: false,
    provider,
    reason: provider === "volcengine-responses" ? "missing_LLM_API_KEY" : "missing_LLM_API_KEY_or_ANTHROPIC_API_KEY",
  }));
  process.exit(2);
}

try {
  assertCoverageModelSeparation();
  const schema = z.object({ ok: z.boolean() });
  const result = await runProviderAdmissionCanary({
    provider,
    structuredTransportVersion: structuredTransportVersion(),
    models: { analyzer: MODELS.analyzer, validator: MODELS.validator, coverage: MODELS.coverage },
    thinking: { analyzer: false, validator: validatorThinking(), coverage: coverageThinking() },
    call: async ({ role, thinking }) => {
      const response = await callStructured({
        role,
        telemetryOperation: `provider_admission_${role}`,
        system: "Return the requested structured response.",
        user: "Return ok=true.",
        schema,
        maxTokens: 2048,
        thinking,
      });
      return { ok: response.data.ok, usage: response.usage };
    },
  });
  console.log(JSON.stringify(result));
  process.exit(result.supported ? 0 : 1);
} catch (error) {
  // Do not print request configuration or provider error bodies: either could contain sensitive input.
  console.error(JSON.stringify({
    supported: false,
    provider,
    ...safeProviderAdmissionError(error),
  }));
  process.exit(1);
}
