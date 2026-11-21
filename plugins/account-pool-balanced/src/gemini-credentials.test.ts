import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GEMINI_OAUTH_CLIENT_ID } from "./gemini-oauth.js";
import { importGeminiCredentials, parseGeminiAuthFile } from "./gemini-credentials.js";

const now = Date.parse("2026-11-04T12:00:00Z");

describe("gemini credential import", () => {
  it("reads the nested token and the flat test shape", () => {
    const nested = parseGeminiAuthFile(JSON.stringify({
      token: {
        access_token: "access-1",
        token_type: "Bearer",
        refresh_token: "refresh-1",
        expiry: "2026-11-04T17:22:05.298550326Z",
        expires_in: 3599,
      },
      auth_method: "consumer",
      id_token_email: "pool@example.com",
    }), now);
    expect(nested).toMatchObject({
      email: "pool@example.com",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      clientId: GEMINI_OAUTH_CLIENT_ID,
      expiresAt: Date.parse("2026-11-04T17:22:05.298Z"),
    });
    const flat = parseGeminiAuthFile(JSON.stringify({
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 60,
    }), now);
    expect(flat).toMatchObject({
      email: null,
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: now + 60_000,
    });
  });

  it("removes the nested refresh token and keeps the file private", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gemini-auth-"));
    const file = path.join(dir, "antigravity-oauth-token");
    await writeFile(file, JSON.stringify({
      token: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expiry: "2026-11-04T17:22:05Z",
      },
      auth_method: "consumer",
      id_token_email: "pool@example.com",
      refresh_token: "also-refresh",
    }));
    const imported = await importGeminiCredentials(file, now);
    expect(imported.refreshToken).toBe("refresh-1");
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      token: { refresh_token?: string };
      refresh_token?: string;
    };
    expect(stored.token.refresh_token).toBeUndefined();
    expect(stored.refresh_token).toBeUndefined();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("names a missing file and a file without a refresh token", async () => {
    await expect(importGeminiCredentials("/tmp/gemini-missing-login-token")).rejects.toThrow(
      "Gemini login was not found",
    );
    const dir = await mkdtemp(path.join(tmpdir(), "gemini-auth-"));
    const file = path.join(dir, "antigravity-oauth-token");
    await writeFile(file, JSON.stringify({ token: { access_token: "access-1" } }));
    await expect(importGeminiCredentials(file)).rejects.toThrow("no refresh token");
  });
});
