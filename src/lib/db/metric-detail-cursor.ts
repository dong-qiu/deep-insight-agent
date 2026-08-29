import type { FactKind } from "./p1-metrics-facts.js";

const FACT_KINDS: readonly FactKind[] = ["funnel", "cost", "validator"];

/** Opaque, versioned continuation token shared by the detail API and server page. */
export interface MetricDetailCursor {
  cursor_version: 1;
  kind: FactKind;
  from: string;
  to: string;
  as_of: string;
  occurred_at: string;
  id: string;
}

export function isMetricFactKind(value: string | null | undefined): value is FactKind {
  return FACT_KINDS.includes(value as FactKind);
}

export function decodeMetricDetailCursor(value: string | null | undefined): MetricDetailCursor | null {
  if (!value || value.length > 2048) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as MetricDetailCursor;
    return cursor.cursor_version === 1
      && isMetricFactKind(cursor.kind)
      && [cursor.from, cursor.to, cursor.as_of, cursor.occurred_at, cursor.id].every((part) => typeof part === "string")
      ? cursor
      : null;
  } catch {
    return null;
  }
}

export function encodeMetricDetailCursor(value: MetricDetailCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
