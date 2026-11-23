import { poolErrorResponse } from "./pool-errors.js";
import type { Account, AccountQuota, AccountSecret, PoolProvider } from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  filterRequestHeaders,
  mountedUpstreamUrl,
  oauthSecretDueForRefresh,
  OAuthRefreshRejectedError,
} from "./provider-adapter.js";
import { isQuotaRejection, modelFamily, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";
import { refreshGrokAccess, GROK_CHAT_PROXY_BASE_URL } from "./grok-oauth.js";

export const GROK_MOUNT_PREFIX = "grok/";
const GROK_UPSTREAM_MOUNT_PREFIX = `${GROK_MOUNT_PREFIX}v1/`;
const GROK_REQUEST_HEADERS = new Set(["x-grok-model-override", "x-grok-client-identifier", "x-grok-client-name", "x-grok-client-version"]);

export function createGrokAdapter(): ProviderAdapter {
  return {
    provider: "grok" as PoolProvider,
    upstreamName: "Grok",
    async importAccount() {
      throw new Error("Use Grok sign-in from the Pool settings or add an xAI API key.");
    },
    parseRequest(body) {
      const parsed = parseRequestBody(body);
      return {
        model: parsed.model,
        family: modelFamily(null),
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: () => body,
      };
    },
    upstreamUrl(request, settings, _body?: Uint8Array, _account?: Account, secret?: AccountSecret) {
      const baseUrl = secret?.kind === "oauth"
        ? GROK_CHAT_PROXY_BASE_URL
        : settings.grokUpstreamBaseUrl;
      return mountedUpstreamUrl(request, baseUrl, GROK_UPSTREAM_MOUNT_PREFIX);
    },
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(inbound, new Set(["accept", "content-type", "user-agent"]), [
        "x-stainless-",
      ]);
      for (const name of GROK_REQUEST_HEADERS) {
        const value = inbound.get(name);
        if (value !== null) headers.set(name, value);
      }
      if (secret.kind === "oauth") {
        headers.set("authorization", `Bearer ${secret.accessToken}`);
        headers.set("x-xai-token-auth", "xai-grok-cli");
      } else {
        headers.set("authorization", `Bearer ${secret.apiKey}`);
      }
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      const due = oauthSecretDueForRefresh(context);
      if (due === null) return { secret: context.secret, refreshed: false };
      if (due.clientId === undefined) throw new OAuthRefreshRejectedError(401, "invalid_client");
      const secret = await refreshGrokAccess({
        fetch: context.fetch,
        now: context.now,
        secret: due,
      });
      await context.accounts.writeSecret(context.account.id, secret);
      return { secret, refreshed: true };
    },
    refreshesApiKeyUsage: false,
    async refreshUsage(_context) {},
    errorResponse(status, message, headers, request) {
      return poolErrorResponse("grok", status, message, headers, request);
    },
  };
}
