import { z } from "zod";
import type { AccountSecret } from "./contracts.js";
import { OAuthRefreshRejectedError, TransientOAuthRefreshError } from "./provider-adapter.js";

export const GROK_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_REFRESH_URL = "https://auth.x.ai/oauth2/token";

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
  })
  .passthrough();

export async function refreshGrokAccess(input: {
  fetch: typeof fetch;
  now: () => number;
  secret: Extract<AccountSecret, { kind: "oauth" }>;
}): Promise<Extract<AccountSecret, { kind: "oauth" }>> {
  if (input.secret.clientId === undefined) {
    throw new OAuthRefreshRejectedError(401, "invalid_client");
  }
  const response = await input.fetch(GROK_REFRESH_URL, {
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
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new TransientOAuthRefreshError(
        `Grok token endpoint responded ${response.status}.`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 0,
      );
    }
    throw new OAuthRefreshRejectedError(response.status, null);
  }
  const parsed = refreshResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429 || response.status >= 500) {
      throw new TransientOAuthRefreshError(
        `Grok token endpoint responded ${response.status} with an unparsable body.`,
        0,
      );
    }
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
    ...(input.secret.idToken === undefined
      ? {}
      : { idToken: input.secret.idToken }),
    clientId: input.secret.clientId,
  };
}
