import { open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AccountSecret } from "./contracts.js";
import { OAuthRefreshRejectedError } from "./provider-adapter.js";

export const GEMINI_CLOUD_CODE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_REFRESH_URL = "https://oauth2.googleapis.com/token";
export const GEMINI_OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const GEMINI_USER_AGENT =
  "antigravity/1.11.0 (os_type=linux; arch=amd64; auth_method=consumer)";

const SECRET_WINDOW_BYTES = 256;
const SECRET_MARKER = "decoding in-band SSE";
const SECRET_NEAR = /GOCSPX-[A-Za-z0-9_-]{1,28}/u;
const SECRET_MARKED = /GOCSPX-[A-Za-z0-9_-]{28}(?=decoding in-band SSE)/u;
const SECRET_BOUNDED = /GOCSPX-[A-Za-z0-9_-]{28}(?=decoding in-band SSE|$|[^A-Za-z0-9_-])/u;
const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
    id_token: z.string().min(1).optional(),
  })
  .passthrough();

let cachedClientSecret: Promise<string> | null = null;

export function absoluteUpstreamUrl(base: string, suffix: string, search = ""): URL {
  const root = base.replace(/\/+$/u, "");
  const pathSuffix = suffix.replace(/^\/+/u, "");
  return new URL(`${root}/${pathSuffix}${search}`);
}

export function geminiClientSecretFromBytes(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes).toString("latin1");
  const at = text.indexOf(GEMINI_OAUTH_CLIENT_ID);
  if (at >= 0) {
    const start = Math.max(0, at - SECRET_WINDOW_BYTES);
    const end = Math.min(text.length, at + GEMINI_OAUTH_CLIENT_ID.length + SECRET_WINDOW_BYTES);
    const near = SECRET_NEAR.exec(text.slice(start, end));
    if (near !== null) return near[0];
  }
  // Go .rodata sorts strings by length, so the consumer secret is not beside the client id.
  // It is the 35-byte value glued to "decoding in-band SSE".
  const marked = SECRET_MARKED.exec(text);
  if (marked !== null) return marked[0];
  return SECRET_BOUNDED.exec(text)?.[0] ?? null;
}

function agyBinPath(): string | null {
  const fromEnv = process.env.BB_POOL_AGY_BIN?.trim();
  if (fromEnv) return fromEnv;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "agy");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function scanAgyClientSecret(file: string): Promise<string> {
  const clientNeedle = Buffer.from(GEMINI_OAUTH_CLIENT_ID);
  const markerNeedle = Buffer.from(SECRET_MARKER);
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const chunkSize = 1024 * 1024;
    const overlap = clientNeedle.length + markerNeedle.length + 35 + SECRET_WINDOW_BYTES;
    let offset = 0;
    let carry = Buffer.alloc(0);
    let fallback: string | null = null;
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, offset);
      const window = Buffer.concat([carry, chunk]);
      const secret = geminiClientSecretFromBytes(window);
      if (secret !== null) {
        const text = window.toString("latin1");
        if (text.includes(`${secret}${SECRET_MARKER}`)) return secret;
        const clientAt = window.indexOf(clientNeedle);
        if (clientAt >= 0) {
          const nearStart = Math.max(0, clientAt - SECRET_WINDOW_BYTES);
          const nearEnd = Math.min(window.length, clientAt + clientNeedle.length + SECRET_WINDOW_BYTES);
          if (text.slice(nearStart, nearEnd).includes(secret)) return secret;
        }
        fallback ??= secret;
      }
      carry = window.subarray(Math.max(0, window.length - overlap));
      offset += length;
    }
    if (fallback !== null) return fallback;
  } finally {
    await handle.close();
  }
  throw new Error("Gemini OAuth client secret is unavailable.");
}

export function readGeminiOAuthClientSecret(): Promise<string> {
  const fromEnv = process.env.BB_POOL_GEMINI_OAUTH_CLIENT_SECRET?.trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  cachedClientSecret ??= (async () => {
    const file = agyBinPath();
    if (file === null) throw new Error("Gemini OAuth client secret is unavailable.");
    return scanAgyClientSecret(file);
  })().catch((error: unknown) => {
    cachedClientSecret = null;
    throw error;
  });
  return cachedClientSecret;
}

export async function refreshGeminiAccess(input: {
  fetch: typeof fetch;
  url: string;
  now: () => number;
  secret: Extract<AccountSecret, { kind: "oauth" }>;
  clientSecret: string | (() => Promise<string>);
}): Promise<Extract<AccountSecret, { kind: "oauth" }>> {
  const clientSecret = typeof input.clientSecret === "function"
    ? await input.clientSecret()
    : input.clientSecret;
  if (input.secret.clientId === undefined || clientSecret.trim() === "") {
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
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new OAuthRefreshRejectedError(response.status, null);
  }
  const parsed = refreshResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new OAuthRefreshRejectedError(response.status, null);
  return {
    kind: "oauth",
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? input.secret.refreshToken,
    expiresAt: parsed.data.expires_in === undefined
      ? input.secret.expiresAt
      : input.now() + parsed.data.expires_in * 1_000,
    ...(parsed.data.id_token === undefined && input.secret.idToken === undefined
      ? {}
      : { idToken: parsed.data.id_token ?? input.secret.idToken }),
    clientId: input.secret.clientId,
  };
}
