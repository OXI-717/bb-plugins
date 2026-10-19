const CATEGORIES = new Map<string, string>([
  ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"],
  ["UND_ERR_CONNECT_TIMEOUT", "connect"], ["ECONNREFUSED", "connect"],
  ["ETIMEDOUT", "timeout"], // A generic timeout does not establish the stage.
  ["ECONNRESET", "socket"], ["UND_ERR_SOCKET", "socket"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"], ["CERT_HAS_EXPIRED", "tls"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"], ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
  ["ERR_SSL_WRONG_VERSION_NUMBER", "tls"], ["ERR_SSL_UNEXPECTED_EOF_WHILE_READING", "tls"],
  ["UND_ERR_HEADERS_TIMEOUT", "headers"], ["UND_ERR_BODY_TIMEOUT", "body"],
  ["ERR_HTTP2_INVALID_SESSION", "session"], ["ERR_HTTP2_GOAWAY_SESSION", "session"],
  ["UND_ERR_DESTROYED", "session"], ["UND_ERR_CLOSED", "session"],
  ["ABORT_ERR", "abort"], ["UND_ERR_ABORTED", "abort"],
]);

/** Only fixed vocabulary leaves this boundary; never messages, URLs or arbitrary codes. */
export function describeTransportError(error: unknown): { code: string; category: string } {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let visited = 0; pending.length > 0 && visited < 12; visited++) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    try {
      const code = "code" in current ? current.code : undefined;
      if (typeof code === "string" && CATEGORIES.has(code))
        return { code, category: CATEGORIES.get(code)! };
      if (current.name === "AbortError") return { code: "ABORT_ERR", category: "abort" };
      pending.push(current.cause);
      if (current instanceof AggregateError && Array.isArray(current.errors))
        pending.push(...current.errors.slice(0, 12));
    } catch { /* An unusual error accessor must not break error handling. */ }
  }
  return { code: "unknown", category: "unknown" };
}

/** Time to response headers, including connection setup, but excluding policy checks and body reads. */
export function observeUpstreamFetch(upstream: typeof fetch, onError: (error: unknown, elapsedMs: number) => void, clock = () => performance.now()): typeof fetch {
  return async (input, init) => {
    const started = clock();
    try { return await upstream(input, init); }
    catch (error) {
      const aborted = init?.signal?.aborted || (input instanceof Request && input.signal.aborted);
      if (!aborted) {
        try { onError(error, Math.max(0, Math.floor(clock() - started))); }
        catch { /* Logging must not alter upstream behavior. */ }
      }
      throw error;
    }
  };
}
