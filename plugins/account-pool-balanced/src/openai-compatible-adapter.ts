import { describeTransportError } from "./transport-diagnostics.js";
import { poolErrorResponse } from "./pool-errors.js";
import { apiKeyFailure } from "./api-key-errors.js";
import type {
  AccountPoolConfig,
  AccountQuota,
  AccountSecret,
  PoolProvider,
} from "./contracts.js";
import type { GrokSubscriptionCredentials } from "./grok-credentials.js";
import {
  GROK_SUBSCRIPTION_HEADER_PREFIXES,
  refreshGrokAccess,
} from "./grok-oauth.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  filterRequestHeaders,
  mountedPathSuffix,
  mountedUpstreamUrl,
  oauthSecretDueForRefresh,
} from "./provider-adapter.js";
import { isQuotaRejection, modelFamily, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";
import { grokQuotaFromUsages, zaiUsageRejected, zaiUsageShape, zaiSubscriptionType } from "./openai-compatible-usage.js";

export const ZAI_MOUNT_PREFIX = "zai/";
export const OPENCODE_GO_MOUNT_PREFIX = "opencode-go/";
export const GROK_MOUNT_PREFIX = "grok/";

export const WIRE_PROTOCOL_REFUSAL_CODE = "unsupported_wire_protocol";

const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
]);
const SUBSCRIPTION_REQUEST_HEADERS = new Set([
  ...ALLOWED_REQUEST_HEADERS,
  "traceparent",
  "x-email",
  "x-userid",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["x-stainless-"];

export interface OpenAiSubscriptionOptions {
  upstreamBaseUrl: string;
  refreshUrl: string;
  usagesUrl?: string;
  importCredentials?: () => Promise<GrokSubscriptionCredentials>;
}

export function isChatCompletionsBody(body: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.messages)) return false;
    if ("input" in record || "instructions" in record) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeOpencodeGoUpstreamPathSuffix(suffix: string): string {
  return suffix === "responses" ? "chat/completions" : suffix;
}

export function wireProtocolRefusalResponse(message: string): Response {
  return Response.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        code: WIRE_PROTOCOL_REFUSAL_CODE,
      },
    },
    { status: 400 },
  );
}

export function guardOpencodeGoRequestBody(
  suffix: string,
  body: Uint8Array,
): string | null {
  if (suffix !== "responses") return null;
  if (isChatCompletionsBody(body)) return null;
  return (
    "OpenCode Go serves this model on POST /v1/chat/completions (Chat " +
    "Completions, messages[]). The inbound /responses body is not " +
    "Chat Completions shaped (missing messages[], or carrying Responses " +
    "input/instructions). Path normalization cannot bridge the protocol " +
    "gap and no request-body conversion is performed. Configure the " +
    "client to the Chat Completions wire for this model, or add an " +
    "explicit Responses-to-Chat-Completions bridge. " +
    `(${WIRE_PROTOCOL_REFUSAL_CODE})`
  );
}

export interface OpenAiCompatibleAdapterOptions {
  provider: PoolProvider;
  upstreamName: string;
  mountPrefix: string;
  upstreamBaseUrl: (settings: AccountPoolConfig) => string;
  usagesUrl: string;
  allowedHeaderPrefixes?: readonly string[];
  normalizeUpstreamPathSuffix?: (upstreamPath: string) => string;
  guardRequestBody?: (suffix: string, body: Uint8Array) => string | null;
  collectUsage?: boolean;
  subscription?: OpenAiSubscriptionOptions;
  parseUsages: (
    accountId: string,
    payload: unknown,
    previous: AccountQuota,
    now: number,
  ) => AccountQuota | null;
}

export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleAdapterOptions,
): ProviderAdapter {
  return {
    provider: options.provider,
    upstreamName: options.upstreamName,
    async importAccount() {
      const read = options.subscription?.importCredentials;
      if (read === undefined) {
        throw new Error(
          `${options.upstreamName} accounts carry no local login to import; add them with --api-key-stdin.`,
        );
      }
      const imported = await read();
      return {
        label: imported.label,
        email: imported.email,
        subscriptionType: null,
        rateLimitTier: null,
        secret: {
          kind: "oauth",
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
        model: parsed.model,
        family: modelFamily(null),
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: () => body,
      };
    },
    upstreamUrl: (request, settings, _account, secret) =>
      mountedUpstreamUrl(
        request,
        secret?.kind === "oauth" && options.subscription !== undefined
          ? options.subscription.upstreamBaseUrl
          : options.upstreamBaseUrl(settings),
        `${options.mountPrefix}v1/`,
        options.normalizeUpstreamPathSuffix,
      ),
    guardRequest: options.guardRequestBody
      ? (request, body) => {
          const suffix = mountedPathSuffix(
            request,
            `${options.mountPrefix}v1/`,
          );
          const message = options.guardRequestBody?.(suffix, body);
          return message === null || message === undefined
            ? null
            : wireProtocolRefusalResponse(message);
        }
      : undefined,
    requestHeaders(inbound, _account, secret) {
      if (secret.kind === "oauth" && options.subscription !== undefined) {
        const headers = filterRequestHeaders(
          inbound,
          SUBSCRIPTION_REQUEST_HEADERS,
          [
            ...ALLOWED_REQUEST_HEADER_PREFIXES,
            ...GROK_SUBSCRIPTION_HEADER_PREFIXES,
            ...(options.allowedHeaderPrefixes ?? []),
          ],
        );
        headers.set("authorization", `Bearer ${secret.accessToken}`);
        const presented = inbound.get("x-xai-token-auth");
        headers.set(
          "x-xai-token-auth",
          presented !== null && presented.trim() !== "" ? presented : "xai-grok-cli",
        );
        return headers;
      }
      const headers = filterRequestHeaders(inbound, ALLOWED_REQUEST_HEADERS, [
        ...ALLOWED_REQUEST_HEADER_PREFIXES,
        ...(options.allowedHeaderPrefixes ?? []),
      ]);
      if (secret.kind !== "api-key") {
        throw new Error(
          `${options.upstreamName} accounts require an API key secret.`,
        );
      }
      headers.set("authorization", `Bearer ${secret.apiKey}`);
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      const due = oauthSecretDueForRefresh(context);
      if (due === null || options.subscription === undefined) {
        return { secret: context.secret, refreshed: false };
      }
      const secret: AccountSecret = await refreshGrokAccess({
        fetch: context.fetch,
        url: options.subscription.refreshUrl,
        now: context.now,
        secret: due,
      });
      await context.accounts.writeSecret(context.account.id, secret);
      return { secret, refreshed: true };
    },
    refreshesApiKeyUsage: options.collectUsage !== false && options.provider !== "grok",
    async refreshUsage(context) {
      if ((options.provider === "opencode-go" || options.provider === "neuraldeep") && context.quotas.get(context.account.id).providerBudgetEvidence !== undefined) {
        context.quotas.put({ ...context.quotas.get(context.account.id), providerBudgetEvidence: undefined });
      }
      if (options.provider === "grok") {
        if (options.subscription === undefined) return;
        let secret = await context.freshSecret();
        if (secret.kind !== "oauth") return;
        const base = options.subscription.upstreamBaseUrl.replace(/\/+$/u, "");
        const url = options.subscription.usagesUrl ?? `${base}/billing?format=credits`;
        const load = (accessToken: string) => context.fetch(url, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "x-xai-token-auth": "xai-grok-cli",
            "user-agent": "grok-cli/0.1.0",
            accept: "application/json",
          },
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
        const quota = grokQuotaFromUsages(
          context.account.id,
          payload,
          context.quotas.get(context.account.id),
          context.now(),
        );
        if (quota !== null) context.quotas.put(quota);
        return;
      }
      if (options.collectUsage === false) return;
      const zai = options.provider === "zai";
      const fail = (message: string): never => {
        // These messages are assembled only from constants and safe summaries.
        const error = `Z.AI quota collection failed: ${message}`;
        context.quotas.put({ ...context.quotas.get(context.account.id), error });
        throw new Error(error);
      };
      const secret = await context.freshSecret();
      if (secret.kind !== "api-key") {
        if (zai) fail("API key authorization is unavailable.");
        return;
      }
      const started = performance.now();
      const diagnostic = (error: unknown, boundary: "headers" | "body" | "parse") => {
        const { code, category } = describeTransportError(error);
        const phase = boundary === "headers" && ["dns", "connect", "tls", "headers"].includes(category)
          ? category : boundary;
        return `code=${code}; category=${category}; phase=${phase}; elapsedMs=${Math.max(0, Math.floor(performance.now() - started))}`;
      };
      const response = await context.fetch(options.usagesUrl, {
        headers: {
          authorization: `Bearer ${secret.apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      }).catch((error: unknown) => {
        if (zai) fail(`Network request did not complete; ${diagnostic(error, "headers")}.`);
        throw error;
      });
      if (!response.ok) {
        if (zai) {
          await response.body?.cancel();
          fail(`HTTP ${response.status}.`);
        }
        const failure = await apiKeyFailure(response);
        if (failure) throw failure;
        return;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (zai) {
          const phase = error instanceof SyntaxError ? "parse" : "body";
          fail(`HTTP ${response.status}; ${phase === "parse" ? "invalid JSON" : "response body did not complete"}; ${diagnostic(error, phase)}.`);
        }
        payload = null;
      }
      if (zai && zaiUsageRejected(payload)) {
        fail(`HTTP ${response.status}; application rejected the request; ${zaiUsageShape(payload)}.`);
      }
      const quota = options.parseUsages(
        context.account.id,
        payload,
        context.quotas.get(context.account.id),
        context.now(),
      );
      if (zai && quota === null) {
        context.quotas.put({
          ...context.quotas.get(context.account.id), zaiUsageEvidence:undefined,
        });
        if (
          context.accounts !== undefined &&
          (payload === null ||
            typeof payload !== "object" ||
            "data" in payload ||
            "code" in payload ||
            "success" in payload ||
            "error" in payload)
        ) {
          fail(`HTTP ${response.status}; no supported quota measurement; ${zaiUsageShape(payload)}.`);
        }
        return;
      }
      if (quota !== null) {
        if (zai) await context.accounts?.setZaiSubscriptionType?.(context.account.id, zaiSubscriptionType(payload));
        context.quotas.put(quota);
      }
    },
    errorResponse(status, message, headers, request) {
      return poolErrorResponse(options.provider, status, message, headers, request);
    },
  };
}
