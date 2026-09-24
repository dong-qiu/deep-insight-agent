/**
 * Minimal provider admission test for the exact combination used by A1: thinking + forced
 * structured output. It intentionally uses one tiny request and prints only safe metadata,
 * never credentials, endpoint or source/prompt material.
 *
 * Usage: npm run eval:canary-thinking
 */
import "./load-env.js";
import { z } from "zod/v4";
import { callStructured, MODELS } from "../src/lib/runtime/llm.js";
import { llmApiKey, llmProvider, structuredTransportVersion } from "../src/lib/runtime/llm-provider.js";
import { safeProviderAdmissionError } from "./provider-admission-canary-lib.js";

const provider = llmProvider();
if (!llmApiKey(provider)) {
  console.error(JSON.stringify({ supported: false, provider, reason: provider === "volcengine-responses" ? "missing_LLM_API_KEY" : "missing_LLM_API_KEY_or_ANTHROPIC_API_KEY" }));
  process.exit(2);
}

try {
  const response = await callStructured({
    role: "validator", system: "Return the requested structured response.", user: "Return ok=true.",
    schema: z.object({ ok: z.boolean() }), maxTokens: 2048, thinking: true,
  });
  const result = {
    supported: response.data.ok === true,
    provider,
    model: MODELS.validator,
    structured_transport_version: structuredTransportVersion(),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
  console.log(JSON.stringify(result));
  process.exit(result.supported ? 0 : 1);
} catch (error) {
  // Do not print URL/key-bearing request configuration from an SDK error object.
  console.error(JSON.stringify({ supported: false, provider, model: MODELS.validator, ...safeProviderAdmissionError(error) }));
  process.exit(1);
}
