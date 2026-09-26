import { materializeShadowInput, readShadowInputRequest, ShadowInputError } from "./podcast-shadow-eval-input.js";

try {
  const [requestPath, output, ...extra] = process.argv.slice(2);
  if (!requestPath || !output || extra.length || !process.env.EVAL_ISOLATED_ROOT) throw new ShadowInputError("usage_request_output_isolated_root_required");
  const manifest = materializeShadowInput(readShadowInputRequest(requestPath), output, process.env.EVAL_ISOLATED_ROOT);
  console.log(JSON.stringify({ status: "prepared", sources: manifest.sources.length, selected: manifest.selected.length }));
} catch (error) {
  console.error(`podcast_shadow_input:${error instanceof ShadowInputError ? error.message : "input_or_output_invalid"}`);
  process.exitCode = 1;
}
