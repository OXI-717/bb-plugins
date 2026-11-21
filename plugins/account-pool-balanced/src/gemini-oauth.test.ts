import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OAuthRefreshRejectedError } from "./provider-adapter.js";
import {
  absoluteUpstreamUrl,
  GEMINI_OAUTH_CLIENT_ID,
  geminiClientSecretFromBytes,
  readGeminiOAuthClientSecret,
  refreshGeminiAccess,
} from "./gemini-oauth.js";

const secret = {
  kind: "oauth" as const,
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: 1,
  clientId: GEMINI_OAUTH_CLIENT_ID,
};

describe("gemini oauth", () => {
  it("joins colon paths without dropping the base or the query", () => {
    const joined = absoluteUpstreamUrl(
      "https://daily-cloudcode-pa.googleapis.com/",
      "v1internal:streamGenerateContent",
      "?alt=sse",
    );
    expect(joined.origin).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(joined.pathname).toBe("/v1internal:streamGenerateContent");
    expect(joined.search).toBe("?alt=sse");
    expect(absoluteUpstreamUrl(
      "https://generativelanguage.googleapis.com",
      "v1beta/models/gemini-2.5-pro:generateContent",
    ).pathname).toBe("/v1beta/models/gemini-2.5-pro:generateContent");
  });

  it("reads a client secret only from the window around the public client id", () => {
    const near = Buffer.from(`xx${GEMINI_OAUTH_CLIENT_ID} yy GOCSPX-UNITTESTONLY zz`);
    expect(geminiClientSecretFromBytes(near)).toBe("GOCSPX-UNITTESTONLY");
    const far = Buffer.concat([
      Buffer.from(GEMINI_OAUTH_CLIENT_ID),
      Buffer.alloc(300, "a"),
      Buffer.from("GOCSPX-UNITTESTONLY"),
    ]);
    expect(geminiClientSecretFromBytes(far)).toBeNull();
    const glued = `GOCSPX-${"U".repeat(28)}decoding in-band SSE JSON error: %w`;
    const separated = Buffer.concat([
      Buffer.from(glued),
      Buffer.alloc(800, "b"),
      Buffer.from(GEMINI_OAUTH_CLIENT_ID),
    ]);
    expect(geminiClientSecretFromBytes(separated)).toBe(`GOCSPX-${"U".repeat(28)}`);
    expect(geminiClientSecretFromBytes(separated)).not.toContain("decoding");
  });

  it("scans a Go-sized file where the secret is far from the client id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agy-secret-"));
    const file = path.join(dir, "agy");
    const secretValue = `GOCSPX-${"U".repeat(28)}`;
    await writeFile(file, Buffer.concat([
      Buffer.from(`${secretValue}decoding in-band SSE JSON error: %w`),
      Buffer.alloc(1_100_000, "q"),
      Buffer.from(GEMINI_OAUTH_CLIENT_ID),
    ]));
    const previousBin = process.env.BB_POOL_AGY_BIN;
    const previousSecret = process.env.BB_POOL_GEMINI_OAUTH_CLIENT_SECRET;
    process.env.BB_POOL_AGY_BIN = file;
    delete process.env.BB_POOL_GEMINI_OAUTH_CLIENT_SECRET;
    try {
      await expect(readGeminiOAuthClientSecret()).resolves.toBe(secretValue);
    } finally {
      if (previousBin === undefined) delete process.env.BB_POOL_AGY_BIN;
      else process.env.BB_POOL_AGY_BIN = previousBin;
      if (previousSecret === undefined) delete process.env.BB_POOL_GEMINI_OAUTH_CLIENT_SECRET;
      else process.env.BB_POOL_GEMINI_OAUTH_CLIENT_SECRET = previousSecret;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("posts the refresh form and keeps the previous refresh token", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      expect(String(init?.body)).toContain("client_secret=test-client-secret");
      expect(String(init?.body)).toContain(`client_id=${encodeURIComponent(GEMINI_OAUTH_CLIENT_ID)}`);
      return Response.json({ access_token: "next-access", expires_in: 3600 });
    });
    const next = await refreshGeminiAccess({
      fetch: fetch as unknown as typeof globalThis.fetch,
      url: "https://oauth2.googleapis.com/token",
      now: () => 1_000,
      secret,
      clientSecret: "test-client-secret",
    });
    expect(next).toMatchObject({
      accessToken: "next-access",
      refreshToken: "old-refresh",
      expiresAt: 1_000 + 3_600_000,
      clientId: GEMINI_OAUTH_CLIENT_ID,
    });
  });

  it("rejects a missing client secret without putting it in the error", async () => {
    const hidden = "test-client-secret";
    await expect(refreshGeminiAccess({
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      url: "https://oauth2.googleapis.com/token",
      now: () => 0,
      secret: { ...secret, clientId: undefined },
      clientSecret: hidden,
    })).rejects.toBeInstanceOf(OAuthRefreshRejectedError);
    try {
      await refreshGeminiAccess({
        fetch: vi.fn() as unknown as typeof globalThis.fetch,
        url: "https://oauth2.googleapis.com/token",
        now: () => 0,
        secret: { ...secret, clientId: undefined },
        clientSecret: hidden,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthRefreshRejectedError);
      expect((error as Error).message).not.toContain(hidden);
      expect((error as OAuthRefreshRejectedError).accountMessage).not.toContain(hidden);
    }
  });
});
