import { poolErrorResponse } from "./pool-errors.js";
import { apiKeyFailure } from "./api-key-errors.js";
import type {
  AccountPoolConfig,
  AccountQuota,
  PoolProvider,
} from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  filterRequestHeaders,
  mountedPathSuffix,
  mountedUpstreamUrl,
} from "./provider-adapter.js";
import { isQuotaRejection, modelFamily, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";

export const ZAI_MOUNT_PREFIX = "zai/";
export const OPENCODE_GO_MOUNT_PREFIX = "opencode-go/";

export const WIRE_PROTOCOL_REFUSAL_CODE = "unsupported_wire_protocol";

const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["x-stainless-"];

export const OPENCODE_GO_FREE_MODELS = new Set([
  "beam-free",
  "big-pickle",
  "crouton-alpha-free",
  "deepseek-v4.1-flash-free",
  "flint-40b-free",
  "glm-5.3-flash-free",
  "iceman-contributor-free",
  "jev-1.13-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
  "pulse-alpha-free",
]);

export function isOpenCodeGoFreeModelBody(body: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === "string" && OPENCODE_GO_FREE_MODELS.has(model);
  } catch {
    return false;
  }
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

export function opencodeGoUpstreamPathSuffix(
  suffix: string,
  body: Uint8Array,
): string {
  // A Chat Completions body on /responses asked for the wrong endpoint —
  // point it at the endpoint its body matches. A genuine Responses body
  // goes to the native /responses wire that OpenCode Go also serves.
  if (suffix === "responses" && isChatCompletionsBody(body)) {
    return "chat/completions";
  }
  return suffix;
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

export interface OpenAiCompatibleAdapterOptions {
  provider: PoolProvider;
  upstreamName: string;
  mountPrefix: string;
  upstreamBaseUrl: (settings: AccountPoolConfig) => string;
  usagesUrl: string;
  allowedHeaderPrefixes?: readonly string[];
  normalizeUpstreamPathSuffix?: (
    upstreamPath: string,
    body: Uint8Array,
  ) => string;
  guardRequestBody?: (suffix: string, body: Uint8Array) => string | null;
  inboundToken?: (headers: Headers) => string | null;
  upstreamApiKeyHeader?: string;
  freeUpstreamBaseUrl?: (settings: AccountPoolConfig) => string;
  freeUpstreamBody?: (body: Uint8Array) => boolean;
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
    inboundToken: (headers) => options.inboundToken?.(headers) ?? null,
    async importAccount() {
      throw new Error(
        `${options.upstreamName} accounts carry no local login to import; add them with --api-key-stdin.`,
      );
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
    upstreamUrl: (request, settings, body) =>
      mountedUpstreamUrl(
        request,
        options.freeUpstreamBaseUrl &&
          options.freeUpstreamBody?.(body ?? new Uint8Array())
          ? options.freeUpstreamBaseUrl(settings)
          : options.upstreamBaseUrl(settings),
        `${options.mountPrefix}v1/`,
        options.normalizeUpstreamPathSuffix
          ? (upstreamPath) =>
              options.normalizeUpstreamPathSuffix!(
                upstreamPath,
                body ?? new Uint8Array(),
              )
          : undefined,
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
      if (options.upstreamApiKeyHeader) {
        headers.set(options.upstreamApiKeyHeader, secret.apiKey);
      }
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      return { secret: context.secret, refreshed: false };
    },
    refreshesApiKeyUsage: true,
    async refreshUsage(context) {
      if(options.provider==='opencode-go'||options.provider==='neuraldeep')context.quotas.put({...context.quotas.get(context.account.id),providerBudgetEvidence:undefined});
      const secret = await context.freshSecret();
      if (secret.kind !== "api-key") return;
      const response = await context.fetch(options.usagesUrl, {
        headers: {
          authorization: `Bearer ${secret.apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const failure = await apiKeyFailure(response);
        if (failure) throw failure;
        return;
      }
      const quota = options.parseUsages(
        context.account.id,
        await response.json().catch(() => null),
        context.quotas.get(context.account.id),
        context.now(),
      );
      if (quota !== null) context.quotas.put(quota);
      else if (options.provider === 'zai') context.quotas.put({
        ...context.quotas.get(context.account.id), zaiUsageEvidence:undefined,
      });
    },
    errorResponse(status, message, headers, request) {
      return poolErrorResponse(options.provider, status, message, headers, request);
    },
  };
}
