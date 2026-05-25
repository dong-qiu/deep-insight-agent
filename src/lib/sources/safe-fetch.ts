/** SSRF 防护出网网关（architecture 安全设计 L369：禁内网段/私有IP/file://）。
 *  所有源出网（arxiv/rss/robots/未来 api）只走 safeFetch：协议白名单 + 逐跳 DNS 解析后
 *  拦私有/保留地址 + redirect:manual 自跟跳逐跳复检 + 超时。 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function v4PrivateOrReserved(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||           // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||             // 192.0.0/24
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

/** 安全出网：协议白名单 + 逐跳私有地址拦截 + 手动跟跳复检 + 超时。 */
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
