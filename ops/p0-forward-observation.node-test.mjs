import assert from "node:assert/strict";
import test from "node:test";
import { formatSnapshot, parseArgs, remoteAggregateProgram, remoteCommandForAggregate } from "./p0-forward-observation.mjs";

test("parses conservative terminal observation options", () => {
  assert.deepEqual(parseArgs([]), { watch: false, untilCandidateThreshold: false, intervalSeconds: 900 });
  assert.deepEqual(parseArgs(["--watch", "--until-candidate-threshold", "--interval", "300"]), {
    watch: true, untilCandidateThreshold: true, intervalSeconds: 300,
  });
  assert.throws(() => parseArgs(["--interval", "299"]), /at least 300/);
  assert.throws(() => parseArgs(["--until-candidate-threshold"]), /requires --watch/);
});

test("remote aggregate returns only aggregate counts and never starts a pipeline", () => {
  const command = remoteCommandForAggregate();
  const program = remoteAggregateProgram();
  assert.match(command, /docker exec deep-insight-app-1/);
  assert.doesNotMatch(program, /api\/cron|trigger\.mjs|INSERT|UPDATE|DELETE/i);
  assert.doesNotMatch(program, /actual_candidate|actual_direction|actual_lane/i);
});

test("candidate threshold is explicitly not the human dogfood gate", () => {
  const below = formatSnapshot({ total_tech_leads: 530, candidate_source_quote_v1: 49 }, "2026-09-12T00:00:00.000Z");
  assert.match(below, /49\/50/);
  assert.match(below, /do not replay history or start INSI-180/);
  const reached = formatSnapshot({ total_tech_leads: 530, candidate_source_quote_v1: 50 }, "2026-09-12T00:00:00.000Z");
  assert.match(reached, /create a fresh private snapshot/);
  assert.match(reached, /eval:opportunity-export/);
  assert.doesNotMatch(reached, /open INSI-180$/);
});
