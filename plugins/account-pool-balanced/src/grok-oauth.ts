import { z } from "zod";
import type { AccountSecret } from "./contracts.js";
import { OAuthRefreshRejectedError } from "./provider-adapter.js";

export const GROK_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_REFRESH_URL = "https://auth.x.ai/oauth2/token";
export const GROK_SUBSCRIPTION_HEADER_PREFIXES = ["x-grok-", "x-xai-"] as const;

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
  })
  .passthrough();

export async function refreshGrokAccess(input: {
  fetch: typeof fetch;
  url: string;
  now: () => number;
  secret: Extract<AccountSecret, { kind: "oauth" }>;
}): Promise<Extract<AccountSecret, { kind: "oauth" }>> {
  if (input.secret.clientId === undefined) {
    throw new OAuthRefreshRejectedError(401, "invalid_client");
  }
  const response = await input.fetch(input.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.secret.refreshToken,
      client_id: input.secret.clientId,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new OAuthRefreshRejectedError(response.status, null);
  }
  const parsed = refreshResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new OAuthRefreshRejectedError(response.status, null);
  }
  return {
    kind: "oauth",
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? input.secret.refreshToken,
    expiresAt:
      parsed.data.expires_in === undefined
        ? input.secret.expiresAt
        : input.now() + parsed.data.expires_in * 1_000,
    ...(input.secret.idToken === undefined ? {} : { idToken: input.secret.idToken }),
    clientId: input.secret.clientId,
  };
}
