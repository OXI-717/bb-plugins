import { describe, expect, it, vi } from "vitest";
import { registerPoolCli } from "./cli.js";
import type { GrokDeviceLogin } from "./grok-device-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";

interface RegisteredCli {
  run(argv: string[], context: { signal?: AbortSignal }): Promise<{
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }>;
}

function register(grokLogin: Partial<GrokDeviceLogin>, codexLogin: Partial<CodexDeviceLogin>) {
  let registered: RegisteredCli | undefined;
  const bb = {
    cli: {
      register(definition: RegisteredCli) {
        registered = definition;
      },
    },
  };
  registerPoolCli(
    bb as never,
    {} as never,
    {} as never,
    codexLogin as CodexDeviceLogin,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    grokLogin as GrokDeviceLogin,
  );
  if (registered === undefined) throw new Error("Pool CLI did not register.");
  return registered;
}

const account = { id: "synthetic-account-id", label: "Grok fixture" } as never;

describe("Grok pool CLI login", () => {
  it("starts official Grok device login and prints the next command without credentials", async () => {
    const start = vi.fn(async () => ({
      sessionId: "synthetic-session",
      verificationUri: "https://grok.com/device",
      userCode: "SAFE-CODE",
      expiresAt: 2_000,
      intervalMs: 1_000,
    }));
    const cli = register({ start }, {});

    const result = await cli.run(
      ["account", "add", "--provider", "grok", "--login"],
      {},
    );

    expect(start).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("https://grok.com/device");
    expect(result.stdout).toContain("SAFE-CODE");
    expect(result.stdout).toContain(
      "bb pool account login-poll --session synthetic-session --provider grok",
    );
    expect(result.stdout).not.toContain("refresh");
  });

  it("polls the Grok session and returns only the saved account summary", async () => {
    const poll = vi.fn(async () => ({ status: "complete" as const, account }));
    const cli = register(
      {
        nextPollDelayMs: () => 0,
        poll,
        cancel: vi.fn(() => true),
      },
      {},
    );

    const result = await cli.run(
      ["account", "login-poll", "--session", "44444444-4444-4444-8444-444444444444", "--provider", "grok"],
      {},
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "Added Grok fixture (synthetic-account-id).\n",
    });
    expect(poll).toHaveBeenCalledWith({ sessionId: "44444444-4444-4444-8444-444444444444" });
  });

  it("keeps Codex as the default device-login poller", async () => {
    const poll = vi.fn(async () => ({ status: "complete" as const, account }));
    const cli = register({}, { nextPollDelayMs: () => 0, poll, cancel: vi.fn() });

    await cli.run(
      ["account", "login-poll", "--session", "33333333-3333-4333-8333-333333333333"],
      {},
    );

    expect(poll).toHaveBeenCalledWith({ sessionId: "33333333-3333-4333-8333-333333333333" });
  });
});
