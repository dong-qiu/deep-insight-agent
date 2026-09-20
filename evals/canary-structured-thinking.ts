/**
 * Minimal relay admission test for the exact combination used by A1:
 * extended thinking + forced tool_choice structured output.  It intentionally uses one tiny
 * request and prints only model/capability/token metadata, never credentials or endpoint.
 *
 * Usage: npm run eval:canary-thinking
 */
import "./load-env.js";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicBaseUrl, MODELS } from "../src/lib/runtime/llm.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(JSON.stringify({ supported: false, reason: "missing_ANTHROPIC_API_KEY" }));
  process.exit(2);
}

const client = new Anthropic({
  timeout: 30_000,
  maxRetries: 0,
  ...(anthropicBaseUrl() ? { baseURL: anthropicBaseUrl() } : {}),
});

try {
  const stream = client.messages.stream({
    model: MODELS.validator,
    max_tokens: 2048,
    system: "Return the requested structured response.",
    messages: [{ role: "user", content: "Return ok=true." }],
    tools: [{
      name: "canary_result",
      description: "Return the canary result.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    }],
    tool_choice: { type: "tool", name: "canary_result" },
    thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" },
  });
  const response = await stream.finalMessage();
  const tool = response.content.find((block) => block.type === "tool_use" && block.name === "canary_result");
  const result = {
    supported: Boolean(tool),
    model: MODELS.validator,
    stop_reason: response.stop_reason,
    content_types: response.content.map((block) => block.type),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      thinking_tokens: response.usage.output_tokens_details?.thinking_tokens ?? null,
    },
  };
  console.log(JSON.stringify(result));
  process.exit(tool ? 0 : 1);
} catch (error) {
  const status = typeof error === "object" && error != null && "status" in error ? (error as { status?: unknown }).status : undefined;
  // Do not print URL/key-bearing request configuration from an SDK error object.
  console.error(JSON.stringify({ supported: false, model: MODELS.validator, error_type: error instanceof Error ? error.name : "unknown", ...(typeof status === "number" ? { status } : {}) }));
  process.exit(1);
}
