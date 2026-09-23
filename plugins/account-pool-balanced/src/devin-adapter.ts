import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { AccountSecret } from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { filterRequestHeaders, mountedUpstreamUrl } from "./provider-adapter.js";
import { isQuotaRejection, quotaFromHeaders } from "./quota.js";

export const DEVIN_MOUNT_PREFIX = "devin/";
export function devinMachineToken(headers: Headers): string | null {
  const match = /^Basic ([A-Za-z0-9_-]+)$/u.exec(headers.get("authorization") ?? "");
  if (!match) return null;
  // The CLI appends a 43-character machine identifier to the configured key.
  // Validate its shape, then authenticate the exact remaining pool token.
  const credential = match[1]!;
  const suffix = /-[A-Za-z0-9_-]{43}$/u.exec(credential);
  return suffix ? credential.slice(0, -suffix[0].length) : credential;
}
// Devin Local CLI uses Connect RPCs. Keep this list narrow so a new CLI endpoint
// cannot silently become an unaudited proxy route.
export const DEVIN_PROXIED_PATHS = [
  "exa.seat_management_pb.SeatManagementService/GetUserStatus",
  "exa.seat_management_pb.SeatManagementService/GetCliTeamSettings",
  "exa.api_server_pb.ApiServerService/GetCliModelConfigs",
  "exa.api_server_pb.ApiServerService/GetAccountManagedPlugins",
  "exa.api_server_pb.ApiServerService/GetChatMessage",
  "exa.auth_pb.AuthService/GetUserJwt",
  "exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents",
] as const;

const MAX_PROTO = 16 * 1024 * 1024;
const MAX_FIELDS = 100_000;
const ALLOWED_HEADERS = new Set(["accept", "content-type", "content-encoding", "user-agent"]);
const ALLOWED_PREFIXES = ["connect-", "x-request-id"];

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return Uint8Array.from(bytes);
}

function readVarint(body: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 8 && offset < body.length; i++) {
    const byte = body[offset++]!;
    value += (byte & 127) * scale;
    if (!Number.isSafeInteger(value)) throw new Error("Invalid Devin protobuf length.");
    if ((byte & 128) === 0) return [value, offset];
    scale *= 128;
  }
  throw new Error("Invalid Devin protobuf varint.");
}

function skipVarint(body: Uint8Array, offset: number): number {
  for (let i = 0; i < 10 && offset < body.length; i++) {
    if ((body[offset++]! & 128) === 0) return offset;
  }
  throw new Error("Invalid Devin protobuf varint.");
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  if (size > MAX_PROTO) throw new Error("Devin request exceeds the protobuf limit.");
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** Replace metadata.apiKey (top-level field 1, nested field 3), preserving unknown fields. */
export function replaceDevinKey(body: Uint8Array, key: string): Uint8Array {
  if (body.length > MAX_PROTO) throw new Error("Devin request exceeds the protobuf limit.");
  function rewrite(message: Uint8Array, metadata: boolean): Uint8Array {
    const parts: Uint8Array[] = [];
    let offset = 0;
    let count = 0;
    while (offset < message.length) {
      if (++count > MAX_FIELDS) throw new Error("Too many Devin protobuf fields.");
      const start = offset;
      const [tag, afterTag] = readVarint(message, offset);
      offset = afterTag;
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (field === 0) throw new Error("Invalid Devin protobuf field.");
      if (wire === 0) offset = skipVarint(message, offset);
      else if (wire === 1) offset += 8;
      else if (wire === 5) offset += 4;
      else if (wire === 2) {
        const [length, afterLength] = readVarint(message, offset);
        offset = afterLength + length;
        if (offset > message.length) throw new Error("Truncated Devin protobuf field.");
        if ((!metadata && field === 1) || (metadata && field === 3)) {
          const replacement = metadata
            ? new TextEncoder().encode(key)
            : rewrite(message.subarray(afterLength, offset), true);
          parts.push(varint(tag), varint(replacement.length), replacement);
          continue;
        }
      } else throw new Error("Unsupported Devin protobuf wire type.");
      if (offset > message.length) throw new Error("Truncated Devin protobuf field.");
      parts.push(message.subarray(start, offset));
    }
    return concat(parts);
  }
  return rewrite(body, false);
}

export function rewriteDevinBody(body: Uint8Array, contentType: string, key: string, contentEncoding: string | null = null): Uint8Array {
  const encoding = contentEncoding?.trim().toLowerCase() ?? "identity";
  if (encoding === "gzip") {
    const decoded = gunzipSync(body, { maxOutputLength: MAX_PROTO });
    const encoded = gzipSync(rewriteDevinBody(decoded, contentType, key));
    if (encoded.length > MAX_PROTO) throw new Error("Devin request exceeds the protobuf limit.");
    return encoded;
  }
  if (encoding !== "identity" && encoding !== "") throw new Error("Unsupported Devin HTTP content encoding.");
  if (!contentType.startsWith("application/connect+")) return replaceDevinKey(body, key);
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 5 > body.length) throw new Error("Truncated Devin Connect frame.");
    const flag = body[offset]!;
    const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0);
    offset += 5;
    if (length > MAX_PROTO || offset + length > body.length) throw new Error("Invalid Devin Connect frame length.");
    const payload = body.subarray(offset, offset + length);
    offset += length;
    if ((flag & 2) !== 0) { frames.push(body.subarray(offset - length - 5, offset)); continue; }
    if ((flag & ~1) !== 0) throw new Error("Unsupported Devin Connect frame flags.");
    const decoded = flag & 1 ? gunzipSync(payload, { maxOutputLength: MAX_PROTO }) : payload;
    const rewritten = replaceDevinKey(decoded, key);
    const encoded = flag & 1 ? gzipSync(rewritten) : rewritten;
    const header = new Uint8Array(5);
    header[0] = flag;
    new DataView(header.buffer).setUint32(1, encoded.length);
    frames.push(header, encoded);
  }
  return concat(frames);
}

export function createDevinAdapter(): ProviderAdapter {
  return {
    provider: "devin",
    upstreamName: "Devin",
    inboundToken: devinMachineToken,
    async importAccount() { throw new Error("Add Devin with a PAT via --api-key-stdin."); },
    parseRequest(body, headers) {
      const clientSession = headers.get("x-bb-devin-session");
      const clientAuthorization = headers.get("authorization");
      const affinityId = clientSession !== null && /^[A-Za-z0-9_-]{8,128}$/u.test(clientSession)
        ? `cli:${clientSession}`
        : clientAuthorization !== null
          ? `cli:${createHash("sha256").update(clientAuthorization).digest("base64url")}`
          : "cli:default";
      return {
        family: "other",
        affinityId,
        parentAffinityId: null,
        forAccount(_account, secret) {
          if (secret.kind !== "api-key") throw new Error("Devin requires a PAT.");
          return rewriteDevinBody(body, headers.get("content-type") ?? "application/proto", secret.apiKey, headers.get("content-encoding"));
        },
      };
    },
    upstreamUrl: (request, settings) => mountedUpstreamUrl(request, settings.devinUpstreamBaseUrl, DEVIN_MOUNT_PREFIX),
    requestHeaders(inbound, _account, secret) {
      if (secret.kind !== "api-key") throw new Error("Devin requires a PAT.");
      const headers = filterRequestHeaders(inbound, ALLOWED_HEADERS, ALLOWED_PREFIXES);
      headers.set("authorization", `Basic ${secret.apiKey}`);
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) { return { secret: context.secret, refreshed: false }; },
    async refreshUsage() {},
    errorResponse(status, message, headers) { return Response.json({ error: { message, code: status } }, { status, headers }); },
  };
}
