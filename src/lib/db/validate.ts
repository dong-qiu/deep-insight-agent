/** 设置页 CRUD 输入校验（B-3）：纯函数，无 IO，可单测。
 *  返 { ok: true, value } | { ok: false, message }——调用方按 message 返 422。 */
import type { Industry, Language, Source, Topic } from "../types.js";

export const INDUSTRY_VALUES = new Set<Industry>(["ai-swe", "ai-security"]);
export const LANGUAGE_VALUES = new Set<Language>(["zh", "en", "mixed"]);
export const SOURCE_TYPES = new Set<Source["type"]>(["rss", "arxiv", "api"]);
export const BRIEF_SCHEDULES = new Set<Topic["brief_schedule"]>(["daily", "weekly"]);

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function s(v: unknown, key: string, max = 200): string | { fail: string } {
  if (typeof v !== "string") return { fail: `${key} 必须为字符串` };
  const t = v.trim();
  if (!t) return { fail: `${key} 不能为空` };
  if (t.length > max) return { fail: `${key} 长度 ${t.length} > ${max}` };
  return t;
}
function arr<T>(v: unknown, key: string): T[] | { fail: string } {
  if (!Array.isArray(v)) return { fail: `${key} 必须为数组` };
  return v as T[];
}

export function validateTopicInput(body: unknown, opts: { existingId?: string } = {}): Validated<Topic> {
  if (!body || typeof body !== "object") return { ok: false, message: "body 必须为 JSON 对象" };
  const o = body as Record<string, unknown>;

  const name = s(o.name, "name", 80);
  if (typeof name !== "string") return { ok: false, message: name.fail };
  const id = opts.existingId ?? (typeof o.id === "string" && o.id.trim()
    ? o.id.trim()
    : `t_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)}_${Date.now().toString(36).slice(-4)}`);
  if (!/^[a-z0-9_\-]+$/i.test(id)) return { ok: false, message: "id 只能含字母/数字/下划线/连字符" };

  const kws = arr<string>(o.keywords, "keywords");
  if (!Array.isArray(kws)) return { ok: false, message: kws.fail };
  if (kws.length === 0) return { ok: false, message: "keywords 不能为空" };
  // Sonnet R1 review concern：keyword 单项无长度限制（>100 字属脏数据）
  for (const k of kws) {
    if (typeof k !== "string") return { ok: false, message: "keywords 元素必须为字符串" };
    if (k.trim().length > 100) return { ok: false, message: `keyword "${k.slice(0, 20)}…" 超过 100 字符上限` };
  }

  const ind = typeof o.industry === "string" ? o.industry : "";
  if (!INDUSTRY_VALUES.has(ind as Industry)) {
    return { ok: false, message: `industry 必须是 ${[...INDUSTRY_VALUES].join("/")}` };
  }
  const lang = typeof o.language === "string" ? o.language : "zh";
  if (!LANGUAGE_VALUES.has(lang as Language)) {
    return { ok: false, message: `language 必须是 ${[...LANGUAGE_VALUES].join("/")}` };
  }
  const bs = typeof o.brief_schedule === "string" ? o.brief_schedule : "daily";
  if (!BRIEF_SCHEDULES.has(bs as Topic["brief_schedule"])) {
    return { ok: false, message: "brief_schedule 必须是 daily/weekly" };
  }

  return {
    ok: true,
    value: {
      id, name, keywords: kws.map((k) => String(k).trim()).filter(Boolean),
      industry: ind as Industry, language: lang as Language,
      brief_schedule: bs as Topic["brief_schedule"],
      enabled: o.enabled !== false,
    },
  };
}

export function validateSourceInput(body: unknown, opts: { existingId?: string } = {}): Validated<Source> {
  if (!body || typeof body !== "object") return { ok: false, message: "body 必须为 JSON 对象" };
  const o = body as Record<string, unknown>;

  const name = s(o.name, "name", 80);
  if (typeof name !== "string") return { ok: false, message: name.fail };
  const id = opts.existingId ?? (typeof o.id === "string" && o.id.trim()
    ? o.id.trim()
    : `src_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)}_${Date.now().toString(36).slice(-4)}`);
  if (!/^[a-z0-9_\-]+$/i.test(id)) return { ok: false, message: "id 只能含字母/数字/下划线/连字符" };

  const type = typeof o.type === "string" ? o.type : "";
  if (!SOURCE_TYPES.has(type as Source["type"])) {
    return { ok: false, message: `type 必须是 ${[...SOURCE_TYPES].join("/")}` };
  }

  const endpoint = s(o.endpoint, "endpoint", 500);
  if (typeof endpoint !== "string") return { ok: false, message: endpoint.fail };
  try {
    new URL(endpoint);
  } catch {
    return { ok: false, message: "endpoint 必须是合法 URL（含 protocol）" };
  }

  const ind = typeof o.industry === "string" ? o.industry : "";
  if (!INDUSTRY_VALUES.has(ind as Industry)) {
    return { ok: false, message: `industry 必须是 ${[...INDUSTRY_VALUES].join("/")}` };
  }

  const topicIds = arr<string>(o.topic_ids, "topic_ids");
  if (!Array.isArray(topicIds)) return { ok: false, message: topicIds.fail };

  const interval = s(o.fetch_interval ?? "1h", "fetch_interval", 16);
  if (typeof interval !== "string") return { ok: false, message: interval.fail };
  if (!/^\d+[smhd]$/.test(interval)) return { ok: false, message: "fetch_interval 须形如 1h / 30m / 1d" };

  return {
    ok: true,
    value: {
      id, name, type: type as Source["type"], endpoint,
      industry: ind as Industry, topic_ids: topicIds.map((t) => String(t).trim()).filter(Boolean),
      fetch_interval: interval, backfill: null, enabled: o.enabled !== false,
    },
  };
}
