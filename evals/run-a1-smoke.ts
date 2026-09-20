/** Fast developer feedback only. The imported runner still executes the real model path, but
 * this wrapper forces a bounded subset and non-promotable smoke status. */
import "./load-env.js";
import { A1_SMOKE_LIMITS, applyA1SmokeConfig } from "./a1-smoke-config.js";

applyA1SmokeConfig();
console.log(
  `A1 fast smoke: quality=${A1_SMOKE_LIMITS.A1_QUALITY_LIMIT}, consistency=${A1_SMOKE_LIMITS.A1_CONSISTENCY_LIMIT}, ` +
  `display=${A1_SMOKE_LIMITS.A1_DISPLAY_COVERAGE_LIMIT}, quote=${A1_SMOKE_LIMITS.A1_QUOTE_SELF_CONTAINED_LIMIT}; non-promotable.\n`,
);
await import("./run-a1.js");
