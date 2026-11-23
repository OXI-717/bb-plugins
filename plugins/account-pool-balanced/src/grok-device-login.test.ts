import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
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

it("terminates and removes an abandoned Grok login at expiry", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  let grokHome!: string;
  const spawnLogin = vi.fn((env: NodeJS.ProcessEnv) => {
    grokHome = env.GROK_HOME!;
    setTimeout(() => child.stdout.write("https://login.example code: TEST"), 1);
    return child as unknown as ReturnType<NonNullable<ConstructorParameters<typeof GrokDeviceLogin>[0]["spawnLogin"]>>;
  });
  const login = new GrokDeviceLogin({ spawnLogin, addAccount: vi.fn() });
  try {
    const starting = login.start();
    await vi.waitFor(() => expect(spawnLogin).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(25);
    const started = await starting;
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(started.expiresAt - Date.now());
    expect(child.kill).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(access(grokHome)).rejects.toThrow());
    expect(login.cancel({sessionId: started.sessionId})).toBe(false);
  } finally {
    login.dispose();
    vi.useRealTimers();
  }
});
