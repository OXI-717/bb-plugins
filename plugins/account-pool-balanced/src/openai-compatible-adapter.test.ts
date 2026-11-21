import { describe, expect, it, vi } from "vitest";
import { mountedUpstreamUrl } from "./provider-adapter.js";
import {
  createOpenAiCompatibleAdapter,
  isChatCompletionsBody,
  guardOpencodeGoRequestBody,
  normalizeOpencodeGoUpstreamPathSuffix,
  OPENCODE_GO_MOUNT_PREFIX,
  GROK_MOUNT_PREFIX,
  WIRE_PROTOCOL_REFUSAL_CODE,
  type OpenAiCompatibleAdapterOptions,
} from "./openai-compatible-adapter.js";
import { DEFAULT_ACCOUNT_POOL_CONFIG } from "./contracts.js";
import type { Account, AccountSecret } from "./contracts.js";

const CHAT_BODY = new TextEncoder().encode(
  JSON.stringify({ model: "mimo-v2.6-pro", messages: [{ role: "user", content: "hi" }] }),
);
const RESPONSES_BODY = new TextEncoder().encode(
  JSON.stringify({
    model: "mimo-v2.6-pro",
    input: "hi",
    instructions: "be brief",
  }),
);
const AMBIGUOUS_BOTH = new TextEncoder().encode(
  JSON.stringify({ model: "mimo-v2.6-pro", messages: [], input: [] }),
);
const EMPTY_BODY = new TextEncoder().encode(JSON.stringify({}));
const NON_JSON_BODY = new TextEncoder().encode("not json");

const OP_ENCODE_GO_OPTIONS: OpenAiCompatibleAdapterOptions = {
  provider: "opencode-go",
  upstreamName: "OpenCode Go",
  mountPrefix: OPENCODE_GO_MOUNT_PREFIX,
  upstreamBaseUrl: () => "https://opencode.example/zen/go/v1",
  usagesUrl: "https://usages.example/usage",
  parseUsages: () => null,
  normalizeUpstreamPathSuffix: normalizeOpencodeGoUpstreamPathSuffix,
  guardRequestBody: guardOpencodeGoRequestBody,
};

function mountedRequest(suffix: string, search = ""): Request {
  return new Request(
    `https://hub.example/api/v1/plugins/account-pool/http/opencode-go/v1/${suffix}${search}`,
    { method: "POST" },
  );
}

function chatRewrite(path: string): string {
  return normalizeOpencodeGoUpstreamPathSuffix(path);
}

describe("opencode-go upstream path suffix normalization", () => {
  it("U1: rewrites inbound responses to upstream chat/completions", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("responses"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/chat/completions");
  });

  it("U2: leaves native chat/completions unchanged (no double rewrite)", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("chat/completions"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/chat/completions");
  });

  it("U3: leaves models unchanged", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("models"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/models");
  });

  it("U4: does not broadly rewrite responses/foo (exact match only)", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("responses/foo"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/responses/foo");
  });

  it("U5: does not rewrite Responses (case sensitive)", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("Responses"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/Responses");
  });

  it("U6: preserves the query string across the rewrite", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("responses", "?stream=true&a=1&b=2"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe(
      "https://opencode.example/zen/go/v1/chat/completions?stream=true&a=1&b=2",
    );
  });

  it("normalizeOpencodeGoUpstreamPathSuffix is identity outside responses", () => {
    expect(chatRewrite("chat/completions")).toBe("chat/completions");
    expect(chatRewrite("models")).toBe("models");
    expect(chatRewrite("")).toBe("");
    expect(chatRewrite("responses/v2")).toBe("responses/v2");
  });
});

describe("isChatCompletionsBody (fail closed)", () => {
  it("U7: accepts a messages[] body", () => {
    expect(isChatCompletionsBody(CHAT_BODY)).toBe(true);
  });

  it("U8: rejects a Responses body (input/instructions)", () => {
    expect(isChatCompletionsBody(RESPONSES_BODY)).toBe(false);
  });

  it("U9: rejects an ambiguous body carrying both markers", () => {
    expect(isChatCompletionsBody(AMBIGUOUS_BOTH)).toBe(false);
  });

  it("U10: rejects empty object and non-JSON", () => {
    expect(isChatCompletionsBody(EMPTY_BODY)).toBe(false);
    expect(isChatCompletionsBody(NON_JSON_BODY)).toBe(false);
  });
});

describe("guardOpencodeGoRequestBody", () => {
  it("U11: allows a chat body on the rewritten responses suffix", () => {
    expect(guardOpencodeGoRequestBody("responses", CHAT_BODY)).toBeNull();
  });

  it("U12: refuses a Responses body on the rewritten responses suffix", () => {
    expect(guardOpencodeGoRequestBody("responses", RESPONSES_BODY)).not.toBeNull();
    expect(guardOpencodeGoRequestBody("responses", AMBIGUOUS_BOTH)).not.toBeNull();
  });

  it("U13: does not guard the native chat/completions suffix", () => {
    expect(guardOpencodeGoRequestBody("chat/completions", RESPONSES_BODY)).toBeNull();
    expect(guardOpencodeGoRequestBody("chat/completions", AMBIGUOUS_BOTH)).toBeNull();
    expect(guardOpencodeGoRequestBody("chat/completions", EMPTY_BODY)).toBeNull();
  });

  it("U14: does not guard the models suffix", () => {
    expect(guardOpencodeGoRequestBody("models", RESPONSES_BODY)).toBeNull();
    expect(guardOpencodeGoRequestBody("models", EMPTY_BODY)).toBeNull();
  });
});

describe("opencode-go adapter guardRequest wiring", () => {
  const secret: AccountSecret = { kind: "api-key", apiKey: "sk-go-subscription" };

  it("U15: returns a typed 400 unsupported_wire_protocol refusal and never forwards", async () => {
    const adapter = createOpenAiCompatibleAdapter(OP_ENCODE_GO_OPTIONS);
    const refusal = adapter.guardRequest?.(mountedRequest("responses"), RESPONSES_BODY);
    expect(refusal).toBeInstanceOf(Response);
    expect(refusal?.status).toBe(400);
    const payload = (await refusal?.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(payload.error.code).toBe(WIRE_PROTOCOL_REFUSAL_CODE);
    expect(payload.error.type).toBe("invalid_request_error");
    expect(payload.error.message).toContain("chat/completions");
  });

  it("U16: allows chat-completions body on responses and returns null", () => {
    const adapter = createOpenAiCompatibleAdapter(OP_ENCODE_GO_OPTIONS);
    expect(
      adapter.guardRequest?.(mountedRequest("responses"), CHAT_BODY),
    ).toBeNull();
  });

  it("U17: applies the rewrite in upstreamUrl for opencode-go only", () => {
    const adapter = createOpenAiCompatibleAdapter(OP_ENCODE_GO_OPTIONS);
    const settings = {
      ...DEFAULT_ACCOUNT_POOL_CONFIG,
      opencodeGoUpstreamBaseUrl: "https://opencode.example/zen/go/v1",
    };
    expect(
      adapter.upstreamUrl(mountedRequest("responses"), settings).toString(),
    ).toBe("https://opencode.example/zen/go/v1/chat/completions");
    expect(
      adapter.upstreamUrl(mountedRequest("chat/completions"), settings).toString(),
    ).toBe("https://opencode.example/zen/go/v1/chat/completions");
    void secret;
  });

  it("U18: zai adapter leaves /responses untouched and implements no guard", () => {
    const zai = createOpenAiCompatibleAdapter({
      provider: "zai",
      upstreamName: "Z.ai Coding Plan",
      mountPrefix: "zai/",
      upstreamBaseUrl: () => "https://api.z.example/api/coding/paas/v4",
      usagesUrl: "https://usages.example/zai",
      parseUsages: () => null,
    });
    expect(zai.guardRequest).toBeUndefined();
    const settings = {
      ...DEFAULT_ACCOUNT_POOL_CONFIG,
      zaiUpstreamBaseUrl: "https://api.z.example/api/coding/paas/v4",
    };
    const request = new Request(
      "https://hub.example/api/v1/plugins/account-pool/http/zai/v1/responses",
      { method: "POST" },
    );
    expect(zai.upstreamUrl(request, settings).toString()).toBe(
      "https://api.z.example/api/coding/paas/v4/responses",
    );
  });
});

describe("grok adapter", () => {
  const adapter = createOpenAiCompatibleAdapter({
    provider: "grok",
    upstreamName: "xAI",
    mountPrefix: GROK_MOUNT_PREFIX,
    upstreamBaseUrl: (settings) => settings.grokUpstreamBaseUrl,
    usagesUrl: "https://api.x.ai/v1/models",
    collectUsage: false,
    parseUsages: () => null,
  });

  it("does not collect usage", async () => {
    const calls = { fetch: 0, fresh: 0 };
    const fetch = (() => {
      calls.fetch += 1;
      throw new Error("fetch called");
    }) as typeof globalThis.fetch;
    const freshSecret = () => {
      calls.fresh += 1;
      throw new Error("freshSecret called");
    };
    await adapter.refreshUsage({
      account: null as unknown as Account,
      freshSecret,
      accounts: null as never,
      quotas: null as never,
      fetch,
      now: () => 0,
    });
    expect(calls).toEqual({ fetch: 0, fresh: 0 });
  });

  it("forwards chat completions to the xAI v1 path", () => {
    const request = new Request(
      "https://hub.example/api/v1/plugins/account-pool/http/grok/v1/chat/completions",
      { method: "POST" },
    );
    expect(
      adapter.upstreamUrl(request, DEFAULT_ACCOUNT_POOL_CONFIG).toString(),
    ).toBe("https://api.x.ai/v1/chat/completions");
  });

  it("replaces the inbound hub token with the stored API key", () => {
    const headers = adapter.requestHeaders(
      new Headers({ authorization: "Bearer hub-token", accept: "application/json" }),
      null as unknown as Account,
      { kind: "api-key", apiKey: "sk-stored" },
    );
    expect(headers.get("authorization")).toBe("Bearer sk-stored");
  });

  it("refuses local import", async () => {
    await expect(adapter.importAccount()).rejects.toThrow("--api-key-stdin");
  });

  it("sends the literal xai token auth header and reads billing credits", async () => {
    const subscribed = createOpenAiCompatibleAdapter({
      provider: "grok",
      upstreamName: "xAI",
      mountPrefix: GROK_MOUNT_PREFIX,
      upstreamBaseUrl: (settings) => settings.grokUpstreamBaseUrl,
      usagesUrl: "https://api.x.ai/v1/models",
      collectUsage: true,
      subscription: {
        upstreamBaseUrl: "https://cli-chat-proxy.grok.com/v1",
        refreshUrl: "https://auth.example/oauth2/token",
      },
      parseUsages: () => null,
    });
    const oauth = {
      kind: "oauth" as const,
      accessToken: "next-access",
      refreshToken: "refresh",
      expiresAt: 1,
      clientId: "client",
    };
    const kept = subscribed.requestHeaders(
      new Headers({ authorization: "Bearer hub", "x-xai-token-auth": "kept" }),
      null as unknown as Account,
      oauth,
    );
    expect(kept.get("authorization")).toBe("Bearer next-access");
    expect(kept.get("x-xai-token-auth")).toBe("kept");
    expect(subscribed.requestHeaders(new Headers(), null as unknown as Account, oauth).get("x-xai-token-auth"))
      .toBe("xai-grok-cli");
    const stored: { quota: { sevenDayUtilization: number | null } | null } = { quota: null };
    const fetch = vi.fn(async (url: string) => {
      void url;
      return Response.json({
        config: { creditUsagePercent: 10, billingPeriodEnd: "2026-11-11T15:08:57.657Z" },
      });
    });
    await subscribed.refreshUsage({
      account: { id: "11111111-1111-4111-8111-111111111111" } as Account,
      freshSecret: async () => oauth,
      accounts: null as never,
      quotas: {
        get: () => ({
          accountId: "11111111-1111-4111-8111-111111111111",
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
        }),
        put: (quota: { sevenDayUtilization: number | null }) => { stored.quota = quota; },
      } as unknown as import("./store.js").QuotaStore,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 10,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(stored.quota?.sevenDayUtilization).toBe(0.1);
  });
});
