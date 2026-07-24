/** GET/POST /api/directions —— 方向档案的读接口与管理员创建接口。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../lib/auth-guard.js";
import { appendAudit } from "../../../lib/db/audit.js";
import { getDb } from "../../../lib/db/index.js";
import { createTopicDirection, getTopicDirection, listTopicDirections } from "../../../lib/db/planning.js";
import { getTopic } from "../../../lib/db/repos.js";
import type { TopicDirectionInput, TopicDirectionStatus, TopicDirectionHorizon } from "../../../lib/types.js";

export const dynamic = "force-dynamic";
const HORIZONS = new Set<TopicDirectionHorizon>(["now", "next", "explore"]);
const STATUSES = new Set<TopicDirectionStatus>(["active", "watching", "retired"]);
const list = (value: unknown): string[] | null => Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean) : null;

function parseInput(value: unknown): TopicDirectionInput | null {
  const body = value as Record<string, unknown> | null;
  if (!body) return null;
  const scalar = ["id", "topic_id", "name", "objective", "problem_statement"] as const;
  if (scalar.some((key) => typeof body[key] !== "string" || !(body[key] as string).trim())) return null;
  const arrays = ["in_scope", "out_of_scope", "key_questions", "constraints", "success_signals", "match_terms", "adjacent_terms", "challenge_terms"] as const;
  const parsed = Object.fromEntries(arrays.map((key) => [key, list(body[key])])) as Record<typeof arrays[number], string[] | null>;
  if (arrays.some((key) => !parsed[key])) return null;
  if (!HORIZONS.has(body.horizon as TopicDirectionHorizon) || !STATUSES.has(body.status as TopicDirectionStatus)) return null;
  return {
    id: (body.id as string).trim(), topic_id: (body.topic_id as string).trim(), name: (body.name as string).trim(),
    objective: (body.objective as string).trim(), problem_statement: (body.problem_statement as string).trim(),
    in_scope: parsed.in_scope!, out_of_scope: parsed.out_of_scope!, key_questions: parsed.key_questions!, constraints: parsed.constraints!,
    success_signals: parsed.success_signals!, match_terms: parsed.match_terms!, adjacent_terms: parsed.adjacent_terms!, challenge_terms: parsed.challenge_terms!,
    horizon: body.horizon as TopicDirectionHorizon, status: body.status as TopicDirectionStatus,
  };
}

export function GET(req: Request): NextResponse {
  const sp = new URL(req.url).searchParams;
  return NextResponse.json({ items: listTopicDirections(getDb(), { topic: sp.get("topic") ?? undefined, includeRetired: sp.get("all") === "1" }) });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const input = parseInput(await req.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "invalid_direction" }, { status: 422 });
  const db = getDb();
  if (!getTopic(db, input.topic_id)) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });
  if (getTopicDirection(db, input.id)) return NextResponse.json({ error: "direction_id_exists" }, { status: 409 });
  const direction = createTopicDirection(db, input);
  appendAudit(db, { action: "topic_direction_create", target: input.id, detail: { topic_id: input.topic_id } });
  return NextResponse.json({ status: "created", direction }, { status: 201 });
}
