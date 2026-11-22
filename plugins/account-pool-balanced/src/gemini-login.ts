import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { AccountSummary } from "./contracts.js";
import {
  geminiAuthFilePath,
  importGeminiCredentials,
  type GeminiSubscriptionCredentials,
} from "./gemini-credentials.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;

export interface GeminiLoginStart {
  sessionId: string;
  verificationUri: string | null;
  userCode: string | null;
  expiresAt: number;
  intervalMs: number;
}

export type GeminiLoginPoll =
  | { status: "pending" }
  | { status: "complete"; account: AccountSummary }
  | { status: "error"; message: string };

export interface GeminiLoginOptions {
  now?: () => number;
  command?: string;
  args?: string[];
  spawnLogin?: (env: NodeJS.ProcessEnv, home: string, args: string[]) => LoginChild;
  reauthorizeAccount?: (id: string, authenticated: GeminiSubscriptionCredentials) => Promise<AccountSummary>;
  addAccount: (authenticated: GeminiSubscriptionCredentials) => Promise<AccountSummary>;
}

type LoginChild = ChildProcessByStdio<null, Readable, Readable>;

interface LoginSession {
  targetAccountId?: string;
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

export class GeminiLogin {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly now: () => number;
  private readonly command: string;
  private readonly args: string[];
  private readonly spawnLogin: GeminiLoginOptions["spawnLogin"];

  constructor(private readonly options: GeminiLoginOptions) {
    this.now = options.now ?? Date.now;
    this.command = options.command ?? "agy";
    this.args = options.args ?? ["acp", "--login"];
    this.spawnLogin = options.spawnLogin;
  }

  async start(targetAccountId?: string): Promise<GeminiLoginStart> {
    if (targetAccountId !== undefined && !this.options.reauthorizeAccount) throw new Error("Gemini reauthorization is unavailable.");
    const home = await mkdtemp(path.join(tmpdir(), "gemini-login-"));
    const env: NodeJS.ProcessEnv = { ...process.env, ANTIGRAVITY_GEMINI_DIR: home };
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_GEMINI_BASE_URL;
    delete env.CLOUD_CODE_URL;
    delete env.DBUS_SESSION_BUS_ADDRESS;
    const args = [...this.args, "--gemini-dir", home];
    const child = this.spawnLogin
      ? this.spawnLogin(env, home, args)
      : spawn(this.command, args, { env, stdio: ["ignore", "pipe", "pipe"] as const });
    const session: LoginSession = {
      targetAccountId,
      sessionId: randomUUID(),
      child,
      authFile: geminiAuthFilePath(home),
      home,
      expiresAt: this.now() + LOGIN_TIMEOUT_MS,
      url: null,
      userCode: null,
      output: "",
      settled: null,
      polling: false,
    };
    const capture = (chunk: Buffer) => {
      session.output += chunk.toString("utf8");
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
      verificationUri: session.url,
      userCode: session.userCode,
      expiresAt: session.expiresAt,
      intervalMs: 1_000,
    };
  }

  async poll(input: { sessionId: string }): Promise<GeminiLoginPoll> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      return { status: "error", message: "Login session was not found. Start again." };
    }
    if (this.now() >= session.expiresAt) {
      await this.disposeSession(session);
      return { status: "error", message: "Sign-in expired, start again." };
    }
    if (session.settled === null || session.polling) return { status: "pending" };
    session.polling = true;
    try {
      if (session.settled.code !== 0) {
        await this.disposeSession(session);
        return { status: "error", message: "Gemini sign-in did not finish. Start again." };
      }
      const authenticated = await importGeminiCredentials(session.authFile);
      const account = session.targetAccountId !== undefined
        ? await this.options.reauthorizeAccount!(session.targetAccountId, authenticated)
        : await this.options.addAccount(authenticated);
      await this.disposeSession(session);
      return { status: "complete", account };
    } catch {
      await this.disposeSession(session);
      return { status: "error", message: "Gemini account could not be saved. Start again." };
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
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (session.url !== null || session.userCode !== null) return null;
      if (session.settled !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (session.settled !== null && session.settled.code !== 0) {
      return "Gemini sign-in did not start. Start again.";
    }
    return null;
  }

  private async disposeSession(session: LoginSession): Promise<void> {
    this.sessions.delete(session.sessionId);
    if (session.settled === null) session.child.kill();
    await rm(session.home, { recursive: true, force: true }).catch(() => undefined);
  }
}
