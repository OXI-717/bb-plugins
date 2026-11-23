import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_POOL_CONFIG, type Account, type AccountQuota } from "./contracts.js";
import { createGeminiAdapter, GEMINI_USAGE_REQUEST_TIMEOUT_MS } from "./gemini-adapter.js";
import { GEMINI_OAUTH_CLIENT_ID, GEMINI_USER_AGENT } from "./gemini-oauth.js";
import type { QuotaStore } from "./store.js";

const account = { id: "11111111-1111-4111-8111-111111111111" } as Account;
const oauth = {
  kind: "oauth" as const,
  accessToken: "google-access",
  refreshToken: "refresh",
  expiresAt: 1,
  clientId: GEMINI_OAUTH_CLIENT_ID,
};

function previous(): AccountQuota {
  return {
    accountId: account.id,
    fiveHourUtilization: 0.2,
    fiveHourResetAt: 5,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: { fable: null, sonnet: null, opus: null, haiku: null, other: null },
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
  };
}

function adapter() {
  return createGeminiAdapter({
    cloudCodeBaseUrl: "https://daily-cloudcode-pa.googleapis.com",
    apiBaseUrl: (settings) => settings.geminiUpstreamBaseUrl,
    refreshUrl: "https://oauth2.googleapis.com/token",
    clientSecret: "fake-secret",
  });
}

describe("gemini adapter", () => {
  it("keeps the colon path and the query on the cloud code host", () => {
    const request = new Request(
      "https://hub.example/api/v1/plugins/account-pool/http/gemini/v1internal:streamGenerateContent?alt=sse",
      { method: "POST" },
    );
    expect(adapter().upstreamUrl(request, {
      ...DEFAULT_ACCOUNT_POOL_CONFIG,
      geminiUpstreamBaseUrl: "https://generativelanguage.googleapis.com",
    }, undefined, account, oauth).toString()).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
  });

  it("sends an API key to the generative language host", () => {
    const request = new Request(
      "https://hub.example/gemini/v1internal:generateContent",
      { method: "POST" },
    );
    const settings = {
      ...DEFAULT_ACCOUNT_POOL_CONFIG,
      geminiUpstreamBaseUrl: "https://generativelanguage.googleapis.com",
    };
    expect(adapter().upstreamUrl(request, settings, undefined, account, { kind: "api-key", apiKey: "stored-key" }).origin)
      .toBe("https://generativelanguage.googleapis.com");
    const headers = adapter().requestHeaders(
      new Headers({ authorization: "Bearer hub-token" }),
      account,
      { kind: "api-key", apiKey: "stored-key" },
    );
    expect(headers.get("authorization")).toBe("Bearer stored-key");
    expect(headers.get("x-goog-api-key")).toBe("stored-key");
    expect(headers.get("user-agent")).toBe(GEMINI_USER_AGENT);
  });

  it("keeps an inbound user agent and collects the busiest bucket", async () => {
    const headers = adapter().requestHeaders(
      new Headers({ "user-agent": "antigravity/test" }),
      account,
      oauth,
    );
    expect(headers.get("authorization")).toBe("Bearer google-access");
    expect(headers.get("user-agent")).toBe("antigravity/test");
    const calls: string[] = [];
    const stored: { quota: AccountQuota | null } = { quota: null };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (calls.length === 1) return new Response("no", { status: 401 });
      return Response.json({
        buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.25, resetTime: "2026-11-04T21:01:05Z" }],
      });
    });
    await adapter().refreshUsage({
      account,
      freshSecret: async (rejected) => {
        expect(rejected === undefined || rejected === "google-access").toBe(true);
        return rejected === undefined ? oauth : { ...oauth, accessToken: "fresh-access" };
      },
      accounts: {setGeminiUsage: vi.fn()} as never,
      quotas: { get: () => previous(), put: (quota: AccountQuota) => { stored.quota = quota; } } as unknown as QuotaStore,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 10,
    });
    expect(calls[1]).toContain("/v1internal:retrieveUserQuota");
    expect(stored.quota?.fiveHourUtilization).toBe(0.75);
  });

  it("does not collect usage for an API key", async () => {
    const fetch = vi.fn();
    await adapter().refreshUsage({
      account,
      freshSecret: async () => ({ kind: "api-key", apiKey: "stored-key" }),
      accounts: null as never,
      quotas: null as never,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(adapter().refreshesApiKeyUsage).toBe(false);
    expect(GEMINI_USAGE_REQUEST_TIMEOUT_MS).toBe(20_000);
  });
});

describe('Gemini optional enrichment',()=>{
 it.each(['success','403','network','invalid-json'] as const)('keeps quota valid with auxiliary %s',async mode=>{
  const put=vi.fn();const setGeminiUsage=vi.fn();
  const fetch=vi.fn(async(input:unknown)=>{
   if(String(input).endsWith(':retrieveUserQuota'))return Response.json({buckets:[{modelId:'gemini-fixture',remainingFraction:0.5}]});
   if(mode==='network')throw Error('synthetic network failure');
   if(mode==='403')return new Response(null,{status:403});
   if(mode==='invalid-json')return new Response('invalid');
   return Response.json({paidTier:{id:'fixture-tier',name:'Fixture plan',availableCredits:[{creditType:'GOOGLE_ONE_AI',creditAmount:'12'}]}});
  });
  await adapter().refreshUsage({account,freshSecret:async()=>oauth,accounts:{setGeminiUsage} as never,quotas:{get:previous,put} as never,fetch:fetch as never,now:()=>100});
  expect(put).toHaveBeenCalledOnce();expect(put.mock.calls[0]?.[0].fiveHourUtilization).toBe(0.5);
  expect(setGeminiUsage).toHaveBeenCalledOnce();expect(setGeminiUsage.mock.calls[0]?.[1].models[0].usedPercent).toBe(50);
  expect(setGeminiUsage.mock.calls[0]?.[1].credits).toBe(mode==='success'?'12':null);
 });
 it('does not enrich or write metadata after rejected quota',async()=>{
  const fetch=vi.fn(async()=>new Response(null,{status:403}));const setGeminiUsage=vi.fn();const put=vi.fn();
  await expect(adapter().refreshUsage({account,freshSecret:async()=>oauth,accounts:{setGeminiUsage} as never,quotas:{get:previous,put} as never,fetch:fetch as never,now:()=>100})).rejects.toThrow('HTTP 403');
  expect(fetch).toHaveBeenCalledOnce();expect(setGeminiUsage).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
 });
});

it.each([200, 403])('collects a declared Gemini quota summary or preserves short usage on HTTP %i', async status => {
  const setGeminiUsage = vi.fn();
  const put = vi.fn();
  const resetTime = '2030-01-02T00:00:00Z';
  const fetch = vi.fn(async (input: unknown) => {
    if (String(input).endsWith(':retrieveUserQuota')) {
      return Response.json({ buckets: [{ modelId: 'gemini-fixture', remainingFraction: 0.8 }] });
    }
    if (String(input).endsWith(':loadCodeAssist')) {
      return Response.json({ cloudaicompanionProject: { id: 'fixture-project' } });
    }
    if (status === 403) return new Response(null, { status });
    return Response.json({ response: { groups: [{ buckets: [
      { bucketId: 'gemini-5h', remainingFraction: 0.75, resetTime },
      { bucketId: 'gemini-weekly', remainingFraction: 0.5 },
    ] }] } });
  });
  await adapter().refreshUsage({ account, freshSecret: async () => oauth,
    accounts: { setGeminiUsage } as never, quotas: { get: previous, put } as never,
    fetch: fetch as never, now: () => 100 });
  expect(fetch.mock.calls.map(([url]) => String(url).split(':').at(-1))).toEqual([
    'retrieveUserQuota', 'loadCodeAssist', 'retrieveUserQuotaSummary',
  ]);
  expect(setGeminiUsage.mock.calls[0]?.[1].windows).toEqual(status === 403 ? undefined : [
    { kind: 'five-hour', usedPercent: 25, resetAt: Date.parse(resetTime) },
    { kind: 'weekly', usedPercent: 50, resetAt: null },
  ]);
  expect(put.mock.calls[0]?.[0].sevenDayUtilization).toBe(previous().sevenDayUtilization);
});
