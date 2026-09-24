/** 极简 robots.txt 解析与判定（合规落点，architecture 安全设计「合规与版权」）。
 *  仅处理 User-agent / Disallow 分组；Allow 与通配符细则留后续。 */
import { MAX_RESPONSE_BYTES, ResponseSizeLimitError, readTextCapped, safeFetch } from "./safe-fetch.js";

export const UA = "InsightAgentBot";

export interface RobotsRules {
  disallow: string[];
}

interface Group {
  agents: string[];
  disallow: string[];
}

export function parseRobots(txt: string, ua: string = UA): RobotsRules {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !cur) {
        cur = { agents: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "disallow" && cur) {
      cur.disallow.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const uaLower = ua.toLowerCase();
  const matches = (g: Group, wantStar: boolean) =>
    g.agents.some((a) => (wantStar ? a === "*" : a !== "*" && (uaLower.includes(a) || a.includes(uaLower))));
  // 精确 UA 组优先于 *；都无则不限制
  const exact = groups.filter((g) => matches(g, false));
  const star = groups.filter((g) => matches(g, true));
  const use = exact.length ? exact : star;
  return { disallow: use.flatMap((g) => g.disallow).filter((d) => d !== "") };
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  return !rules.disallow.some((d) => path.startsWith(d));
}

/** 按 HTTP 状态码把抓取结果映射为规则（Google robots 语义）：
 *  - 2xx：解析正文规则；
 *  - 4xx（含 404 = 无 robots.txt）：不限制（放行全站）；
 *  - 5xx：服务器异常，保守视为**全站禁止**（disallow "/"），避免在源不稳时越权抓取。 */
export function rulesForStatus(status: number, body: string, ua: string = UA): RobotsRules {
  if (status >= 200 && status < 300) return parseRobots(body, ua);
  if (status >= 500) return { disallow: ["/"] };
  return { disallow: [] };
}

/** `beforeRequest` lets a source-level acquisition policy apply the same QPS/deadline gate to
 * robots transport and content transport. Existing callers retain the safe default behavior. */
export async function fetchRobots(
  origin: string,
  ua: string = UA,
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    beforeRequest?: (url: string) => Promise<void>;
    /** Accounts for robots bytes in an enclosing source-level acquisition budget. */
    onBytes?: (bytes: number) => void;
  } = {},
): Promise<RobotsRules> {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  try {
    const res = await safeFetch(robotsUrl, { headers: { "user-agent": ua }, timeoutMs: opts.timeoutMs, beforeRequest: opts.beforeRequest });
    let body = "";
    if (res.ok) {
      try {
        body = await readTextCapped(res, opts.maxBytes ?? MAX_RESPONSE_BYTES);
        opts.onBytes?.(Buffer.byteLength(body, "utf8"));
      } catch (error) {
        if (error instanceof ResponseSizeLimitError) opts.onBytes?.(error.bytesRead);
        throw error;
      }
    }
    return rulesForStatus(res.status, body, ua);
  } catch (error) {
    // A policy gate denial is intentional control flow, not an unavailable robots endpoint. It
    // must reach the structured podcast outcome instead of falling through as fail-open rules.
    if (error instanceof Error && error.name === "PodcastRequestBudgetError") throw error;
    // An oversized robots response is an untrusted-body limit violation, not a transient
    // availability miss. Never silently convert it into an allow-all rule.
    if (error instanceof ResponseSizeLimitError) throw error;
    return { disallow: [] }; // 网络不可达：瞬时错误不永久阻断（保守放行），记录留后续
  }
}
