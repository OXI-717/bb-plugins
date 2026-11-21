import { mkdtemp, readFile, stat, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GEMINI_SYNTHETIC_EXPIRY, writeGeminiPoolHome } from "./gemini-home.js";

describe("gemini pool home", () => {
  it("writes the pooled token under an isolated HOME with private directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemini-home-"));
    const hubToken = "hub-token-value";
    const home = await writeGeminiPoolHome({
      dataDir: path.join(root, "data"),
      hubToken,
      email: "pool@example.com",
    });
    expect(home).not.toContain(hubToken);
    const tokenPath = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const token = JSON.parse(await readFile(tokenPath, "utf8")) as {
      token: { access_token: string; token_type: string; expiry: string; refresh_token?: string };
      auth_method: string;
      id_token_email?: string;
      refresh_token?: string;
    };
    expect(token).toEqual({
      token: {
        access_token: hubToken,
        token_type: "Bearer",
        expiry: GEMINI_SYNTHETIC_EXPIRY,
      },
      auth_method: "consumer",
      id_token_email: "pool@example.com",
    });
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(tokenPath)).isSymbolicLink()).toBe(false);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(home, ".gemini"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(home, ".gemini", "antigravity-cli"))).mode & 0o777).toBe(0o700);
    await expect(lstat(path.join(home, ".gemini", "antigravity-cli", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps legacy personal-profile links outside the Pool HOME", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemini-home-legacy-"));
    const dataDir = path.join(root, "data");
    const legacyHome = path.join(dataDir, "gemini-homes", "acd10b64bba3a11990491fff7281449c");
    const legacyCliDir = path.join(legacyHome, "antigravity-cli");
    const personalSettings = path.join(root, "personal-settings.json");
    await mkdir(legacyCliDir, { recursive: true });
    await writeFile(personalSettings, "synthetic personal settings");
    await symlink(personalSettings, path.join(legacyCliDir, "settings.json"));

    const home = await writeGeminiPoolHome({
      dataDir,
      hubToken: "hub-token-value",
      email: null,
    });

    expect(home).toBe(path.join(legacyHome, "home"));
    expect(await readFile(path.join(legacyCliDir, "settings.json"), "utf8")).toBe("synthetic personal settings");
    expect((await lstat(path.join(legacyCliDir, "settings.json")).then((details) => details.isSymbolicLink()))).toBe(true);
    await expect(lstat(path.join(home, "antigravity-cli", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
