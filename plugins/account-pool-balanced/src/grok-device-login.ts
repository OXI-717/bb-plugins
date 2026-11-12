import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { AccountSummary } from "./contracts.js";
import { parseGrokAuthFile, type GrokSubscriptionCredentials } from "./grok-credentials.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const LOGIN_PROMPT_TIMEOUT_MS = 30_000;
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
  spawnLogin?: (env: NodeJS.ProcessEnv) => LoginChild;
  addAccount: (credentials: GrokSubscriptionCredentials) => Promise<AccountSummary>;
}

type LoginChild = ChildProcessByStdio<null, Readable, Readable>;

interface LoginSession {
  sessionId: string;
  child: LoginChild;
  grokHome: string;
  expiresAt: number;
  verificationUri: string | null;
  userCode: string | null;
  output: string;
  settled: { code: number | null; failed: boolean } | null;
  polling: boolean;
}

const URL_PATTERN = /https:\/\/[^\s"'<>]+/u;
const CODE_PATTERN = /\b(?:user\s+)?code\s*(?:is\s*)?[:=]?\s*([A-Za-z0-9-]{4,})/iu;

export class GrokDeviceLogin {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly now: () => number;
  private readonly command: string;
  private readonly args: string[];

  constructor(private readonly options: GrokDeviceLoginOptions) {
    this.now = options.now ?? Date.now;
    this.command = options.command ?? "grok";
    this.args = options.args ?? ["login", "--device-auth"];
  }

  async start(): Promise<GrokDeviceLoginStart> {
    const grokHome = await mkdtemp(path.join(tmpdir(), "bb-pool-grok-login-"));
    const env: NodeJS.ProcessEnv = { ...process.env, GROK_HOME: grokHome };
    for (const name of [
      "XAI_API_KEY",
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
      child = this.options.spawnLogin
        ? this.options.spawnLogin(env)
        : spawn(this.command, this.args, {
            env,
            stdio: ["ignore", "pipe", "pipe"] as const,
          });
    } catch {
      await rm(grokHome, { recursive: true, force: true });
      throw new Error("Grok CLI could not be started. Install the official `grok` CLI and retry.");
    }

    const session: LoginSession = {
      sessionId: randomUUID(),
      child,
      grokHome,
      expiresAt: this.now() + LOGIN_TIMEOUT_MS,
      verificationUri: null,
      userCode: null,
      output: "",
      settled: null,
      polling: false,
    };
    const capture = (chunk: Buffer) => {
      session.output = (session.output + chunk.toString("utf8")).slice(-MAX_CAPTURED_OUTPUT);
      const url = URL_PATTERN.exec(session.output)?.[0]?.replace(/[.,)]+$/u, "");
      const code = CODE_PATTERN.exec(session.output)?.[1];
      if (url !== undefined) session.verificationUri = url;
      if (code !== undefined) session.userCode = code;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () => {
      session.settled = { code: null, failed: true };
    });
    child.once("close", (code) => {
      session.settled ??= { code, failed: false };
    });
    this.sessions.set(session.sessionId, session);

    const deadline = Date.now() + LOGIN_PROMPT_TIMEOUT_MS;
    // URL and code can arrive in separate output chunks: wait for both,
    // subject to the deadline and the process exiting early.
    while (
      Date.now() < deadline &&
      (session.verificationUri === null || session.userCode === null) &&
      session.settled === null
    ) await new Promise((resolve) => setTimeout(resolve, 25));

    if (session.verificationUri === null || session.userCode === null) {
      await this.disposeSession(session);
      throw new Error("Grok CLI did not provide a device code. Check that the installed CLI supports device login.");
    }
    return {
      sessionId: session.sessionId,
      verificationUri: session.verificationUri,
      userCode: session.userCode,
      expiresAt: session.expiresAt,
      intervalMs: 1_000,
    };
  }

  async poll(input: { sessionId: string }): Promise<GrokDeviceLoginPoll> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) return { status: "error", message: "Grok login session was not found. Start again." };
    if (this.now() >= session.expiresAt) {
      await this.disposeSession(session);
      return { status: "error", message: "Grok sign-in expired. Start again." };
    }
    if (session.settled === null || session.polling) return { status: "pending" };
    session.polling = true;
    try {
      if (session.settled.code !== 0 || session.settled.failed) {
        await this.disposeSession(session);
        return { status: "error", message: "Grok sign-in did not finish. Start again." };
      }
      const authFile = path.join(session.grokHome, "auth.json");
      const credentials = parseGrokAuthFile(await readFile(authFile, "utf8"));
      const account = await this.options.addAccount(credentials);
      await this.disposeSession(session);
      return { status: "complete", account };
    } catch {
      await this.disposeSession(session);
      return { status: "error", message: "Grok credentials could not be saved. Start again." };
    } finally {
      session.polling = false;
    }
  }

  nextPollDelayMs(): number {
    return 1_000;
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

  private async disposeSession(session: LoginSession): Promise<void> {
    this.sessions.delete(session.sessionId);
    session.output = "";
    if (session.settled === null) session.child.kill();
    await rm(session.grokHome, { recursive: true, force: true }).catch(() => undefined);
  }
}
