import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AccountSummary } from "./contracts.js";
import { GeminiLogin } from "./gemini-login.js";

const account = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "pool@example.com",
} as AccountSummary;

function loginScript(exitCode: number, prompt: boolean): string {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(process.env.ANTIGRAVITY_GEMINI_DIR, "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    if (${prompt}) process.stdout.write("Open https://accounts.google.com/device\\nCode: GEM-1234\\n");
    setTimeout(() => {
      fs.writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({
        token: {
          access_token: "access-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
          expiry: "2099-01-01T00:00:00.000Z"
        },
        auth_method: "consumer",
        id_token_email: "pool@example.com"
      }));
      process.exit(${exitCode});
    }, 30);
  `;
}

describe("gemini sign-in", () => {
  it("shows an optional code and saves the account without API env", async () => {
    let seen: NodeJS.ProcessEnv = {};
    const login = new GeminiLogin({
      spawnLogin: (env) => {
        seen = env;
        return spawn(process.execPath, ["-e", loginScript(0, true)], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
      addAccount: async (authenticated) => {
        expect(authenticated).toMatchObject({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          email: "pool@example.com",
        });
        return account;
      },
    });
    const started = await login.start();
    expect(started.verificationUri).toBe("https://accounts.google.com/device");
    expect(started.userCode).toBe("GEM-1234");
    expect(seen.GEMINI_API_KEY).toBeUndefined();
    expect(seen.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    expect(seen.CLOUD_CODE_URL).toBeUndefined();
    expect(seen.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    let result = await login.poll({ sessionId: started.sessionId });
    const deadline = Date.now() + 2_000;
    while (result.status === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      result = await login.poll({ sessionId: started.sessionId });
    }
    expect(result).toEqual({ status: "complete", account });
    login.dispose();
  });

  it("starts while the process is still running without a code", async () => {
    const login = new GeminiLogin({
      spawnLogin: (env) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      addAccount: async () => account,
    });
    const started = await login.start();
    expect(started.verificationUri).toBeNull();
    expect(started.userCode).toBeNull();
    login.dispose();
  });
});
