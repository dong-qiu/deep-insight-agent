/** POST /api/directions/:id —— 方向状态由管理员显式校准；不会重新解释历史事实。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../lib/db/audit.js";
import { getDb } from "../../../../lib/db/index.js";
import { getTopicDirection, setTopicDirectionStatus, updateTopicDirection } from "../../../../lib/db/planning.js";
import { parseTopicDirectionInput } from "../../../../lib/planning/direction-input.js";
import type { TopicDirectionStatus } from "../../../../lib/types.js";

export const dynamic = "force-dynamic";
const STATUSES = new Set<TopicDirectionStatus>(["active", "watching", "retired"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const status = (await req.json().catch(() => ({})) as { status?: string }).status;
  if (!status || !STATUSES.has(status as TopicDirectionStatus)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  const db = getDb();
  if (!setTopicDirectionStatus(db, id, status as TopicDirectionStatus)) return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  appendAudit(db, { action: "topic_direction_status", target: id, detail: { status } });
  return NextResponse.json({ ok: true, status });
}

/** PUT 完整编辑方向。前端必须带上读取时的 version，避免两个管理员静默覆盖彼此词表。 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json().catch(() => null) as { direction?: unknown; expected_version?: unknown } | null;
  const direction = parseTopicDirectionInput(body?.direction);
  const expectedVersion = body?.expected_version;
  if (!direction || direction.id !== id || !Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) return NextResponse.json({ error: "invalid_direction_update" }, { status: 422 });
  const db = getDb();
  const before = getTopicDirection(db, id);
  const result = updateTopicDirection(db, direction, expectedVersion as number);
  if (result.kind === "not_found") return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  if (result.kind === "conflict") return NextResponse.json({ error: "direction_version_conflict", current: result.current }, { status: 409 });
  const rulesChanged = !!before && ["match_terms", "adjacent_terms", "challenge_terms"].some((key) => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(direction[key as keyof typeof direction]));
  appendAudit(db, { action: "topic_direction_update", target: id, detail: { from_version: before?.version, to_version: result.direction.version, rules_changed: rulesChanged } });
  return NextResponse.json({ ok: true, direction: result.direction, rules_changed: rulesChanged });
}
