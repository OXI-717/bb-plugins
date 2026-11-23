import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refreshGrokAccess } from "./grok-oauth.js";

describe("grok subscription refresh", () => {
  it("rotates the refresh token and keeps the client id", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const next = await refreshGrokAccess({
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return Response.json({
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
        });
      },
      url: "https://auth.example/oauth2/token",
      now: () => 1_000,
      secret: {
        kind: "oauth",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
        clientId: "client-id",
      },
    });
    expect(calls[0]).toMatchObject({ url: "https://auth.example/oauth2/token" });
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
    expect(calls[0]?.body).toContain("refresh_token=old-refresh");
    expect(calls[0]?.body).toContain("client_id=client-id");
    expect(next).toEqual({
      kind: "oauth",
      accessToken: "next-access",
      refreshToken: "next-refresh",
      expiresAt: 1_000 + 3_600_000,
      clientId: "client-id",
    });
  });

  it("prints only the hub token for the Grok CLI", () => {
    const script = fileURLToPath(new URL("./grok-auth-provider.mjs", import.meta.url));
    const missing = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, BB_POOL_GROK_HUB_TOKEN: "" },
    });
    expect(missing.status).toBe(1);
    const printed = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, BB_POOL_GROK_HUB_TOKEN: "hub-token", GROK_AUTH_TOKEN_TTL: "120" },
    });
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual({ access_token: "hub-token", expires_in: 120 });
  });
});
