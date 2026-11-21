import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AccountSummary } from "./contracts.js";
import { GrokDeviceLogin } from "./grok-device-login.js";

const account = { id: "11111111-1111-4111-8111-111111111111", label: "pool@example.com" } as AccountSummary;

function loginScript(exitCode: number): string {
  return `
    const fs = require("node:fs");
    process.stdout.write("Open this URL in your browser to approve:\\nhttps://auth.x.ai/device\\nCode: ABCD-1234\\n");
    setTimeout(() => {
      fs.writeFileSync(process.env.GROK_AUTH_PATH, JSON.stringify({
        "https://auth.x.ai::account": {
          key: "access-token",
          email: "pool@example.com",
          refresh_token: "refresh-token",
          expires_at: "2026-11-04T18:00:00.000Z",
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: "client-id"
        }
      }));
      process.exit(${exitCode});
    }, 30);
  `;
}

describe("grok device sign-in", () => {
  it("shows the device code and saves the account without an API key", async () => {
    let seenKey: string | undefined = "present";
    const login = new GrokDeviceLogin({
      spawnLogin: (env) => {
        seenKey = env.XAI_API_KEY;
        return spawn(process.execPath, ["-e", loginScript(0)], { env, stdio: ["ignore", "pipe", "pipe"] });
      },
      addAccount: async (authenticated) => {
        expect(authenticated).toMatchObject({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          clientId: "client-id",
          email: "pool@example.com",
        });
        return account;
      },
    });
    const started = await login.start();
    expect(started.verificationUri).toBe("https://auth.x.ai/device");
    expect(started.userCode).toBe("ABCD-1234");
    expect(seenKey).toBeUndefined();
    let result = await login.poll({ sessionId: started.sessionId });
    const deadline = Date.now() + 2_000;
    while (result.status === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      result = await login.poll({ sessionId: started.sessionId });
    }
    expect(result).toEqual({ status: "complete", account });
    login.dispose();
  });
});
