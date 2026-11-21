import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  importGrokCredentials,
  parseGrokAuthFile,
} from "./grok-credentials.js";

const entry = {
  key: "access-token",
  auth_mode: "oidc",
  email: "pool@example.com",
  refresh_token: "refresh-token",
  expires_at: "2026-11-04T18:00:00.000Z",
  oidc_issuer: "https://auth.x.ai",
  oidc_client_id: "client-id",
};

describe("grok subscription credentials", () => {
  it("reads the OAuth session and forgets the refresh token on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "grok-auth-"));
    const file = path.join(dir, "auth.json");
    await writeFile(
      file,
      JSON.stringify({ "https://auth.x.ai::account": entry }),
    );

    const imported = await importGrokCredentials(file);

    expect(imported).toMatchObject({
      label: "pool@example.com",
      email: "pool@example.com",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      clientId: "client-id",
      issuer: "https://auth.x.ai",
    });
    expect(imported.expiresAt).toBe(Date.parse("2026-11-04T18:00:00.000Z"));
    const left = JSON.parse(await readFile(file, "utf8")) as {
      "https://auth.x.ai::account": { refresh_token?: string; key?: string };
    };
    expect(left["https://auth.x.ai::account"].refresh_token).toBeUndefined();
    expect(left["https://auth.x.ai::account"].key).toBe("access-token");
  });

  it("rejects a file that has no refresh token left to move", () => {
    expect(() =>
      parseGrokAuthFile(JSON.stringify({
        "https://auth.x.ai::account": { ...entry, refresh_token: "" },
      })),
    ).toThrow(/refresh token/i);
  });
});
