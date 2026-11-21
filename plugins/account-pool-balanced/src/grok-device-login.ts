import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { AccountSummary } from "./contracts.js";
import {
  importGrokCredentials,
  type GrokSubscriptionCredentials,
} from "./grok-credentials.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_CAPTURED_OUTPUT = 16_384;

export interface GrokDeviceLoginStart {
  sessionId: string;
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}

export type GrokDeviceLoginPoll =
  | { status: "pending" }
  | { status: "complete"; account: AccountSummary }
  | { status: "error"; message: string };

export interface GrokDeviceLoginOptions {
  now?: () => number;
  command?: string;
  args?: string[];
  spawnLogin?: (env: NodeJS.ProcessEnv, authFile: string) => LoginChild;
  addAccount: (authenticated: GrokSubscriptionCredentials) => Promise<AccountSummary>;
}

type LoginChild = ChildProcessByStdio<null, Readable, Readable>;

interface LoginSession {
  sessionId: string;
  child: LoginChild;
  authFile: string;
  home: string;
  expiresAt: number;
  url: string | null;
  userCode: string | null;
  output: string;
  settled: { code: number | null; error: string | null } | null;
  polling: boolean;
}

const URL_LINE = /https:\/\/\S+/u;
const CODE_LINE = /(?:^|\n)\s*code:\s*([A-Za-z0-9-]{4,})\s*(?:\n|$)/iu;

export class GrokDeviceLogin {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly now: () => number;
  private readonly command: string;
  private readonly args: string[];
  private readonly spawnLogin: GrokDeviceLoginOptions["spawnLogin"];

  constructor(private readonly options: GrokDeviceLoginOptions) {
    this.now = options.now ?? Date.now;
    this.command = options.command ?? "grok";
    this.args = options.args ?? ["login", "--device-auth"];
    this.spawnLogin = options.spawnLogin;
  }

  async start(): Promise<GrokDeviceLoginStart> {
    const home = await mkdtemp(path.join(tmpdir(), "grok-login-"));
    const authFile = path.join(home, "auth.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GROK_HOME: home,
      GROK_AUTH_PATH: authFile,
      GROK_DISABLE_API_KEY_AUTH: "1",
    };
    for (const name of [
      "XAI_API_KEY",
      "GROK_XAI_API_BASE_URL",
      "GROK_DEPLOYMENT_KEY",
      "GROK_CLI_CHAT_PROXY_BASE_URL",
      "GROK_MODELS_BASE_URL",
      "GROK_MODELS_LIST_URL",
      "GROK_AUTH_PROVIDER_COMMAND",
      "GROK_AUTH_PROVIDER_LABEL",
      "GROK_OIDC_ISSUER",
      "GROK_OIDC_CLIENT_ID",
    ]) delete env[name];
    let child: LoginChild;
    try {
      child = this.spawnLogin
        ? this.spawnLogin(env, authFile)
        : spawn(this.command, this.args, {
            env,
            stdio: ["ignore", "pipe", "pipe"] as const,
          });
    } catch {
      await rm(home, { recursive: true, force: true });
      throw new Error("Grok CLI could not be started. Install the official `grok` CLI and retry.");
    }
    const session: LoginSession = {
      sessionId: randomUUID(),
      child,
      authFile,
      home,
      expiresAt: this.now() + LOGIN_TIMEOUT_MS,
      url: null,
      userCode: null,
      output: "",
      settled: null,
      polling: false,
    };
    const capture = (chunk: Buffer) => {
      session.output = (session.output + chunk.toString("utf8")).slice(-MAX_CAPTURED_OUTPUT);
      const url = URL_LINE.exec(session.output);
      const code = CODE_LINE.exec(session.output);
      if (url) session.url = url[0];
      if (code?.[1]) session.userCode = code[1];
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      session.settled = { code: null, error: error.message };
    });
    child.once("close", (code) => {
      session.settled ??= { code, error: null };
    });
    this.sessions.set(session.sessionId, session);
    const ready = await this.waitForPrompt(session);
    if (ready !== null) {
      await this.disposeSession(session);
      throw new Error(ready);
    }
    return {
      sessionId: session.sessionId,
      verificationUri: session.url!,
      userCode: session.userCode!,
      expiresAt: session.expiresAt,
      intervalMs: 1_000,
    };
  }

  async poll(input: { sessionId: string }): Promise<GrokDeviceLoginPoll> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      return { status: "error", message: "Login session was not found. Start again." };
    }
    if (this.now() >= session.expiresAt) {
      await this.disposeSession(session);
      return { status: "error", message: "Code expired, start again." };
    }
    if (session.settled === null || session.polling) return { status: "pending" };
    session.polling = true;
    try {
      if (session.settled.code !== 0) {
        await this.disposeSession(session);
        return {
          status: "error",
          message: "Grok sign-in did not finish. Start again.",
        };
      }
      const authenticated = await importGrokCredentials(session.authFile);
      const account = await this.options.addAccount(authenticated);
      await this.disposeSession(session);
      return { status: "complete", account };
    } catch {
      await this.disposeSession(session);
      return { status: "error", message: "Grok account could not be saved. Start again." };
    } finally {
      session.polling = false;
    }
  }

  nextPollDelayMs(): number {
    return 1_000;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  cancel(input: { sessionId: string }): boolean {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) return false;
    void this.disposeSession(session);
    return true;
  }

  dispose(): void {
    for (const session of this.sessions.values()) void this.disposeSession(session);
  }

  private async waitForPrompt(session: LoginSession): Promise<string | null> {
    for (let attempt = 0; attempt < 750; attempt += 1) {
      if (session.url !== null && session.userCode !== null) return null;
      if (session.settled !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return "Grok sign-in did not show a device code. Start again.";
  }

  private async disposeSession(session: LoginSession): Promise<void> {
    this.sessions.delete(session.sessionId);
    session.output = "";
    if (session.settled === null) session.child.kill();
    await rm(session.home, { recursive: true, force: true }).catch(() => undefined);
  }
}
