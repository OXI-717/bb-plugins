import type {
  AccountPoolConfig,
  AccountSecret,
} from "./contracts.js";
import { geminiQuotaFromUsages } from "./openai-compatible-usage.js";
import type { GeminiSubscriptionCredentials } from "./gemini-credentials.js";
import {
  absoluteUpstreamUrl,
  GEMINI_USER_AGENT,
  refreshGeminiAccess,
} from "./gemini-oauth.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  filterRequestHeaders,
  mountedPathSuffix,
  oauthSecretDueForRefresh,
} from "./provider-adapter.js";
import { isQuotaRejection, modelFamily, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";
import { poolErrorResponse } from "./pool-errors.js";

export const GEMINI_MOUNT_PREFIX = "gemini/";
export const GEMINI_ROUTE_SUFFIXES = [
  "v1internal:loadCodeAssist",
  "v1internal:fetchAvailableModels",
  "v1internal:streamGenerateContent",
  "v1internal:generateContent",
  "v1internal:retrieveUserQuota",
] as const;

export const GEMINI_USAGE_REQUEST_TIMEOUT_MS = 20_000;
const USAGE_REQUEST_TIMEOUT_MS = GEMINI_USAGE_REQUEST_TIMEOUT_MS;
const ALLOWED_REQUEST_HEADERS = new Set(["accept", "content-type", "user-agent"]);

export interface GeminiAdapterOptions {
  cloudCodeBaseUrl: string;
  apiBaseUrl: (settings: AccountPoolConfig) => string;
  refreshUrl: string;
  usagesUrl?: string;
  clientSecret: string | (() => Promise<string>);
  importCredentials?: () => Promise<GeminiSubscriptionCredentials>;
}

export function createGeminiAdapter(options: GeminiAdapterOptions): ProviderAdapter {
  const usageUrl = (base: string) =>
    options.usagesUrl ?? `${base.replace(/\/+$/u, "")}/v1internal:retrieveUserQuota`;
  return {
    provider: "gemini",
    upstreamName: "Gemini",
    async importAccount() {
      const read = options.importCredentials;
      if (read === undefined) {
        throw new Error(
          "Gemini accounts carry no local login to import; add them with --api-key-stdin.",
        );
      }
      const imported = await read();
      return {
        label: imported.label,
        email: imported.email,
        subscriptionType: null,
        rateLimitTier: null,
        secret: {
          kind: "oauth" as const,
          accessToken: imported.accessToken,
          refreshToken: imported.refreshToken,
          expiresAt: imported.expiresAt,
          clientId: imported.clientId,
        },
      };
    },
    parseRequest(body) {
      const parsed = parseRequestBody(body);
      return {
        family: modelFamily(null),
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: () => body,
      };
    },
    upstreamUrl(request, settings, _account, secret) {
      const suffix = mountedPathSuffix(request, GEMINI_MOUNT_PREFIX);
      const base = secret?.kind === "api-key"
        ? options.apiBaseUrl(settings)
        : options.cloudCodeBaseUrl;
      return absoluteUpstreamUrl(base, suffix, new URL(request.url).search);
    },
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(inbound, ALLOWED_REQUEST_HEADERS, ["x-goog-"]);
      const userAgent = inbound.get("user-agent");
      headers.set(
        "user-agent",
        userAgent !== null && userAgent.trim() !== "" ? userAgent : GEMINI_USER_AGENT,
      );
      if (secret.kind === "oauth") {
        headers.set("authorization", `Bearer ${secret.accessToken}`);
        return headers;
      }
      headers.set("authorization", `Bearer ${secret.apiKey}`);
      headers.set("x-goog-api-key", secret.apiKey);
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      const due = oauthSecretDueForRefresh(context);
      if (due === null) return { secret: context.secret, refreshed: false };
      const secret: AccountSecret = await refreshGeminiAccess({
        fetch: context.fetch,
        url: options.refreshUrl,
        now: context.now,
        secret: due,
        clientSecret: options.clientSecret,
      });
      await context.accounts.writeSecret(context.account.id, secret);
      return { secret, refreshed: true };
    },
    refreshesApiKeyUsage: false,
    async refreshUsage(context) {
      let secret = await context.freshSecret();
      if (secret.kind !== "oauth") return;
      const url = usageUrl(options.cloudCodeBaseUrl);
      const load = (accessToken: string) => context.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": GEMINI_USER_AGENT,
        },
        body: "{}",
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      let response = await load(secret.accessToken);
      if (response.status === 401) {
        await response.body?.cancel();
        const fresh = await context.freshSecret(secret.accessToken);
        if (fresh.kind !== "oauth") return;
        secret = fresh;
        response = await load(secret.accessToken);
      }
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      const quota = geminiQuotaFromUsages(
        context.account.id,
        payload,
        context.quotas.get(context.account.id),
        context.now(),
      );
      if (quota !== null) context.quotas.put(quota);
    },
    errorResponse(status, message, headers, request) {
      return poolErrorResponse("gemini", status, message, headers, request);
    },
  };
}
