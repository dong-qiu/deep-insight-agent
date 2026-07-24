/** 方向工作台的共享输入校验：API 坚持边界，前端仅复用类型和默认值。 */
import type { TopicDirectionHorizon, TopicDirectionInput, TopicDirectionStatus } from "../types.js";

const HORIZONS = new Set<TopicDirectionHorizon>(["now", "next", "explore"]);
const STATUSES = new Set<TopicDirectionStatus>(["active", "watching", "retired"]);
const ARRAY_FIELDS = ["in_scope", "out_of_scope", "key_questions", "constraints", "success_signals", "match_terms", "adjacent_terms", "challenge_terms"] as const;

const list = (value: unknown): string[] | null => Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean) : null;

export function parseTopicDirectionInput(value: unknown): TopicDirectionInput | null {
  const body = value as Record<string, unknown> | null;
  if (!body) return null;
  const scalar = ["id", "topic_id", "name", "objective", "problem_statement"] as const;
  if (scalar.some((key) => typeof body[key] !== "string" || !(body[key] as string).trim())) return null;
  const parsed = Object.fromEntries(ARRAY_FIELDS.map((key) => [key, list(body[key])])) as Record<typeof ARRAY_FIELDS[number], string[] | null>;
  if (ARRAY_FIELDS.some((key) => !parsed[key])) return null;
  if (!HORIZONS.has(body.horizon as TopicDirectionHorizon) || !STATUSES.has(body.status as TopicDirectionStatus)) return null;
  return {
    id: (body.id as string).trim(), topic_id: (body.topic_id as string).trim(), name: (body.name as string).trim(), objective: (body.objective as string).trim(), problem_statement: (body.problem_statement as string).trim(),
    in_scope: parsed.in_scope!, out_of_scope: parsed.out_of_scope!, key_questions: parsed.key_questions!, constraints: parsed.constraints!, success_signals: parsed.success_signals!, match_terms: parsed.match_terms!, adjacent_terms: parsed.adjacent_terms!, challenge_terms: parsed.challenge_terms!, horizon: body.horizon as TopicDirectionHorizon, status: body.status as TopicDirectionStatus,
  };
}
