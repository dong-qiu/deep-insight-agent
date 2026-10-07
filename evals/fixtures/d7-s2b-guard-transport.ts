/** Subprocess test transport: never delegates to network, never loads local configuration. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
globalThis.fetch = async () => {
  if (process.env.D7_SYNTHETIC_LATE === "1") {
    const state = JSON.parse(readFileSync(join(process.env.D7_EVALUATION_ROOT!, "budget.json"), "utf8"));
    Date.now = () => state.deadline; // Advance only after dispatch, so slow CI module loading does not alter the test.
    await new Promise((done) => setTimeout(done, 10));
  }
  const events = [
    { type: "response.function_call_arguments.done", name: "respond_with_structured_output", arguments: '{"value":"ok"}' },
    { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  return new Response(events.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
};
