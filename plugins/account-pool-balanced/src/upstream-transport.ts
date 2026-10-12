import { EnvHttpProxyAgent,buildConnector } from "undici";

export function createUpstreamTransport() {
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false });
  const proxyEndpoints=['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'].map(key=>process.env[key]).filter((v):v is string=>!!v);
  const ipv4Tls={family:4} as Parameters<typeof buildConnector>[0];
  const ipv4Dispatcher=new EnvHttpProxyAgent({allowH2:false,connect:{family:4},proxyTls:ipv4Tls,requestTls:ipv4Tls});
  const ipv4Fetch:typeof fetch=(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    for(const proxy of proxyEndpoints){
      if(new URL(proxy).hostname.includes(':'))throw new Error('IPv6 proxy endpoints are not covered by VPN IPv4 evidence.');
    }
    if(url.hostname.includes(':')) throw new Error('IPv6 literals are not covered by VPN IPv4 evidence.');
    return fetch(input,{...init,dispatcher:ipv4Dispatcher} as RequestInit);
  };
  const upstreamFetch: typeof fetch = (input, init) => {
    const options = { ...init, dispatcher };
    return fetch(input, options);
  };
  return {
    fetch: upstreamFetch,fetchIpv4:ipv4Fetch,
    destroy: async () => {await Promise.all([dispatcher.destroy(),ipv4Dispatcher.destroy()]);},
  };
}

const TRANSPORT_CODES = new Set([
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_GOAWAY_SESSION",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

export function transportErrorCode(error: unknown): string {
  let cause = error;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      TRANSPORT_CODES.has(cause.code)
    ) {
      return cause.code;
    }
    cause = cause.cause;
  }
  return "unclassified transport error";
}
