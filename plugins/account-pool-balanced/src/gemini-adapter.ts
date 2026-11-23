import {geminiSummaryWindows, geminiUsageObservation, type GeminiSummaryDiagnostic} from './gemini-usage.js';
import {managedProject, raceAbort, readAgyJson} from './agy-oauth-login.js';
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

// Protocol signature used by the Antigravity CLI for its /usage summary.
const summaryArchitecture = process.arch === "x64" ? "amd64" : process.arch;
const summaryUserAgent = `antigravity/cli/1.5.0 (aidev_client; os_type=${process.platform}; arch=${summaryArchitecture}; cl=1013440158; auth_method=consumer)`;

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
    upstreamUrl(request, settings, _body, _account, secret) {
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
        throw new Error(`Gemini quota refresh failed with HTTP ${response.status}.`);
      }
      const payload: unknown = await response.json().catch(() => null);
      const quota = geminiQuotaFromUsages(
        context.account.id,
        payload,
        context.quotas.get(context.account.id),
        context.now(),
      );
      if (quota === null) throw new Error("Gemini quota refresh returned no valid measurement.");
      if (quota !== null) {
        context.quotas.put(quota);
        // Optional display metadata never invalidates a valid quota observation.
        let enrichment: Record<string, unknown> = {};
        const diagnostic: GeminiSummaryDiagnostic = {
          enrichment: "request-failed", enrichmentHttpStatus: null,
          summary: "not-requested", summaryHttpStatus: null, weeklyStored: false,
        };
        try {
          const auxiliary = await context.fetch(`${options.cloudCodeBaseUrl.replace(/\/+$/u, '')}/v1internal:loadCodeAssist`, {
            method: 'POST', headers: {authorization: `Bearer ${secret.accessToken}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': GEMINI_USER_AGENT},
            body: JSON.stringify({metadata: {ideType: "ANTIGRAVITY"}}), signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
          });
          diagnostic.enrichmentHttpStatus = auxiliary.status;
          diagnostic.enrichment = auxiliary.ok ? "body-invalid" : "http-error";
          if (auxiliary.ok) {
            enrichment = await readAgyJson(auxiliary, AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS));
            diagnostic.enrichment = "project-missing";
          } else await auxiliary.body?.cancel();
        } catch { /* Quota remains valid when optional enrichment is unavailable. */ }
        const usage = geminiUsageObservation(payload, enrichment, context.now());
        const project = managedProject(enrichment);
        if (project !== null) {
          diagnostic.enrichment = "project-present";
          diagnostic.summary = "request-failed";
          const signal = AbortSignal.timeout(10_000);
          try {
            const response = await raceAbort(context.fetch(
              `${options.cloudCodeBaseUrl.replace(/\/+$/u, '')}/v1internal:retrieveUserQuotaSummary`,
              {
                method: "POST", redirect: "error", signal,
                headers: { authorization: `Bearer ${secret.accessToken}`, "content-type": "application/json", "user-agent": summaryUserAgent },
                body: JSON.stringify({ project }),
              },
            ), signal);
            diagnostic.summaryHttpStatus = response.status;
            diagnostic.summary = response.ok ? "body-invalid" : "http-error";
            if (response.ok) {
              const windows = geminiSummaryWindows(await readAgyJson(response, signal), result => {
                diagnostic.summary = result;
              });
              if (windows.length > 0) usage.windows = windows;
            } else void response.body?.cancel().catch(() => undefined);
          } catch { /* The summary is optional and cannot invalidate model usage. */ }
        }
        try {
          const saved = await context.accounts.setGeminiUsage(context.account.id, usage);
          diagnostic.weeklyStored = saved?.geminiUsage?.windows?.some(window => window.kind === "weekly") === true;
        } finally {
          context.geminiSummaryDiagnostic?.(diagnostic);
        }
      }
    },
    errorResponse(status, message, headers, request) {
      return poolErrorResponse("gemini", status, message, headers, request);
    },
  };
}
