/** 极简 robots.txt 解析与判定（合规落点，architecture 安全设计「合规与版权」）。
 *  仅处理 User-agent / Disallow 分组；Allow 与通配符细则留后续。 */
import { safeFetch } from "./safe-fetch.js";

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

export async function fetchRobots(origin: string, ua: string = UA): Promise<RobotsRules> {
  try {
    const res = await safeFetch(new URL("/robots.txt", origin).toString(), { headers: { "user-agent": ua } });
    const body = res.ok ? await res.text() : "";
    return rulesForStatus(res.status, body, ua);
  } catch {
    return { disallow: [] }; // 网络不可达：瞬时错误不永久阻断（保守放行），记录留后续
  }
}
