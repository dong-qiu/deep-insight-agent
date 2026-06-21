/** 设置页 CRUD 输入校验（B-3）：纯函数，无 IO，可单测。
 *  返 { ok: true, value } | { ok: false, message }——调用方按 message 返 422。 */
import { randomBytes } from "node:crypto";
import type { Industry, Language, Source, Topic } from "../types.js";

/** 自动生成 id 末尾 4 位随机十六进制（review #8b：替代 Date.now().toString(36).slice(-4)
 *  的时间戳熵——并发批量创建时 ts36 末 4 位可能撞车，64K 随机空间冲突率显著更低）。 */
function rand4(): string {
  return randomBytes(2).toString("hex");
}

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
    : `t_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)}_${rand4()}`);
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
    : `src_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)}_${rand4()}`);
  if (!/^[a-z0-9_\-]+$/i.test(id)) return { ok: false, message: "id 只能含字母/数字/下划线/连字符" };

  const type = typeof o.type === "string" ? o.type : "";
  if (!SOURCE_TYPES.has(type as Source["type"])) {
    return { ok: false, message: `type 必须是 ${[...SOURCE_TYPES].join("/")}` };
  }
  // ADR-0008 决定④：堵 api 半开陷阱——type 枚举/schema 保留 api（留作未来类型），但适配器未实现
  // （sources/index.ts 对 api 直接抛错）；若放行建源 → 每轮采集必抛 failed。建源阶段显式拒，给清晰原因。
  if (type === "api") {
    return { ok: false, message: "api 类型适配器尚未实现，暂不可创建该类型源（ADR-0008 决定④）" };
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

  // ADR-0008 决定③：fetch_mode（默认 feed）+ content_container（可选容器 token，非 CSS 选择器）
  const fetchMode = o.fetch_mode === "full_text" ? "full_text" : "feed";
  let container: string | null = null;
  if (o.content_container != null && o.content_container !== "") {
    const c = s(o.content_container, "content_container", 64);
    if (typeof c !== "string") return { ok: false, message: c.fail };
    // 单个 class/id token：限字母数字/-/_/:（防 CSS 组合选择器误填、与无 DOM 正则引擎不兼容——ADR 决定③）
    if (!/^[a-zA-Z0-9_:-]+$/.test(c)) {
      return { ok: false, message: "content_container 须是单个 class/id 名（字母数字/-/_/:），不支持 CSS 选择器" };
    }
    container = c;
  }

  return {
    ok: true,
    value: {
      id, name, type: type as Source["type"], endpoint,
      industry: ind as Industry, topic_ids: topicIds.map((t) => String(t).trim()).filter(Boolean),
      fetch_interval: interval, backfill: null, enabled: o.enabled !== false,
      fetch_mode: fetchMode, content_container: container,
    },
  };
}
