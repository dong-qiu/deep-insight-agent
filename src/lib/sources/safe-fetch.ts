/** SSRF 防护出网网关（architecture 安全设计 L369：禁内网段/私有IP/file://）。
 *  所有源出网（arxiv/rss/robots/未来 api）只走 safeFetch：协议白名单 + 逐跳 DNS 解析后
 *  拦私有/保留地址 + redirect:manual 自跟跳逐跳复检 + 超时。 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function v4PrivateOrReserved(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||           // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||  // 192.0.0.0/24 IETF 协议分配（注意：仅 /24，非 /16）
    (a === 192 && b === 0 && c === 2) ||  // 192.0.2.0/24 TEST-NET-1（文档示例）
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    a >= 224                               // multicast / 保留 224-255
  );
}

/** 私有 / 环回 / 链路本地 / 保留地址判定（IPv4 + IPv6；非法 IP 视为不安全）。 */
export function isPrivateOrReserved(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return v4PrivateOrReserved(ip);
  if (fam === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return v4PrivateOrReserved(mapped[1]);
    const head = low.split(":")[0];
    if (/^f[cd]/.test(head)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
    if (/^ff/.test(head)) return true; // ff00::/8 multicast
    return false;
  }
  return true; // 非合法 IP
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ""); // 去 IPv6 字面量括号
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateOrReserved(address)) {
      throw new Error(`SSRF 拦截：${hostname} 解析到非公网地址 ${address}`);
    }
  }
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
}

/** 单次抓取响应体字节上限（默认 8MB）：防异常巨大 feed 撑爆内存/XML 解析。 */
export const MAX_RESPONSE_BYTES = 8_000_000;

/** 流式读取响应体，超过 maxBytes 即中止——不把整个超大响应读进内存。
 *  - 默认（truncate=false）：超限抛错（保守，调用方按失败处理）。
 *  - opts.truncate=true：超限**截断保留已读部分**（仍封顶内存）而非抛错——给「内容本身可用、只是 feed 体量
 *    超大」的源用（如 Project Zero 13MB Atom、Latent Space 12.6MB podcast feed）。注意：仅字节截断不保证
 *    XML 良构（截断点常在 CDATA/标签中间），feed 路径须配 parseRss 的 repairTruncatedFeed 兜底再解析。
 *    截断时打一条 warn（不静默截断，便于运维发现源持续超限）。 */
export async function readTextCapped(
  res: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
  opts: { truncate?: boolean; label?: string } = {},
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      if (opts.truncate) {
        // chunks 不含触顶的这一块 → 已 ≤ maxBytes，干净边界返回（不切碎多字节字符）。
        console.warn(`[readTextCapped] 响应超 ${maxBytes} 字节，已截断保留前 ${Buffer.concat(chunks).length} 字节${opts.label ? `（${opts.label}）` : ""}`);
        return Buffer.concat(chunks).toString("utf8");
      }
      throw new Error(`响应体超过上限 ${maxBytes} 字节`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 安全出网：协议白名单 + 逐跳私有地址拦截 + 手动跟跳复检 + 超时。 */
/** 瞬时失败退避重试（ADR-0008 决定② / 切片3a）：**opt-in 包装** safeFetch——对【fetch 抛错（超时/网络/DNS）
 *  + 5xx 响应】退避重试，对【4xx / SSRF 拦截 / 非法 URL / 不允许协议 / 重定向过多】**不重试**（非瞬时）。
 *  吸收抖动源（FeedBurner 偶发）→ 单次抖动不再记一条 failed run、不放大 consecutiveFails。
 *  **不改 safeFetch 本身**（避免与其 redirect/SSRF 语义纠缠，评审裁决）；仅 fetchRss/fetchArticleBody 调用此包装。
 *  delaysMs 退避序列（默认 1s/3s、最多重试 2 次）；单测传 `[0,0]` 免真 sleep。 */
const NON_TRANSIENT = /^(非法 URL|不允许的协议|SSRF 拦截|重定向次数过多)/;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(
  input: string,
  opts: SafeFetchOptions = {},
  delaysMs: number[] = [1000, 3000],
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await safeFetch(input, opts);
      if (res.status >= 500 && attempt < delaysMs.length) {
        await sleep(delaysMs[attempt]); // 5xx 瞬时 → 退避重试
        continue;
      }
      return res; // 2xx / 4xx（非瞬时，不重试）
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (NON_TRANSIENT.test(msg) || attempt >= delaysMs.length) throw e; // 非瞬时 / 重试用尽
      await sleep(delaysMs[attempt]);
    }
  }
}

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  let target = input;
  for (let hop = 0; ; hop++) {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new Error(`非法 URL：${target}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`不允许的协议：${u.protocol}（仅 http/https）`);
    }
    await assertPublicHost(u.hostname);
    const res = await fetch(u, {
      headers: opts.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (hop >= maxRedirects) throw new Error("重定向次数过多");
      target = new URL(loc, u).toString(); // 下一跳，循环顶部重新校验
      continue;
    }
    return res;
  }
}
