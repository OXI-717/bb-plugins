import { describe, expect, it, vi } from "vitest";
import { accountPoolConfigSchema, type Account, type AccountSecret } from "./contracts.js";
import { createGrokAdapter } from "./grok-adapter.js";

const account = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "grok",
  kind: "oauth",
  label: "Grok fixture",
  email: null,
  accountUuid: null,
  subscriptionType: null,
  rateLimitTier: null,
  enabled: true,
  priority: 100,
} as Account;

const oauth: AccountSecret = {
  kind: "oauth",
  accessToken: "synthetic-access-token",
  refreshToken: "synthetic-refresh-token",
  expiresAt: 1,
  clientId: "synthetic-client-id",
};

const request = () => new Request("https://pool.test/grok/v1/responses", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-grok-model-override": "grok-build",
    "x-unrelated-header": "drop-me",
  },
  body: JSON.stringify({ model: "grok-build", input: "fixture" }),
});

describe("Grok adapter", () => {
  it("routes OAuth accounts through the CLI proxy and keeps OAuth upstream-only", () => {
    const adapter = createGrokAdapter();
    const config = accountPoolConfigSchema.parse({});
    const url = adapter.upstreamUrl(request(), config, undefined, account, oauth);
    const headers = adapter.requestHeaders(request().headers, account, oauth);
    expect(url.toString()).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(headers.get("authorization")).toBe("Bearer synthetic-access-token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-model-override")).toBe("grok-build");
    expect(headers.has("x-unrelated-header")).toBe(false);
  });

  it("routes API-key accounts to the configured xAI endpoint", () => {
    const adapter = createGrokAdapter();
    const config = accountPoolConfigSchema.parse({ grokUpstreamBaseUrl: "https://api.example/v1" });
    const apiKey: AccountSecret = { kind: "api-key", apiKey: "synthetic-xai-key" };
    expect(adapter.upstreamUrl(request(), config, undefined, account, apiKey).toString()).toBe(
      "https://api.example/v1/responses",
    );
    const headers = adapter.requestHeaders(request().headers, account, apiKey);
    expect(headers.get("authorization")).toBe("Bearer synthetic-xai-key");
    expect(headers.has("x-xai-token-auth")).toBe(false);
  });

  it("refreshes OAuth credentials with the stored public client id", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("client_id=synthetic-client-id");
      return Response.json({ access_token: "synthetic-next-access", expires_in: 3600 });
    });
    const writeSecret = vi.fn();
    const adapter = createGrokAdapter();
    const refreshed = await adapter.refreshSecret({
      account,
      secret: oauth,
      accounts: { writeSecret } as never,
      quotas: {} as never,
      fetch,
      now: () => 2_000,
      forceRefresh: true,
    });
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.secret).toMatchObject({
      kind: "oauth",
      accessToken: "synthetic-next-access",
      refreshToken: "synthetic-refresh-token",
      clientId: "synthetic-client-id",
    });
    expect(writeSecret).toHaveBeenCalledWith(account.id, refreshed.secret);
  });
});
