/** Diagnostic vocabulary only. Never use these labels to decide retries or acceptance. */
export const TRANSPORT_FAILURE_LABELS = [
  "transport_dns", "transport_tls", "transport_connection", "transport_timeout",
  "transport_client_closed", "transport_invalid_argument", "transport_aborted", "transport_unknown",
] as const;
export type TransportFailure = typeof TRANSPORT_FAILURE_LABELS[number];

const codes: Readonly<Record<string, TransportFailure>> = Object.freeze({
  ENOTFOUND: "transport_dns", EAI_AGAIN: "transport_dns",
  CERT_HAS_EXPIRED: "transport_tls", DEPTH_ZERO_SELF_SIGNED_CERT: "transport_tls",
  SELF_SIGNED_CERT_IN_CHAIN: "transport_tls", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "transport_tls",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "transport_tls", ERR_TLS_CERT_ALTNAME_INVALID: "transport_tls",
  ECONNRESET: "transport_connection", ECONNREFUSED: "transport_connection",
  EPIPE: "transport_connection", ENETUNREACH: "transport_connection", EHOSTUNREACH: "transport_connection",
  UND_ERR_SOCKET: "transport_connection",
  ETIMEDOUT: "transport_timeout", UND_ERR_CONNECT_TIMEOUT: "transport_timeout",
  UND_ERR_HEADERS_TIMEOUT: "transport_timeout", UND_ERR_BODY_TIMEOUT: "transport_timeout",
  UND_ERR_CLOSED: "transport_client_closed", UND_ERR_DESTROYED: "transport_client_closed",
  UND_ERR_INVALID_ARG: "transport_invalid_argument", ERR_INVALID_ARG_TYPE: "transport_invalid_argument",
});

/** Bounded traversal includes AggregateError causes; never exports message/code/hostname/URL. */
export function classifyTransportFailure(error: unknown): TransportFailure | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  let fallback: TransportFailure | undefined;
  for (let count = 0; pending.length && count < 16; count++) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof value.code === "string" && Object.hasOwn(codes, value.code)) return codes[value.code];
    if (value.name === "TimeoutError") fallback = "transport_timeout";
    else if (value.name === "AbortError" && !fallback) fallback = "transport_aborted";
    else if (value.name === "TypeError" && value.message === "fetch failed" && !fallback) fallback = "transport_unknown";
    pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 16));
  }
  return fallback;
}
