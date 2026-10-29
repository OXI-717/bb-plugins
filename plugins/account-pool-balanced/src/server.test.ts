import {vpnProof} from './vpn-test-fixture.js';
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_PROXIED_PATHS } from "./cursor-adapter.js";
import { DEVIN_PROXIED_PATHS } from "./devin-adapter.js";
import {
  accountSchema,
  accountSecretSchema,
  accountSummarySchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  routedThreadStatusListSchema,
  statusReportSchema,
  statusSchema,
  type AccountSummary,
} from "./contracts.js";
import { z } from "zod";
import * as accountBrowser from "./browser-profiles.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { AccountStore, HubTokenStore, QuotaStore } from "./store.js";
import { codexQuotaFromUsage } from './codex-adapter.js';
import {
  createAccountPoolPlugin as createAccountPoolPluginImpl,
  helloResponse,
  type AccountPoolPluginOptions,
} from "./server.js";

// These fake upstreams do not resolve DNS. Explicitly provide the same mock
// for the IPv4 path; production must never fall back to its ordinary fetch.
function createAccountPoolPlugin(options:AccountPoolPluginOptions={}) {
  return createAccountPoolPluginImpl({fetchIpv4:options.fetch,...options});
}

type UpstreamHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

interface Upstream {
  url: string;
  close: () => Promise<void>;
}

interface Fixture {
  dataDir: string;
  host: ReturnType<typeof createFakePluginHost>;
  service: ReturnType<
    ReturnType<typeof createFakePluginHost>["harness"]["behavior"]["runService"]
  >;
  key: string;
  account: AccountSummary;
}

const cleanups: Array<() => Promise<void>> = [];

function sdkStubs() {
  return {
    hosts: {
      list: async () => [
        {
          id: "host-one",
          name: "One",
        },
        {
          id: "host-two",
          name: "Two",
        },
      ],
    },
    system: {
      providerStates: async () => ({ providers: [] }),
    },
    plugins: {
      list: async () => ({
        plugins: [{ id: "account-pool", enabled: true }],
      }),
    },
  };
}

async function resolveToken(
  host: ReturnType<typeof createFakePluginHost>,
  hostId = "host-one",
  threadId = "thread-one",
): Promise<string> {
  const entries = await host.harness.behavior.resolveProviderEnv(
    "claude-code",
    { threadId, projectId: "project-one", hostId },
  );
  const token = entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
  if (token === undefined || typeof token.value !== "string") {
    throw new Error("Account Pool token was not resolved.");
  }
  return token.value;
}

async function resolveCodexToken(
  host: ReturnType<typeof createFakePluginHost>,
  hostId = "host-one",
): Promise<{ token: string; baseUrl: string }> {
  const entries = await host.harness.behavior.resolveProviderEnv("codex", {
    threadId: "thread-codex",
    projectId: "project-one",
    hostId,
  });
  const token = entries.find((entry) => entry.name === "CODEX_POOL_AUTH_TOKEN");
  const baseUrl = entries.find(
    (entry) => entry.name === "CODEX_OPENAI_BASE_URL",
  );
  if (token === undefined || typeof token.value !== "string") {
    throw new Error("Codex Account Pool token was not resolved.");
  }
  if (baseUrl === undefined || typeof baseUrl.value !== "object") {
    throw new Error("Codex Account Pool base URL was not resolved.");
  }
  return { token: token.value, baseUrl: baseUrl.value.serverPath };
}

async function resolveAcpEnv(
  host: ReturnType<typeof createFakePluginHost>,
  providerId: string,
  tokenName: string,
  baseUrlName: string,
  hostId = "host-one",
): Promise<{ token: string; baseUrl: string }> {
  const entries = await host.harness.behavior.resolveProviderEnv(providerId, {
    threadId: `thread-${providerId}`,
    projectId: "project-one",
    hostId,
  });
  const token = entries.find((entry) => entry.name === tokenName);
  const baseUrl = entries.find((entry) => entry.name === baseUrlName);
  if (token === undefined || typeof token.value !== "string") {
    throw new Error(`${providerId} Account Pool token was not resolved.`);
  }
  if (baseUrl === undefined || typeof baseUrl.value !== "object") {
    throw new Error(`${providerId} Account Pool base URL was not resolved.`);
  }
  return { token: token.value, baseUrl: baseUrl.value.serverPath };
}

async function resolveCursorToken(
  host: ReturnType<typeof createFakePluginHost>,
): Promise<string> {
  return (
    await resolveAcpEnv(
      host,
      "acp-oxi-cursor",
      "CURSOR_API_KEY",
      "CURSOR_API_ENDPOINT",
    )
  ).token;
}

function pytestUnreachable(): never {
  throw new Error("upstream must not be called for a local exchange");
}

async function resolveKimiEnv(
  host: ReturnType<typeof createFakePluginHost>,
  providerId = "acp-opencode-kimi",
): Promise<{ token: string; baseUrl: string }> {
  return resolveAcpEnv(host, providerId, "KIMI_API_KEY", "OXI_KIMI_BASE_URL");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.restoreAllMocks();
});

describe("account browser server wiring", () => {
  it("uses the selected account inventory, server paths and latest VPN setting", async () => {
    const launch = vi.spyOn(accountBrowser, "openAccountBrowser").mockRejectedValue(new Error("Synthetic launch stopped"));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example" });
    const vpnStatusFile = path.join(fixture.dataDir, "synthetic-vpn.json");
    await fixture.host.harness.behavior.callRpc("config.set", { vpnStatusFile });
    const url = "https://login.example/authorize?state=synthetic";
    await expect(fixture.host.harness.behavior.callRpc("browser.open", { accountId: fixture.account.id, url })).rejects.toThrow("Synthetic launch stopped");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ query: fixture.account.id, url, dataDir: fixture.dataDir, pluginId: "account-pool", vpnStatusFile }));
    expect(launch.mock.calls[0]![0].accounts.map(account => account.id)).toEqual([fixture.account.id]);
  });

  it("rejects an account removed from the inventory before touching browser files", async () => {
    const launch = vi.spyOn(accountBrowser, "openAccountBrowser").mockRejectedValue(new Error("Browser should not be invoked"));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example" });
    await fixture.host.harness.behavior.callRpc("account.remove", { id: fixture.account.id });
    await expect(fixture.host.harness.behavior.callRpc("browser.open", { accountId: fixture.account.id })).rejects.toThrow("Account no longer exists");
    expect(launch).not.toHaveBeenCalled();
  });
});

async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake upstream did not bind a TCP port.");
  }
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function importedCredentials(
  overrides: Partial<ImportedClaudeCredentials> = {},
): ImportedClaudeCredentials {
  return {
    accessToken: "oauth-access",
    refreshToken: "oauth-refresh",
    expiresAt: Date.now() + 60 * 60 * 1_000,
    subscriptionType: "max",
    rateLimitTier: "max_5x",
    email: "pool@example.com",
    accountUuid: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

function testJwt(payload: object): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

async function createFixture(args: {
  upstreamUrl: string;
  options?: AccountPoolPluginOptions;
  provider?: "claude" | "codex" | "kimi" | "zai" | "opencode-go" | "neuraldeep" | "cursor" | "devin";
  source?: "api-key" | "import";
  apiKey?: string;
  priority?: number;
  beforePlugin?: (host: Fixture["host"]) => void;
  callBrowserHost?: (request: {hostId:string;method:string;input:unknown})=>Promise<unknown>;
}): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-"));
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: sdkStubs(),
    ...(args.callBrowserHost ? {experimental_callHostRpc:args.callBrowserHost} : {}),
  });
  await host.bb.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: args.upstreamUrl,
    codexUpstreamBaseUrl: args.upstreamUrl,
    kimiUpstreamBaseUrl: args.upstreamUrl,
    zaiUpstreamBaseUrl: args.upstreamUrl,
    opencodeGoUpstreamBaseUrl: args.upstreamUrl,
    neuraldeepUpstreamBaseUrl: args.upstreamUrl,
    cursorUpstreamBaseUrl: args.upstreamUrl,
    devinUpstreamBaseUrl: args.upstreamUrl,
  });
  const plugin = createAccountPoolPlugin({
    vpnPayload: async (timestamp) => vpnProof(timestamp, "connected"),
    usageUrl: "data:application/json,{}",
    fetchIpv4:args.options?.fetch,
    ...args.options,
  });
  args.beforePlugin?.(host);
  await plugin(host.bb);
  const accountMetadata = accountSchema.parse(
    await host.harness.behavior.callRpc("account.add", {
      provider: args.provider ?? "claude",
      source:
        args.source === "import"
          ? { kind: "import" }
          : { kind: "api-key", apiKey: args.apiKey ?? "sk-account" },
      label: null,
      priority: args.priority ?? 100,
    }),
  );
  const service = host.harness.behavior.runService("hub");
  await vi.waitFor(async () => {
    const result = await host.harness.behavior.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(statusReportSchema.parse(JSON.parse(result.stdout)).accepting).toBe(
      true,
    );
  });
  const statusResult = await host.harness.behavior.runCli(["status", "--json"]);
  const status = statusReportSchema.parse(JSON.parse(statusResult.stdout));
  const account = status.accounts.find(
    (candidate) => candidate.id === accountMetadata.id,
  );
  if (account === undefined) throw new Error("Added account was not listed.");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const key =
    args.provider === "codex"
      ? (await resolveCodexToken(host)).token
      : args.provider === "kimi"
        ? (await resolveKimiEnv(host)).token
        : args.provider === "zai"
          ? (
              await resolveAcpEnv(
                host,
                "acp-opencode-zai",
                "ZAI_API_KEY",
                "OXI_ZAI_BASE_URL",
              )
            ).token
          : args.provider === "neuraldeep"
            ? (await resolveAcpEnv(host, "acp-opencode-neuraldeep", "NEURALDEEP_API_KEY", "OXI_NEURALDEEP_BASE_URL")).token
          : args.provider === "opencode-go"
            ? (
                await resolveAcpEnv(
                  host,
                  "acp-opencode-go",
                  "OPENCODE_API_KEY",
                  "OXI_OPENCODE_GO_BASE_URL",
                )
              ).token
            : args.provider === "cursor"
              ? await resolveCursorToken(host)
              : args.provider === "devin"
                ? await (async () => {
                    const output = path.join(dataDir, "devin-client.token");
                    const result = await host.harness.behavior.runCli(["client", "add", "devin-test", "--output", output]);
                    expect(result.exitCode).toBe(0);
                    return (await fs.readFile(output, "utf8")).trim();
                  })()
              : await resolveToken(host);
  return { dataDir, host, service, key, account };
}

async function createOAuthRequestFixture(
  provider: "claude" | "codex",
  upstreamFetch: typeof fetch,
  now: () => number,
): Promise<Fixture> {
  return createFixture({
    upstreamUrl: "https://upstream.example",
    provider,
    source: "import",
    options: {
      fetch: (input, init) =>
        String(input) === EMPTY_USAGE_URL
          ? Promise.resolve(Response.json({}))
          : upstreamFetch(input, init),
      now,
      refreshUrl: "https://upstream.example/oauth/token",
      codexRefreshUrl: "https://upstream.example/oauth/token",
      codexUsageUrl: EMPTY_USAGE_URL,
      importCredentials: async () =>
        importedCredentials({
          accessToken: "oauth-old",
          expiresAt: now() + 60 * 60 * 1_000,
        }),
      importCodexCredentials: async () => ({
        accessToken: "oauth-old",
        refreshToken: "oauth-refresh",
        idToken: null,
        accountId: "chatgpt-account",
        email: "codex@example.com",
        expiresAt: now() + 60 * 60 * 1_000,
      }),
    },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function authHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
}

async function addApiAccount(
  fixture: Fixture,
  apiKey: string,
  priority = 100,
): Promise<AccountSummary> {
  const added = accountSchema.parse(
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey },
      label: apiKey,
      priority,
    }),
  );
  const list = z
    .array(accountSummarySchema)
    .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
  const found = list.find((account) => account.id === added.id);
  if (found === undefined) throw new Error("Added account was not listed.");
  return found;
}

async function movePoolToOtherAccount(
  fixture: Fixture,
  provider: "claude" | "codex",
  disabledId = fixture.account.id,
): Promise<void> {
  await fixture.host.harness.behavior.callRpc("account.disable", {
    id: disabledId,
  });
  try {
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      provider === "claude" ? "/v1/messages" : "/v1/responses",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await fixture.host.harness.behavior.callRpc("account.enable", {
      id: disabledId,
    });
  }
}

const EMPTY_USAGE_URL = "data:application/json,{}";
const CODEX_USAGE_STUB_URL = "https://usage.example/wham/usage";

describe("Account Pool config schema", () => {
  it("fills defaults and rejects invalid URLs and thresholds", () => {
    expect(accountPoolConfigSchema.parse({})).toEqual({
      anthropicUpstreamBaseUrl: "https://api.anthropic.com",
      codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
      kimiUpstreamBaseUrl: "https://api.kimi.com/coding/v1",
      zaiUpstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4",
      opencodeGoUpstreamBaseUrl: "https://opencode.ai/zen/go/v1",
      neuraldeepUpstreamBaseUrl: "https://api.neuraldeep.ru/v1",
      cursorUpstreamBaseUrl: "https://api2.cursor.sh",
      devinUpstreamBaseUrl: "https://server.codeium.com",
      maxConcurrentRequestsPerAccount: 2,
      switchThreshold: 0.98,
      routingStrategy: "sequential",
      reserveDrainHours: 24,
      restDays: [0, 6],
      vpnOnlyProviders: ["codex", "claude", "cursor", "devin"],
      vpnStatusFile: null,
      browserHostId: null,
      vpnGuardEnabled: false,
      vpnPolicyVersion:2,
    });
    expect(
      accountPoolConfigSetInputSchema.safeParse({
        anthropicUpstreamBaseUrl: "ftp://example.com",
      }).success,
    ).toBe(false);
    expect(
      accountPoolConfigSetInputSchema.safeParse({ switchThreshold: 0 }).success,
    ).toBe(false);
    expect(
      accountPoolConfigSetInputSchema.safeParse({ switchThreshold: 1.01 })
        .success,
    ).toBe(false);
  });
});

describe("Account Pool plugin", () => {
  it("reads and updates one full config record through RPC and CLI", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-config-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({ vpnPayload: async (timestamp) => vpnProof(timestamp, "connected")})(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    expect(
      accountPoolConfigSchema.parse(
        await host.harness.behavior.callRpc("config.get", null),
      ),
    ).toEqual(accountPoolConfigSchema.parse({}));
    const cliGet = await host.harness.behavior.runCli(["config"]);
    expect(cliGet.exitCode).toBe(0);
    expect(cliGet.stdout).toContain(
      "anthropicUpstreamBaseUrl: https://api.anthropic.com",
    );
    expect(cliGet.stdout).toContain(
      "codexUpstreamBaseUrl: https://chatgpt.com/backend-api/codex",
    );
    expect(cliGet.stdout).toContain("switchThreshold: 0.98");

    const cliSet = await host.harness.behavior.runCli([
      "config",
      "set",
      "switchThreshold",
      "0.75",
    ]);
    expect(cliSet.exitCode).toBe(0);
    expect(cliSet.stdout).toContain("switchThreshold: 0.75");
    const updated = accountPoolConfigSchema.parse(
      await host.harness.behavior.callRpc("config.set", {
        anthropicUpstreamBaseUrl: "http://127.0.0.1:9000",
      }),
    );
    expect(updated).toEqual({
      anthropicUpstreamBaseUrl: "http://127.0.0.1:9000",
      codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
      kimiUpstreamBaseUrl: "https://api.kimi.com/coding/v1",
      zaiUpstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4",
      opencodeGoUpstreamBaseUrl: "https://opencode.ai/zen/go/v1",
      neuraldeepUpstreamBaseUrl: "https://api.neuraldeep.ru/v1",
      cursorUpstreamBaseUrl: "https://api2.cursor.sh",
      devinUpstreamBaseUrl: "https://server.codeium.com",
      maxConcurrentRequestsPerAccount: 2,
      switchThreshold: 0.75,
      routingStrategy: "sequential",
      reserveDrainHours: 24,
      restDays: [0, 6],
      vpnOnlyProviders: ["codex", "claude", "cursor", "devin"],
      vpnStatusFile: null,
      browserHostId: null,
      vpnGuardEnabled: false,
      vpnPolicyVersion:2,
    });
    expect(
      accountPoolConfigSchema.parse(await host.bb.storage.kv.get("config")),
    ).toEqual(updated);
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "config-changed",
      payload: {},
    });
  });

  it.each([
    {
      path: "images/generations",
      request: { prompt: "A fox astronaut", images: [] },
      result: { data: [{ b64_json: "generated-image" }] },
    },
    {
      path: "images/edits",
      request: { prompt: "A fox astronaut", images: [] },
      result: { data: [{ b64_json: "generated-image" }] },
    },
    {
      path: "alpha/search",
      request: {
        id: "search-1",
        model: "gpt-5.5",
        commands: { search_query: [{ q: "bb account pooler" }] },
      },
      result: { encrypted_output: "encrypted-search-output" },
    },
  ])(
    "routes native Codex $path with pool authentication",
    async ({ path, request, result }) => {
      const requests: Request[] = [];
      const fixture = await createOAuthRequestFixture(
        "codex",
        async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(result);
        },
        Date.now,
      );
      const route = `/v1/${path}`;
      const body = JSON.stringify(request);
      const denied = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        { body },
      );
      expect(denied.status).toBe(401);
      expect(requests).toHaveLength(0);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        {
          headers: {
            "content-type": "application/json",
            "x-bb-account-pool-token": fixture.key,
            authorization: "Bearer local-token",
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`https://upstream.example/${path}`);
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer oauth-old",
      );
      expect(requests[0]?.headers.get("chatgpt-account-id")).toBe(
        "chatgpt-account",
      );
      expect(requests[0]?.headers.has("x-bb-account-pool-token")).toBe(false);
      expect(await requests[0]?.text()).toBe(body);
    },
  );

  it.each(["acp-opencode-kimi", "acp-opencode-kimi-highspeed"])(
    "routes %s through the hub with a machine token instead of the subscription key",
    async (providerId) => {
      const requests: Request[] = [];
      const usageRequests: Request[] = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider: "kimi",
        source: "api-key",
        apiKey: "sk-kimi-subscription",
        options: {
          kimiUsagesUrl: "https://usages.example/coding/v1/usages",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.url.startsWith("https://usages.example/")) {
              usageRequests.push(request);
              return Response.json({
                usage: { limit: "100", used: "45", remaining: "55" },
              });
            }
            requests.push(request);
            return Response.json({ id: "message-one" });
          },
        },
      });
      const env = await resolveKimiEnv(fixture.host, providerId);
      expect(env.baseUrl).toBe("/api/v1/plugins/account-pool/http/kimi/v1");
      expect(env.token).not.toBe("sk-kimi-subscription");
      const body = JSON.stringify({ model: "k3-256k", messages: [] });
      const denied = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/kimi/v1/messages",
        { body },
      );
      expect(denied.status).toBe(401);
      expect(requests).toHaveLength(0);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/kimi/v1/messages",
        {
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": env.token,
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "message-one" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://upstream.example/messages");
      expect(requests[0]?.headers.get("x-api-key")).toBe(
        "sk-kimi-subscription",
      );
      expect(await requests[0]?.text()).toBe(body);
      expect(usageRequests.length).toBeGreaterThan(0);
      const quota = statusSchema
        .parse(await fixture.host.harness.behavior.callRpc("status.get", null))
        .accounts.find((account) => account.id === fixture.account.id);
      expect(quota?.sevenDayUtilization).toBe(0.45);
    },
  );

  it("routes the wrapper entry and leaves the built-in Cursor agent on its own login", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "cursor",
      source: "api-key",
      apiKey: "cursor-subscription-key",
      options: { fetch: async () => pytestUnreachable() },
    });
    const envFor = async (providerId: string) =>
      fixture.host.harness.behavior.resolveProviderEnv(providerId, {
        threadId: `thread-${providerId}`,
        projectId: "project-one",
        hostId: "host-one",
      });
    expect((await envFor("acp-oxi-cursor")).map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["CURSOR_API_ENDPOINT", "CURSOR_API_KEY", "CURSOR_POOL_RPC_GATEWAY", "AGENT_CLI_CREDENTIAL_STORE"]),
    );
    expect(await envFor("acp-cursor")).toEqual([]);
  });

  it("answers Cursor's key exchange with the machine's own pool token", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "cursor",
      source: "api-key",
      apiKey: "cursor-subscription-key",
      options: {
        cursorExchangeUrl: "https://exchange.example/auth/exchange_user_api_key",
        fetch: async () => pytestUnreachable(),
      },
    });
    const denied = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/cursor/auth/exchange_user_api_key",
      { body: "{}" },
    );
    expect(denied.status).toBe(401);
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/cursor/auth/exchange_user_api_key",
      {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fixture.key}`,
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    const exchanged = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    // The machine must end up holding its own revocable pool token, never the
    // subscription key and never a renewable Cursor credential.
    expect(exchanged.accessToken).toBe(fixture.key);
    expect(exchanged.refreshToken).toBe(fixture.key);
    expect(exchanged.accessToken).not.toBe("cursor-subscription-key");
  });

  it("omits unsupported Devin quota resources without removing the pooled account", async () => {
    const outbound = vi.fn(async () => Response.json({}));
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "devin",
      apiKey: "cog_test_pat",
      options: { fetch: outbound },
    });
    const supported = accountSchema.parse(await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "kimi",
      source: { kind: "api-key", apiKey: "kimi_test_key" },
      label: null,
      priority: 100,
    }));
    const inventory = await fixture.host.harness.behavior.callRpc("provider-usage.v1.listResources", {});
    expect(inventory).toMatchObject({ label: "Account Pooler", resources: [{ id: supported.id }] });
    const accounts = z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts.some(account => account.id === fixture.account.id && account.enabled)).toBe(true);
    outbound.mockClear(); // Ignore the supported account's initial quota collection.
    for (const refresh of [false, true]) {
      await expect(fixture.host.harness.behavior.callRpc("provider-usage.v1.getResource", {
        resourceId: fixture.account.id, refresh,
      })).rejects.toThrow("Quota reporting is not available for Devin.");
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it("routes Devin protobuf RPCs with the selected PAT and keeps the machine token upstream-private", async () => {
    const requests: Request[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "devin",
      apiKey: "cog_test_pat",
      options: { fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(Uint8Array.of(0x0a, 0x00), { headers: { "content-type": "application/proto" } });
      } },
    });
    const key = new TextEncoder().encode(fixture.key);
    const metadata = Uint8Array.of(0x1a, key.length, ...key);
    const body = Uint8Array.of(0x0a, metadata.length, ...metadata);
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST", "/devin/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      { headers: { authorization: `Basic ${fixture.key}-${"a".repeat(43)}`, "content-type": "application/proto" }, body: Buffer.from(body) },
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://upstream.example/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    expect(requests[0]?.headers.get("authorization")).toBe("Basic cog_test_pat");
    const upstreamBody = Buffer.from(await requests[0]!.arrayBuffer());
    expect(upstreamBody.includes(Buffer.from("cog_test_pat"))).toBe(true);
    expect(upstreamBody.includes(Buffer.from(fixture.key))).toBe(false);
    for (const rpcPath of DEVIN_PROXIED_PATHS) {
      const denied = await fixture.host.harness.behavior.fetchHttp("POST", `/devin/${rpcPath}`, { body: Buffer.from(body) });
      expect([rpcPath, denied.status]).toEqual([rpcPath, 401]);
    }
    expect((await fixture.host.harness.behavior.runCli(["routing", "devin", "--off"])).exitCode).toBe(0);
    const disabled = await fixture.host.harness.behavior.fetchHttp(
      "POST", "/devin/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      { headers: { authorization: `Basic ${fixture.key}`, "content-type": "application/proto" }, body: Buffer.from(body) },
    );
    expect(disabled.status).toBe(503);
    expect(requests).toHaveLength(1);
  });

  it("pins concurrent Devin RPCs from one CLI process under balanced routing", async () => {
    const requests: Request[] = [];
    const first = deferred();
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "devin",
      apiKey: "cog_first_synthetic",
      options: { fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (requests.length === 1) await first.promise;
        return new Response(Uint8Array.of(0x0a, 0x00), { headers: { "content-type": "application/proto" } });
      } },
    });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "devin", source: { kind: "api-key", apiKey: "cog_second_synthetic" }, label: null, priority: 101,
    });
    await fixture.host.harness.behavior.callRpc("config.set", { routingStrategy: "balanced" });
    const key = new TextEncoder().encode(fixture.key);
    const metadata = Uint8Array.of(0x1a, key.length, ...key);
    const body = Buffer.from(Uint8Array.of(0x0a, metadata.length, ...metadata));
    const rpcPath = "/devin/exa.seat_management_pb.SeatManagementService/GetUserStatus";
    const headers = { authorization: `Basic ${fixture.key}`, "content-type": "application/proto", "x-bb-devin-session": "synthetic-cli-session" };
    try {
      const one = fixture.host.harness.behavior.fetchHttp("POST", rpcPath, { headers, body });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const two = fixture.host.harness.behavior.fetchHttp("POST", rpcPath, { headers, body });
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      first.resolve();
      expect((await one).status).toBe(200);
      expect((await two).status).toBe(200);
      expect(requests[0]?.headers.get("authorization")).toBe(requests[1]?.headers.get("authorization"));
    } finally {
      first.resolve();
    }
  });

  it.each(["agent.v1.AgentService/RunSSE", "aiserver.v2.FutureService/NewToolPermission"])("mints and isolates Cursor authorization for %s", async (rpcPath) => {
    const requests: Request[] = [];
    let exchanges = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "cursor",
      source: "api-key",
      apiKey: "cursor-subscription-key",
      options: {
        cursorExchangeUrl: "https://exchange.example/auth/exchange_user_api_key",
        cursorUsageUrl: "https://usage.example/GetCurrentPeriodUsage",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.url.startsWith("https://usage.example/")) {
            return Response.json({ planUsage: { totalPercentUsed: 10 } });
          }
          if (request.url.startsWith("https://exchange.example/")) {
            exchanges += 1;
            expect(request.headers.get("authorization")).toBe(
              "Bearer cursor-subscription-key",
            );
            return Response.json({
              accessToken: "minted-access-token",
              refreshToken: "minted-refresh-token",
            });
          }
          requests.push(request);
          return Response.json({ ok: true });
        },
      },
    });
    const body = JSON.stringify({ prompt: "probe" });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/cursor/rpc",
      {
        headers: {
          "content-type": "application/connect+proto",
          authorization: `Bearer ${fixture.key}`,
          "x-cursor-streaming": "true",
          "accept-encoding": "gzip",
          "content-encoding": "gzip",
          "x-unrelated-header": "dropped",
          "x-bb-cursor-rpc-path": rpcPath,
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    await response.json();
    expect(exchanges).toBeGreaterThanOrEqual(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://upstream.example/${rpcPath}`,
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer minted-access-token",
    );
    expect(requests[0]?.headers.get("x-cursor-streaming")).toBe("true");
    // Compression must not be negotiated upstream: the hub drops `content-encoding` on
    // the way back, and the client would be handed gzip it cannot account for.
    expect(requests[0]?.headers.has("accept-encoding")).toBe(false);
    // The body travels untouched, so its own encoding header has to travel with it.
    expect(requests[0]?.headers.get("content-encoding")).toBe("gzip");
    expect(requests[0]?.headers.has("x-unrelated-header")).toBe(false);
    expect(requests[0]?.headers.has("x-bb-cursor-rpc-path")).toBe(false);
    expect(await requests[0]?.text()).toBe(body);
  });

  it("routes NeuralDeep with server credentials and preserves native Chat/SSE", async () => {
    const requests: Request[] = [];
    const fixture = await createFixture({upstreamUrl:"https://upstream.example/v1",provider:"neuraldeep",apiKey:"synthetic-neuraldeep-key",options:{fetch:async(input, init)=>{
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/limits")) return Response.json({});
      return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {headers:{"content-type":"text/event-stream"}});
    }}});
    const body = JSON.stringify({model:"qwen3.6-unlim-xl",messages:[{role:"user",content:"synthetic"}],stream:true});
    const response = await fixture.host.harness.behavior.fetchHttp("POST", "/neuraldeep/v1/chat/completions", {headers:authHeaders(fixture.key),body});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("[DONE]");
    const sent = requests.find(request=>new URL(request.url).pathname.endsWith("/chat/completions"))!;
    expect(sent.url).toBe("https://upstream.example/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer synthetic-neuraldeep-key");
    expect(fixture.key).not.toBe("synthetic-neuraldeep-key");
    expect(await sent.text()).toBe(body);
    const status = statusReportSchema.parse(JSON.parse((await fixture.host.harness.behavior.runCli(["status","--json"])).stdout));
    const quota = status.accounts.find(account=>account.id===fixture.account.id)!;
    expect(JSON.stringify(quota)).not.toContain("synthetic-neuraldeep-key");
  });

  it("keeps NeuralDeep project and issued-purpose admission ahead of upstream dispatch", async () => {
    let calls = 0;
    const fixture = await createFixture({upstreamUrl:"https://upstream.example/v1",provider:"neuraldeep",apiKey:"synthetic-neuraldeep-key",options:{fetch:async()=>{calls++;return Response.json({});}}});
    const tokenFile = path.join(fixture.dataDir,"purpose-client.token");
    const issued = await fixture.host.harness.behavior.runCli(["client","add","fixture-client","--project","fixture-project","--purpose","autopilot","--output",tokenFile]);
    expect(issued.exitCode).toBe(0);
    const token = (await fs.readFile(tokenFile,"utf8")).trim();
    const before = calls;
    const body = JSON.stringify({model:"qwen3.6-unlim-xl",messages:[]});
    const denied = await fixture.host.harness.behavior.fetchHttp("POST","/neuraldeep/v1/chat/completions",{headers:authHeaders(token),body});
    expect(denied.status).toBe(403);
    expect(denied.headers.get("x-bb-pool-error")).toBe("POOL_ACCOUNT_POLICY");
    expect(calls).toBe(before);
    // A client-supplied purpose label cannot elevate an invalid credential.
    const foreign = await fixture.host.harness.behavior.fetchHttp("POST","/neuraldeep/v1/chat/completions",{headers:{...authHeaders("synthetic-invalid"),"x-purpose":"autopilot"},body});
    expect(foreign.status).toBe(401);
    expect(calls).toBe(before);
    const unknown = statusReportSchema.parse(JSON.parse((await fixture.host.harness.behavior.runCli(["status","--json"])).stdout)).accounts.find(account=>account.id===fixture.account.id)!;
    expect(unknown.fiveHourUtilization).toBeNull();
    expect(unknown.sevenDayUtilization).toBeNull();
  });

  it("background Go usage rejection persists sanitized key expiry", async () => {
    let expired = false;
    const fixture = await createFixture({upstreamUrl:"https://upstream.example",provider:"opencode-go",apiKey:"synthetic-go-key",options:{fetch:async()=> expired
      ? Response.json({error:{type:"authentication_error",code:"api_key_expired",message:"synthetic-private-value"}},{status:403})
      : Response.json({}) }});
    expired = true;
    const result = await fixture.host.harness.behavior.runCli(["account","refresh",fixture.account.id]);
    expect(result.exitCode).not.toBe(0);
    const status = statusReportSchema.parse(JSON.parse((await fixture.host.harness.behavior.runCli(["status","--json"])).stdout));
    const account = status.accounts.find(account=>account.id===fixture.account.id)!;
    expect(account.status).toBe("error");
    expect(account.error).toContain("API_KEY_EXPIRED");
    expect(account.error).not.toContain("synthetic-private-value");
    expect(account.eligible).toBe(false);
  });

  it.each([429,403])('labels a hold after HTTP %s without guessing its cause',async status=>{
    let calls=0;
    const now=Date.parse('2026-09-17T09:00:00Z');
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',provider:'opencode-go',source:'api-key',apiKey:'synthetic-go-key',options:{now:()=>now,opencodeGoUsagesUrl:'https://usages.example/zen/go/v1/usage',fetch:async(input,init)=>{
      if(new Request(input,init).url.startsWith('https://usages.example/'))return Response.json({usage:{rolling:{percent:0},weekly:{percent:0}}});
      calls++;return Response.json({error:{message:'Upstream refused'}},{status,headers:{'retry-after':'86400',...(status===403?{'content-type':'text/html'}:{})}});
    }}});
    await fixture.host.harness.behavior.callRpc('config.set',{routingStrategy:'balanced'});
    const send=(signal?:AbortSignal)=>fixture.host.harness.behavior.fetchHttp('POST','/opencode-go/v1/chat/completions',{headers:authHeaders(fixture.key),body:JSON.stringify({model:'synthetic-model',messages:[]}),signal});
    await (await send()).text();
    const held=await send(AbortSignal.timeout(30));
    expect(held.status).toBe(499);
    const account=statusSchema.parse(await fixture.host.harness.behavior.callRpc('status.get',null)).accounts[0]!;
    expect(account.status).toBe('held');
    expect(new Date(account.heldUntil!).toISOString()).toBe(status===429?'2026-09-18T09:00:00.000Z':'2026-09-17T09:01:00.000Z');
    expect(calls).toBe(1);
  });
  it('shows all three Go quota windows in the BB usage resource',async()=>{
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',provider:'opencode-go',source:'api-key',apiKey:'synthetic-go-key',options:{opencodeGoUsagesUrl:'https://usages.example/zen/go/v1/usage',fetch:async()=>Response.json({usage:{rolling:{percent:0},weekly:{percent:0},monthly:{percent:100,status:'rate-limited',resetsAt:'2099-01-01T00:00:00Z'}}})}});
    const resource=z.object({usage:z.object({windows:z.array(z.object({label:z.string()}))})}).parse(await fixture.host.harness.behavior.callRpc('provider-usage.v1.getResource',{resourceId:fixture.account.id,refresh:true}));
    expect(resource.usage.windows.map(w=>w.label).sort()).toEqual(['Five-hour limit','Monthly limit','Weekly limit']);
  });

  it("refuses outright when the pooled subscription is spent for days", async () => {
    const requests: Request[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "opencode-go",
      source: "api-key",
      apiKey: "sk-go",
      options: {
        opencodeGoUsagesUrl: "https://usages.example/zen/go/v1/usage",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.url.startsWith("https://usages.example/")) {
            // Weekly window spent; the next reset is days away.
            return Response.json({
              usage: {
                rolling: { percent: 4 },
                weekly: {
                  percent: 100,
                  resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
                },
              },
            });
          }
          requests.push(request);
          return Response.json({ ok: true });
        },
      },
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/opencode-go/v1/chat/completions",
      {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fixture.key}`,
        },
        body: JSON.stringify({ model: "glm-5.3", messages: [] }),
      },
    );
    // The symptom this replaces: a 429 with a multi-day `retry-after`, which coding
    // agents obey in silence — the thread hangs and reports nothing at all.
    expect(response.status).toBe(403);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toContain("exhausted");
    expect(requests).toHaveLength(0);
  });

  it.each(["application/proto", "application/connect+proto"])("reports Cursor pool threshold in %s without contacting model upstream", async contentType => {
    const modelCalls: string[] = [];
    const fixture = await createFixture({upstreamUrl:"https://upstream.example",provider:"cursor",source:"api-key",apiKey:"synthetic-cursor-key",options:{
      cursorExchangeUrl:"https://exchange.example/auth/exchange_user_api_key",cursorUsageUrl:"https://usage.example/GetCurrentPeriodUsage",
      fetch:async (input,init)=>{const request=new Request(input,init);
        if(request.url.startsWith("https://exchange.example/"))return Response.json({accessToken:"synthetic-token"});
        if(request.url.startsWith("https://usage.example/"))return Response.json({billingCycleEnd:Date.now()+86400000,planUsage:{totalPercentUsed:93.5}});
        modelCalls.push(request.url);return Response.json({ok:true});
      }
    }});
    await fixture.host.harness.behavior.callRpc("config.set",{switchThreshold:0.9});
    await fixture.host.harness.behavior.callRpc("account.refreshUsage",{accountId:fixture.account.id});
    const response=await fixture.host.harness.behavior.fetchHttp("POST","/cursor/agent.v1.AgentService/Run",{headers:{authorization:`Bearer ${fixture.key}`,"content-type":contentType},body:new Uint8Array()});
    expect(response.headers.get("x-bb-pool-error")).toBe("POOL_QUOTA_THRESHOLD");
    expect(response.headers.get("retry-after")).toBeNull();
    const bytes=Buffer.from(await response.arrayBuffer());
    const payload=contentType.includes("connect+")?JSON.parse(bytes.subarray(5).toString()).error:JSON.parse(bytes.toString());
    expect(payload).toMatchObject({code:"permission_denied"});
    expect(payload.message).toContain("93.5%");expect(payload.message).toContain("90%");
    expect(modelCalls).toEqual([]);
  });

  it.each([200,401])('checks Claude authorization on enable and reports repeated usage HTTP %s',async finalStatus=>{
    let rejectUsage=false;
    let refreshCalls=0;
    const fixture=await createFixture({upstreamUrl:'https://fixture.example',source:'import',options:{
      importCredentials:async()=>importedCredentials({expiresAt:null}),
      refreshUrl:'https://refresh.example',
      fetch:async(input,init)=>{
        if(String(input)==='https://refresh.example'){
          refreshCalls++;
          return Response.json({access_token:'test-access',refresh_token:'test-refresh',expires_in:3600});
        }
        if(rejectUsage&& (new Headers(init?.headers).get('authorization')!=='Bearer test-access'||finalStatus===401)) return new Response(null,{status:401});
        return Response.json({seven_day:{utilization:10}});
      },
    }});
    await fixture.host.harness.behavior.callRpc('account.disable',{id:fixture.account.id});
    rejectUsage=true;
    await fixture.host.harness.behavior.callRpc('account.enable',{id:fixture.account.id});
    const current=(await fixture.host.harness.behavior.callRpc('account.list',null) as AccountSummary[])[0]!;
    expect(refreshCalls).toBe(1);
    expect(current.enabled).toBe(true);
    if(finalStatus===401){expect(current.status).toBe('error');expect(current.error).toContain('OAUTH_REAUTH_REQUIRED');}
    else {expect(current.error).toBeNull();}
  });

  it.each([true,false])('persists terminal Claude OAuth refusal from quota refresh for enabled=%s',async enabled=>{
    const fixture=await createFixture({upstreamUrl:'https://fixture.example',source:'import',options:{importCredentials:async()=>importedCredentials({expiresAt:Date.now()+1000}),refreshUrl:'https://refresh.example',fetch:async()=>Response.json({error:'invalid_grant',error_description:'never-display-this-value'},{status:400})}});
    if(!enabled)await fixture.host.harness.behavior.callRpc('account.disable',{id:fixture.account.id});
    await expect(fixture.host.harness.behavior.callRpc('account.refreshUsage',{accountId:fixture.account.id})).rejects.toThrow('OAUTH_REAUTH_REQUIRED');
    const account=(await fixture.host.harness.behavior.callRpc('account.list',null) as AccountSummary[])[0];
    expect(account).toMatchObject({enabled,status:enabled?'error':'disabled',eligible:false});
    expect(account?.error).toContain('invalid_grant');
    expect(account?.error).not.toContain('never-display-this-value');
  });

  it.each([true,false])('reauthorizes an existing Claude account without resetting enabled=%s or settings',async enabled=>{
    const uuid='00000000-0000-4000-8000-000000000001';let profileUuid=uuid;
    const fixture=await createFixture({upstreamUrl:'https://fixture.example',source:'import',options:{
      importCredentials:async()=>importedCredentials({accountUuid:uuid,email:'fixture@example.com'}),
      oauthTokenUrl:'https://login.example/token',oauthProfileUrl:'https://login.example/profile',
      fetch:async input=>String(input).includes('/token')?Response.json({access_token:'new-fixture-access',refresh_token:'new-fixture-refresh',expires_in:3600}):String(input).includes('/profile')?Response.json({account:{uuid:profileUuid,email:'fixture@example.com'}}):Response.json({seven_day:{utilization:10}}),
    }});
    await fixture.host.harness.behavior.callRpc('account.setRole',{accountId:fixture.account.id,role:'reserve'});
    await fixture.host.harness.behavior.callRpc('account.setPriority',{accountId:fixture.account.id,priority:7});
    const projects={onlySelected:true,rules:[{projectId:'project-fixture',role:'primary'}]};
    const policy={enabled:true,weeklyKeep:50};
    await fixture.host.harness.behavior.callRpc('account.setProjects',{accountId:fixture.account.id,projects});
    await fixture.host.harness.behavior.callRpc('account.setPolicy',{accountId:fixture.account.id,policy});
    if(!enabled)await fixture.host.harness.behavior.callRpc('account.disable',{id:fixture.account.id});
    const before=(await fixture.host.harness.behavior.callRpc('account.list',null) as AccountSummary[])[0]!;
    const started=await fixture.host.harness.behavior.callRpc('login.reauthorize',{accountId:fixture.account.id}) as {sessionId:string;authorizeUrl:string};
    const state=new URL(started.authorizeUrl).searchParams.get('state');
    await fixture.host.harness.behavior.callRpc('login.complete',{sessionId:started.sessionId,pasted:`fixture-code#${state}`});
    const after=(await fixture.host.harness.behavior.callRpc('account.list',null) as AccountSummary[]);
    expect(after).toHaveLength(1);expect(after[0]).toMatchObject({id:before.id,enabled,priority:7,role:'reserve',label:before.label,createdAt:before.createdAt});
    const store=new AccountStore(fixture.host.bb.storage.kv,path.join(fixture.dataDir,'plugins',fixture.host.bb.pluginId,'secrets','accounts'));
    expect((await store.get(before.id))?.projects).toEqual(projects);
    expect((await store.get(before.id))?.policy).toMatchObject(policy);
    const authorization=await store.readSecret(before.id);
    // The identity mismatch must leave the currently stored authorization intact.
    profileUuid='00000000-0000-4000-8000-000000000002';
    const next=await fixture.host.harness.behavior.callRpc('login.reauthorize',{accountId:before.id}) as {sessionId:string;authorizeUrl:string};
    await expect(fixture.host.harness.behavior.callRpc('login.complete',{sessionId:next.sessionId,pasted:`other-code#${new URL(next.authorizeUrl).searchParams.get('state')}`})).rejects.toThrow('different account');
    expect((await store.get(before.id))?.id).toBe(before.id);
    expect(await store.readSecret(before.id)).toEqual(authorization);
    const removed=await fixture.host.harness.behavior.callRpc('login.reauthorize',{accountId:before.id}) as {sessionId:string;authorizeUrl:string};
    await fixture.host.harness.behavior.callRpc('account.remove',{id:before.id});
    await expect(fixture.host.harness.behavior.callRpc('login.complete',{sessionId:removed.sessionId,pasted:`removed-code#${new URL(removed.authorizeUrl).searchParams.get('state')}`})).rejects.toThrow('no longer exists');
    expect(await fixture.host.harness.behavior.callRpc('account.list',null)).toEqual([]);
  });

  it('finishes an old failing quota check before replacing Claude authorization',async()=>{
    const uuid='00000000-0000-4000-8000-000000000001';
    const started=deferred(),release=deferred(),profileSeen=deferred();
    let rejectOld=false;
    const fixture=await createFixture({upstreamUrl:'https://fixture.example',source:'import',options:{
      importCredentials:async()=>importedCredentials({accountUuid:uuid,email:'fixture@example.com',expiresAt:null}),
      refreshUrl:'https://refresh.example',oauthTokenUrl:'https://login.example/token',oauthProfileUrl:'https://login.example/profile',
      fetch:async(input,init)=>{
        const url=String(input);
        if(url==='https://refresh.example')return Response.json({error:'invalid_grant'},{status:400});
        if(url.includes('/token'))return Response.json({access_token:'new-fixture-access',refresh_token:'new-fixture-refresh',expires_in:3600});
        if(url.includes('/profile')){profileSeen.resolve();return Response.json({account:{uuid,email:'fixture@example.com'}});}
        if(rejectOld&&new Headers(init?.headers).get('authorization')!=='Bearer new-fixture-access'){
          started.resolve();await release.promise;return new Response(null,{status:401});
        }
        return Response.json({seven_day:{utilization:10}});
      },
    }});
    rejectOld=true;
    const oldCheck=fixture.host.harness.behavior.callRpc('account.refreshUsage',{accountId:fixture.account.id}).catch(()=>undefined);
    await started.promise;
    const login=await fixture.host.harness.behavior.callRpc('login.reauthorize',{accountId:fixture.account.id}) as {sessionId:string;authorizeUrl:string};
    let completed=false;
    const replacement=fixture.host.harness.behavior.callRpc('login.complete',{sessionId:login.sessionId,pasted:`race-code#${new URL(login.authorizeUrl).searchParams.get('state')}`}).then(()=>{completed=true;});
    await profileSeen.promise;
    await new Promise(resolve=>setImmediate(resolve));
    expect(completed).toBe(false);
    release.resolve();await oldCheck;await replacement;
    const current=(await fixture.host.harness.behavior.callRpc('account.list',null) as AccountSummary[])[0]!;
    expect(current.error).toBeNull();
    expect(current.id).toBe(fixture.account.id);
  });

  it('does not let a delayed usage refusal poison access restored by a model request',async()=>{
    const seen=deferred(),release=deferred();let rejectUsage=false;let rotations=0;
    const fixture=await createFixture({upstreamUrl:'https://model.example',source:'import',options:{
      importCredentials:async()=>importedCredentials({expiresAt:null}),
      usageUrl:'https://usage.example',refreshUrl:'https://refresh.example',
      fetch:async(input,init)=>{
        const request=new Request(input,init);const authorization=request.headers.get('authorization');
        if(request.url.startsWith('https://refresh.example')){
          rotations++;return Response.json({access_token:rotations===1?'test-B':'test-C',refresh_token:'refresh',expires_in:3600});
        }
        if(request.url.startsWith('https://usage.example')){
          if(!rejectUsage)return Response.json({seven_day:{utilization:10}});
          if(authorization==='Bearer test-B'){seen.resolve();await release.promise;}
          return new Response(null,{status:401});
        }
        if(request.url.startsWith('https://model.example'))return authorization==='Bearer test-C'?Response.json({ok:true}):new Response(null,{status:401});
        return Response.json({});
      },
    }});
    rejectUsage=true;
    const check=fixture.host.harness.behavior.callRpc('account.refreshUsage',{accountId:fixture.account.id}).catch(error=>String(error));
    await seen.promise;
    const model=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});
    expect(model.status).toBe(200);await model.text();
    release.resolve();
    expect(await check).toContain('Authorization changed');
    const current=(await fixture.host.harness.behavior.callRpc('account.list',null) as AccountSummary[])[0]!;
    expect(rotations).toBe(2);
    expect(current.error).toBeNull();
  });

  it.each([true, false])("refreshes Cursor billing quotas for enabled=%s accounts on manual request", async (enabled) => {
    let usageCalls = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "cursor",
      source: "api-key",
      apiKey: "cursor-subscription-key",
      options: {
        cursorExchangeUrl: "https://exchange.example/auth/exchange_user_api_key",
        cursorUsageUrl: "https://usage.example/GetCurrentPeriodUsage",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.url.startsWith("https://exchange.example/")) {
            return Response.json({
              accessToken: "minted-access-token",
              refreshToken: "minted-refresh-token",
            });
          }
          if (request.url.startsWith("https://usage.example/")) {
            usageCalls += 1;
            expect(request.headers.get("authorization")).toBe(
              "Bearer minted-access-token",
            );
            expect(request.headers.get("connect-protocol-version")).toBe("1");
            return Response.json({
              billingCycleEnd: 1791981275000,
              planUsage: { totalPercentUsed: 26.76969696969697 },
            });
          }
          return Response.json({ ok: true });
        },
      },
    });
    if (!enabled) await fixture.host.harness.behavior.callRpc("account.disable", { id: fixture.account.id });
    const before = usageCalls;
    await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: fixture.account.id,
    });
    const account = statusSchema
      .parse(await fixture.host.harness.behavior.callRpc("status.get", null))
      .accounts.find((candidate) => candidate.id === fixture.account.id);
    expect(account?.sevenDayUtilization).toBeCloseTo(0.2677, 4);
    expect(account?.sevenDayResetAt).toBe(1791981275000);
    expect(account?.enabled).toBe(enabled);
    expect(usageCalls).toBe(before + 1);
  });

  it("mounts every Cursor path the CLI is known to call", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "cursor",
      source: "api-key",
      apiKey: "cursor-subscription-key",
      options: {
        cursorExchangeUrl: "https://exchange.example/auth/exchange_user_api_key",
        fetch: async () => Response.json({ ok: true }),
      },
    });
    // Pinned deliberately: iterating only the source list would pass even if a path were
    // dropped from it, and a dropped path is invisible until Cursor 404s on a machine.
    expect([...CURSOR_PROXIED_PATHS].sort()).toEqual(
      [
        "agent.v1.AgentService/GetUsableModels",
        "agent.v1.AgentService/Run",
        "agent.v1.AgentService/RunPoll",
        "agent.v1.AgentService/RunSSE",
        "aiserver.v1.AiService/AvailableModels",
        "aiserver.v1.AiService/GetDefaultModelForCli",
        "aiserver.v1.AiService/GetUsableModels",
        "aiserver.v1.AiService/NameAgent",
        "aiserver.v1.AnalyticsService/BootstrapStatsig",
        "aiserver.v1.AnalyticsService/TrackEvents",
        "aiserver.v1.AnalyticsService/SubmitLogs",
        "aiserver.v1.DashboardService/ListMarketplaces",
        "aiserver.v1.DashboardService/RegisterMarketplaceAndPlugins",
        "aiserver.v1.DashboardService/GetEffectiveUserPlugins",
        "aiserver.v1.DashboardService/GetCliDownloadUrl",
        "aiserver.v1.DashboardService/GetGlobalCommands",
        "aiserver.v1.DashboardService/GetManagedSkills",
        "aiserver.v1.DashboardService/GetMe",
        "aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
        "aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam",
        "v1/traces",
        "aiserver.v1.BidiService/BidiAppend",
        "aiserver.v1.DashboardService/GetCurrentPeriodUsage",
        "aiserver.v1.DashboardService/GetPlanInfo",
        "aiserver.v1.DashboardService/GetUserPrivacyMode",
        "aiserver.v1.ServerConfigService/GetServerConfig",
        "auth/exchange_user_api_key",
        "settings",
        "v1/bundle/archive",
      ].sort(),
    );
    // The plugin router matches paths exactly, so an unmounted path 404s and Cursor
    // breaks on the machine with no useful signal. Every catalogued path must answer.
    for (const path of CURSOR_PROXIED_PATHS) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        `/cursor/${path}`,
        { body: "{}" },
      );
      expect([path, response.status]).toEqual([path, 401]);
    }
  });

  it("forwards the OpenCode session header and hides the pool token from Go", async () => {
    const requests: Request[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "opencode-go",
      source: "api-key",
      apiKey: "sk-go-subscription",
      options: {
        opencodeGoUsagesUrl: "https://usages.example/zen/go/v1/usage",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.url.startsWith("https://usages.example/")) {
            return Response.json({
              usage: { rolling: { percent: 4 }, weekly: { percent: 72 } },
            });
          }
          requests.push(request);
          return Response.json({ id: "completion-one" });
        },
      },
    });
    const body = JSON.stringify({ model: "glm-5.3", messages: [] });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/opencode-go/v1/chat/completions",
      {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fixture.key}`,
          "x-opencode-session": "session-one",
          "x-unrelated-header": "dropped",
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "completion-one" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://upstream.example/chat/completions",
    );
    expect(requests[0]?.headers.get("x-opencode-session")).toBe("session-one");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer sk-go-subscription",
    );
    expect(requests[0]?.headers.has("x-unrelated-header")).toBe(false);
  });

  describe("opencode-go provider-specific wire path normalization", () => {
    const CHAT_BODY = JSON.stringify({
      model: "mimo-v2.6-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    const RESPONSES_BODY = JSON.stringify({
      model: "mimo-v2.6-pro",
      input: "hi",
      instructions: "be brief",
    });
    const AMBIGUOUS_BODY = JSON.stringify({ model: "mimo-v2.6-pro" });

    function opencodeGoFixture(upstreamFetch: typeof fetch) {
      return createFixture({
        upstreamUrl: "https://upstream.example",
        provider: "opencode-go",
        source: "api-key",
        apiKey: "sk-go-subscription",
        options: {
          opencodeGoUsagesUrl: "https://usages.example/zen/go/v1/usage",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.url.startsWith("https://usages.example/")) {
              return Response.json({
                usage: { rolling: { percent: 4 }, weekly: { percent: 72 } },
              });
            }
            return upstreamFetch(input, init);
          },
        },
      });
    }

    it("I1: inbound /responses reaches upstream /chat/completions", async () => {
      const requests: Request[] = [];
      const fixture = await opencodeGoFixture(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "completion-one" });
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/opencode-go/v1/responses",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
          },
          body: CHAT_BODY,
        },
      );
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://upstream.example/chat/completions",
      );
    });

    it("I2: native /chat/completions remains unchanged (not double rewritten)", async () => {
      const requests: Request[] = [];
      const fixture = await opencodeGoFixture(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "completion-one" });
      });
      await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/opencode-go/v1/chat/completions",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
          },
          body: CHAT_BODY,
        },
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://upstream.example/chat/completions",
      );
    });

    it("I3: /models remains unchanged", async () => {
      const requests: Request[] = [];
      const fixture = await opencodeGoFixture(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ data: [] });
      });
      await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/opencode-go/v1/models",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
          },
          body: "{}",
        },
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://upstream.example/models");
    });

    it("I4: query string and streaming SSE bytes are preserved across the rewrite", async () => {
      const requests: Request[] = [];
      const first = Buffer.from('event: response.created\ndata: {"one":1}\n\n');
      const second = Buffer.from(
        'event: response.completed\ndata: {"two":2}\n\n',
      );
      const fixture = await opencodeGoFixture(async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(first));
              setTimeout(() => {
                controller.enqueue(new Uint8Array(second));
                controller.close();
              }, 20);
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/opencode-go/v1/responses?stream=true&a=1&b=2",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
          },
          body: CHAT_BODY,
        },
      );
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://upstream.example/chat/completions?stream=true&a=1&b=2",
      );
      const received = Buffer.from(await response.arrayBuffer());
      expect(received.equals(Buffer.concat([first, second]))).toBe(true);
    });

    it("I5: body bytes, headers and auth are preserved across the rewrite", async () => {
      const requests: Request[] = [];
      const fixture = await opencodeGoFixture(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "completion-one" });
      });
      await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/opencode-go/v1/responses",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
            "x-opencode-session": "session-one",
            "x-unrelated-header": "dropped",
          },
          body: CHAT_BODY,
        },
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://upstream.example/chat/completions",
      );
      expect(await requests[0]?.text()).toBe(CHAT_BODY);
      expect(requests[0]?.headers.get("x-opencode-session")).toBe("session-one");
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer sk-go-subscription",
      );
      expect(requests[0]?.headers.get("content-type")).toBe("application/json");
      expect(requests[0]?.headers.has("x-unrelated-header")).toBe(false);
    });

    it("I6: Responses body on /responses is refused with 400 unsupported_wire_protocol and never forwarded", async () => {
      const requests: Request[] = [];
      const fixture = await opencodeGoFixture(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "must-not-happen" });
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/opencode-go/v1/responses",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
          },
          body: RESPONSES_BODY,
        },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as {
        error: { type: string; code: string; message: string };
      };
      expect(payload.error.code).toBe("unsupported_wire_protocol");
      expect(payload.error.type).toBe("invalid_request_error");
      expect(payload.error.message).toContain("chat/completions");
      expect(requests).toHaveLength(0);
    });

    it("I7: ambiguous body on /responses fails closed (400, never forwarded)", async () => {
      const requests: Request[] = [];
      const fixture = await opencodeGoFixture(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "must-not-happen" });
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/opencode-go/v1/responses",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
          },
          body: AMBIGUOUS_BODY,
        },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as {
        error: { code: string };
      };
      expect(payload.error.code).toBe("unsupported_wire_protocol");
      expect(requests).toHaveLength(0);
    });

    it("I8: zai /responses is never rewritten to chat/completions", async () => {
      const requests: Request[] = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider: "zai",
        source: "api-key",
        apiKey: "sk-zai-subscription",
        options: {
          zaiUsagesUrl: "https://usages.example/zai/usage",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.url.startsWith("https://usages.example/")) {
              return Response.json({
                usage: { rolling: { percent: 4 }, weekly: { percent: 72 } },
              });
            }
            requests.push(request);
            return Response.json({ id: "zai-completion" });
          },
        },
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/zai/v1/responses",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fixture.key}`,
          },
          body: RESPONSES_BODY,
        },
      );
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://upstream.example/responses");
    });

    it("I9: codex /responses is never rewritten to chat/completions", async () => {
      const requests: Request[] = [];
      const fixture = await createOAuthRequestFixture(
        "codex",
        async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json({ id: "codex-completion" });
        },
        Date.now,
      );
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: {
            "content-type": "application/json",
            "x-bb-account-pool-token": fixture.key,
          },
          body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi" }),
        },
      );
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://upstream.example/responses");
    });
  });

  it("imports, refreshes, and routes Codex HTTP sessions by provider", async () => {
    const seen: Array<{
      path: string;
      authorization: string | undefined;
      accountId: string | undefined;
      body: string;
    }> = [];
    const modelRequests: string[] = [];
    let responseNumber = 0;
    const futureToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString("base64url")}.signature`;
    const upstream = await startUpstream(async (request, response) => {
      const body = (await readRequestBody(request)).toString("utf8");
      if (request.url === "/oauth") {
        const parsed = z
          .object({
            client_id: z.literal("app_EMoamEEZ73f0CkXaXp7hrann"),
            grant_type: z.literal("refresh_token"),
            refresh_token: z.string(),
          })
          .parse(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: futureToken,
            refresh_token: `next-${parsed.refresh_token}`,
            id_token: "next-id-token",
          }),
        );
        return;
      }
      if (request.url === "/usage") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            plan_type: "pro",
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 48,
                limit_window_seconds: 604_800,
                reset_after_seconds: 180_092,
                reset_at: 4_102_452_000,
              },
              secondary_window: null,
            },
          }),
        );
        return;
      }
      if (request.url === "/models") {
        modelRequests.push(
          request.headers["chatgpt-account-id"]?.toString() ?? "",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      responseNumber += 1;
      seen.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        accountId: z
          .string()
          .optional()
          .parse(request.headers["chatgpt-account-id"]),
        body,
      });
      if (responseNumber === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "x-codex-primary-used-percent": "25",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-after-seconds": "3600",
          "x-codex-secondary-used-percent": "40",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-after-seconds": "86400",
        });
        response.end('{"id":"http-response"}');
        return;
      }
      if (responseNumber === 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "x-codex-secondary-used-percent": "100",
        });
        response.end('{"error":{"message":"quota exhausted"}}');
        return;
      }
      const id = `response-${responseNumber}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
      });
      response.end(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id },
        })}\n\nevent: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id,
            output: [{ type: "message", id: `message-${responseNumber}` }],
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    cleanups.push(upstream.close);
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-codex-"),
    );
    let imported = 0;
    const importCodexCredentials =
      async (): Promise<ImportedCodexCredentials> => {
        imported += 1;
        return {
          accessToken: "expired-token",
          refreshToken: `refresh-${imported}`,
          idToken: "id-token",
          accountId: `chatgpt-account-${imported}`,
          email: `codex-${imported}@example.com`,
          expiresAt: Date.now() - 1,
        };
      };
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await host.bb.storage.kv.set("config", {
      anthropicUpstreamBaseUrl: upstream.url,
      codexUpstreamBaseUrl: upstream.url,
    });
    await createAccountPoolPlugin({
    vpnPayload: async (timestamp) => vpnProof(timestamp, "connected"),
      codexRefreshUrl: `${upstream.url}/oauth`,
      codexUsageUrl: `${upstream.url}/usage`,
      importCodexCredentials,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "claude-key" },
      label: "Claude first",
      priority: 0,
    });
    const importedByCli = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--import",
    ]);
    expect(importedByCli.exitCode).toBe(0);
    await host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    const accountTable = await host.harness.behavior.runCli([
      "account",
      "list",
    ]);
    expect(accountTable.stdout).toContain("Provider");
    expect(accountTable.stdout).toContain("codex");
    expect(accountTable.stdout).toContain("7d=48% 2100-01-01T02:00:00.000Z");
    expect(accountTable.stdout).not.toContain("5h=");
    const routed = await resolveCodexToken(host);
    expect(routed.baseUrl).toBe("/api/v1/plugins/account-pool/http/v1");
    await expect(
      host.harness.behavior.resolveProviderEnvHealth("codex", {
        hostId: "host-one",
      }),
    ).resolves.toEqual({
      label: "Proxied",
      statusMessage: "Credentials are provided by the Account Pooler hub.",
    });
    const httpResponse = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          authorization: "Bearer local-codex-token",
          "x-bb-account-pool-token": routed.token,
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
        },
        body: JSON.stringify({ model: "gpt-5", input: [] }),
      },
    );
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toEqual({ id: "http-response" });
    const modelsResponse = await host.harness.behavior.fetchHttp(
      "GET",
      "/v1/models",
      {
        headers: { "x-bb-account-pool-token": routed.token },
      },
    );
    expect(await modelsResponse.json()).toEqual({ data: [] });
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toMatch(/^chatgpt-account-[12]$/u);
    expect(seen[0]).toMatchObject({
      path: "/responses",
      authorization: `Bearer ${futureToken}`,
      accountId: "chatgpt-account-1",
    });
    const postResponses = (input: unknown[]) =>
      host.harness.behavior.fetchHttp("POST", "/v1/responses", {
        headers: {
          authorization: "Bearer local-codex-token",
          "x-bb-account-pool-token": routed.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", input }),
      });
    const first = await postResponses([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
    ]);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"type":"response.completed"');
    const second = await postResponses([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
      { type: "message", id: "message-3" },
      { type: "message", id: "delta-two" },
    ]);
    expect(second.status).toBe(200);
    await second.text();
    expect(seen[1]?.accountId).not.toBe(seen[2]?.accountId);
    expect(seen[2]?.accountId).toBe(seen[3]?.accountId);
    expect(JSON.parse(seen[3]?.body ?? "{}").input).toEqual([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
      { type: "message", id: "message-3" },
      { type: "message", id: "delta-two" },
    ]);
    const status = statusSchema.parse(
      await host.harness.behavior.callRpc("status.get", null),
    );
    const firstCodex = status.accounts.find(
      (account) => account.codexAccountId === "chatgpt-account-1",
    );
    expect(seen[1]?.accountId).toBe("chatgpt-account-1");
    expect(firstCodex).toMatchObject({
      provider: "codex",
      status: "exhausted",
      fiveHourUtilization: null,
      sevenDayUtilization: null,
      familyWeekly: { other: null },
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 300,
          utilization: 0.25,
          status: null,
          source: "header",
        },
        {
          slot: "secondary",
          windowMinutes: 10_080,
          utilization: 1,
          status: "rejected",
          source: "header",
        },
      ],
    });
    expect(
      status.accounts.find(
        (account) => account.codexAccountId === seen[2]?.accountId,
      ),
    ).toMatchObject({
      provider: "codex",
      status: "ready",
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          status: "allowed",
          source: "usage",
        },
      ],
    });
    const secondCodex = status.accounts.find(
      (account) =>
        account.provider === "codex" && account.id !== firstCodex?.id,
    );
    if (secondCodex === undefined) throw new Error("Missing second account.");
    await host.harness.behavior.callRpc("account.disable", {
      id: secondCodex.id,
    });
    const blocked = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: { "x-bb-account-pool-token": routed.token },
        body: JSON.stringify({ model: "gpt-5", input: [] }),
      },
    );
    // Exhausted for the rest of the week: a refusal, not a retry hint a client would
    // sit out in silence.
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("retry-after")).toBeNull();
    const secret = accountSecretSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(
            dataDir,
            "plugins",
            "account-pool",
            "secrets",
            "accounts",
            `account-${firstCodex?.id}.json`,
          ),
          "utf8",
        ),
      ),
    );
    expect(secret).toMatchObject({
      accessToken: futureToken,
      refreshToken: "next-refresh-1",
      idToken: "next-id-token",
    });
  });

  it("cancels a Codex upstream read when the HTTP client aborts", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-codex-cancel-"),
    );
    let upstreamReadCanceled = false;
    const upstreamFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input) === CODEX_USAGE_STUB_URL) return Response.json({});
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("Expected the upstream request to carry a signal.");
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"streaming"}}\n\n',
            ),
          );
          signal.addEventListener(
            "abort",
            () => {
              upstreamReadCanceled = true;
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await host.bb.storage.kv.set("config", {
      codexUpstreamBaseUrl: "https://example.com",
    });
    await createAccountPoolPlugin({
    vpnPayload: async (timestamp) => vpnProof(timestamp, "connected"),
      fetch: upstreamFetch,
      codexUsageUrl: CODEX_USAGE_STUB_URL,
      importCodexCredentials: async () => ({
        accessToken: "access",
        refreshToken: "refresh",
        idToken: null,
        accountId: "account",
        email: null,
        expiresAt: null,
      }),
    })(host.bb);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    const { token } = await resolveCodexToken(host);
    const client = new AbortController();
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          "x-bb-account-pool-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", input: [] }),
        signal: client.signal,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("response.created");
    client.abort(new Error("interrupted"));
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(async () => {
      expect(upstreamReadCanceled).toBe(true);
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).inFlight,
      ).toBe(0);
    });
  });

  it("prunes token files for unenrolled hosts on startup and status", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-prune-"));
    const secretDir = path.join(
      dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
    );
    const seededTokens = new HubTokenStore(secretDir);
    await seededTokens.initialize();
    await seededTokens.forHost("host-gone");
    const goneTokenFile = path.join(secretDir, "hub-token-host-gone.json");
    await expect(fs.access(goneTokenFile)).resolves.toBeUndefined();
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({ vpnPayload: async (timestamp) => vpnProof(timestamp, "connected")})(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await expect(fs.access(goneTokenFile)).rejects.toThrow();
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "sk-account" },
      label: null,
      priority: 100,
    });
    await resolveToken(host, "host-two", "thread-two");
    const hostTwoTokenFile = path.join(secretDir, "hub-token-host-two.json");
    await expect(fs.access(hostTwoTokenFile)).resolves.toBeUndefined();
    host.harness.sdk.stub("hosts.list", async () => [
      { id: "host-one", name: "One" },
    ]);
    const status = statusSchema.parse(
      await host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.hosts).toEqual([]);
    await expect(fs.access(hostTwoTokenFile)).rejects.toThrow();
  });

  it("uses a single-process token cache and throttles last-use file writes", async () => {
    let now = 1_000;
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-tokens-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const tokens = new HubTokenStore(dataDir, () => now);
    await tokens.initialize();
    const token = await tokens.forHost("host-one");
    const tokenFile = path.join(dataDir, "hub-token-host-one.json");
    await fs.writeFile(
      tokenFile,
      `${JSON.stringify({
        hostId: "host-one",
        value: "A".repeat(43),
        mintedAt: now,
        lastUsedAt: null,
        previous: [],
      })}\n`,
    );
    const writeFile = vi.spyOn(fs, "writeFile");
    try {
      expect(await tokens.authenticate(token)).toBe("host-one");
      now += 30_000;
      expect(await tokens.authenticate(token)).toBe("host-one");
      expect(await tokens.authenticate("A".repeat(43))).toBeNull();
      expect(writeFile).toHaveBeenCalledTimes(1);
      now += 30_000;
      expect(await tokens.authenticate(token)).toBe("host-one");
      expect(writeFile).toHaveBeenCalledTimes(2);
    } finally {
      writeFile.mockRestore();
    }
  });

  it("forwards the next request after adding the first account through the CLI", async () => {
    let forwarded = 0;
    const upstream = await startUpstream(async (request, response) => {
      forwarded += 1;
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"forwarded":true}');
    });
    cleanups.push(upstream.close);
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-empty-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await host.bb.storage.kv.set("config", {
      anthropicUpstreamBaseUrl: upstream.url,
    });
    await createAccountPoolPlugin({ vpnPayload: async (timestamp) => vpnProof(timestamp, "connected")})(host.bb);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const statusResult = await host.harness.behavior.runCli([
      "status",
      "--json",
    ]);
    const status = statusReportSchema.parse(JSON.parse(statusResult.stdout));
    expect(status.accepting).toBe(true);
    expect(status.hosts).toEqual([]);
    expect(
      await host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-empty",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({name:"ANTHROPIC_BASE_URL"}),expect.objectContaining({name:"ANTHROPIC_AUTH_TOKEN"})]));
    await expect(
      host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([
      "Add and enable a Claude or Codex account with `bb pool account add`.",
    ]);
    const hello = helloResponse();
    expect(hello.status).toBe(200);
    const added = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "claude",
      "--api-key",
      "sk-cli-secret",
      "--label",
      "CLI account",
      "--priority",
      "7",
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).not.toContain("sk-cli-secret");
    expect(added.stdout).not.toContain("reload");
    const key = await resolveToken(host, "host-one", "thread-empty");
    const forwardedResponse = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(key), body: "{}" },
    );
    expect(forwardedResponse.status).toBe(200);
    expect(await forwardedResponse.text()).toBe('{"forwarded":true}');
    expect(forwarded).toBe(1);
    const accountsAfterRequest = z.array(accountSummarySchema).parse(
      await host.harness.behavior.callRpc("account.list", null),
    );
    expect(accountsAfterRequest[0]?.successfulRequests).toBe(1);
  });

  it("exposes every account CLI operation", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const help = await fixture.host.harness.behavior.runCli([
      "account",
      "add",
      "--help",
    ]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--login");
    expect(help.stdout).toContain("account login-complete");
    expect(help.stdout).toContain("--code-stdin");
    expect(help.stdout).toContain("--api-key-stdin");
    expect(help.stdout).toContain("Unsafe: exposes the key");
    expect(help.stdout).toContain("account refresh <id>");
    const list = await fixture.host.harness.behavior.runCli([
      "account",
      "list",
      "--json",
    ]);
    const listed = z
      .object({ accounts: z.array(accountSummarySchema) })
      .strict()
      .parse(JSON.parse(list.stdout));
    const account = listed.accounts[0];
    if (account === undefined) throw new Error("CLI account was not listed.");
    expect(account).toMatchObject({ label: "Claude API key", priority: 100 });
    expect(
      await fixture.host.harness.behavior.runCli([
        "account",
        "refresh",
        account.id,
      ]),
    ).toMatchObject({ exitCode: 0 });
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "disable",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )[0]?.status,
    ).toBe("disabled");
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "enable",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    const publicStatus = statusReportSchema.parse(
      JSON.parse(
        (await fixture.host.harness.behavior.runCli(["status", "--json"]))
          .stdout,
      ),
    );
    expect(publicStatus.accepting).toBe(true);
    expect(publicStatus.hosts).toEqual([
      expect.objectContaining({ hostId: "host-one", hostName: "One" }),
    ]);
    expect(publicStatus).not.toHaveProperty("hubKey");
    expect(JSON.stringify(publicStatus)).not.toContain(fixture.key);
    const counted = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages/count_tokens",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(counted.status).toBe(200);
    expect(await counted.text()).toBe("{}");
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "remove",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      await fixture.host.harness.behavior.callRpc("account.list", null),
    ).toEqual([]);
  });

  it("exposes manual Claude login over RPC and the two-step CLI", async () => {
    const tokenBodies: object[] = [];
    const oauth = await startUpstream(async (request, response) => {
      if (request.url === "/token") {
        tokenBodies.push(
          JSON.parse((await readRequestBody(request)).toString()),
        );
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: "login-access",
            refresh_token: "login-refresh",
            expires_in: 3600,
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        expect(request.headers.authorization).toBe("Bearer login-access");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            account: {
              uuid: "22222222-2222-4222-8222-222222222222",
              email: "login@example.com",
              display_name: "Logged-in Claude",
              has_claude_pro: true,
              rate_limit_tier: "default_claude_pro",
            },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    cleanups.push(oauth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-login-rpc-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
    vpnPayload: async (timestamp) => vpnProof(timestamp, "connected"),
      oauthAuthorizeUrl: `${oauth.url}/authorize`,
      oauthTokenUrl: `${oauth.url}/token`,
      oauthProfileUrl: `${oauth.url}/profile`,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const started = z
      .object({ sessionId: z.string().uuid(), authorizeUrl: z.string().url() })
      .strict()
      .parse(await host.harness.behavior.callRpc("login.start", null));
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (state === null) throw new Error("Login start did not return state.");
    const account = accountSchema.parse(
      await host.harness.behavior.callRpc("login.complete", {
        sessionId: started.sessionId,
        pasted: `login-code#${state}`,
      }),
    );
    expect(account).toMatchObject({
      label: "Logged-in Claude",
      email: "login@example.com",
      subscriptionType: "pro",
      rateLimitTier: "default_claude_pro",
      kind: "oauth",
      enabled: true,
    });
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]).toMatchObject({
      code: "login-code",
      state,
      grant_type: "authorization_code",
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
    const secret = accountSecretSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(
            dataDir,
            "plugins",
            "account-pool",
            "secrets",
            "accounts",
            `account-${account.id}.json`,
          ),
          "utf8",
        ),
      ),
    );
    expect(secret).toMatchObject({
      kind: "oauth",
      accessToken: "login-access",
      refreshToken: "login-refresh",
    });
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "accounts-changed",
      payload: {},
    });

    const cliStarted = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "claude",
      "--login",
    ]);
    expect(cliStarted.exitCode).toBe(0);
    expect(cliStarted.stdout).toContain("Open this URL to sign in to Claude:");
    expect(cliStarted.stdout).toContain("account login-complete");
    expect(cliStarted.stdout).toContain("--code-stdin");
    const sessionId = cliStarted.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];
    const authorizeUrl = cliStarted.stdout.match(
      /Open this URL to sign in to Claude:\n([^\n]+)/u,
    )?.[1];
    if (sessionId === undefined || authorizeUrl === undefined) {
      throw new Error("CLI login start did not return its session and URL.");
    }
    const cliState = new URL(authorizeUrl).searchParams.get("state");
    if (cliState === null) throw new Error("CLI login start omitted state.");
    const cliCompleted = await host.harness.behavior.runCli([
      "account",
      "login-complete",
      "--session",
      sessionId,
      "--code",
      `cli-code#${cliState}`,
    ]);
    expect(cliCompleted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Added Logged-in Claude"),
    });
    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[1]).toMatchObject({ code: "cli-code", state: cliState });
  });

  it("exposes Codex device login over RPC and the two-step CLI", async () => {
    let holdTokenPoll = false;
    let markTokenPollStarted: () => void = () => {};
    const tokenPollStarted = new Promise<void>((resolve) => {
      markTokenPollStarted = resolve;
    });
    let releaseTokenPoll: () => void = () => {};
    const tokenPollRelease = new Promise<void>((resolve) => {
      releaseTokenPoll = resolve;
    });
    const auth = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/accounts/deviceauth/usercode") {
        response.end(
          JSON.stringify({
            device_auth_id: "device-secret",
            user_code: "ABCD-1234",
            interval: "1",
            expires_in: 600,
          }),
        );
        return;
      }
      if (request.url === "/api/accounts/deviceauth/token") {
        if (holdTokenPoll) {
          markTokenPollStarted();
          await tokenPollRelease;
        }
        response.end(
          JSON.stringify({
            authorization_code: "authorization-secret",
            code_challenge: "challenge-secret",
            code_verifier: "verifier-secret",
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.end(
          JSON.stringify({
            access_token: testJwt({ exp: 2_000_000_000 }),
            refresh_token: "refresh-secret",
            id_token: testJwt({
              email: "codex@example.com",
              "https://api.openai.com/auth": {
                chatgpt_account_id: "chatgpt-account-1",
              },
            }),
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    cleanups.push(auth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-codex-login-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
    vpnPayload: async (timestamp) => vpnProof(timestamp, "connected"),
      codexAuthBaseUrl: auth.url,
      codexUsageUrl: EMPTY_USAGE_URL,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const started = codexLoginStartSchema.parse(
      await host.harness.behavior.callRpc("codexLogin.start", null),
    );
    expect(started).toMatchObject({
      verificationUri: `${auth.url}/codex/device`,
      userCode: "ABCD-1234",
      intervalMs: 1_000,
    });
    expect(
      codexLoginPollSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: started.sessionId,
        }),
      ),
    ).toEqual({ status: "pending" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const completed = codexLoginPollSchema.parse(
      await host.harness.behavior.callRpc("codexLogin.poll", {
        sessionId: started.sessionId,
      }),
    );
    expect(completed).toMatchObject({
      status: "complete",
      account: {
        provider: "codex",
        codexAccountId: "chatgpt-account-1",
        email: "codex@example.com",
      },
    });

    const cliStarted = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--login",
    ]);
    expect(cliStarted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Open this URL to sign in to Codex:"),
    });
    expect(cliStarted.stdout).toContain("Enter this code: ABCD-1234");
    expect(cliStarted.stdout).toContain("account login-poll --session");
    const sessionId = cliStarted.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];
    if (sessionId === undefined) {
      throw new Error("Codex CLI login start omitted its session ID.");
    }
    const cliCompleted = await host.harness.behavior.runCli([
      "account",
      "login-poll",
      "--session",
      sessionId,
    ]);
    expect(cliCompleted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Added codex@example.com"),
    });
    const cancelledStart = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--login",
    ]);
    const cancelledSessionId = cancelledStart.stdout.match(
      /Session ID: ([0-9a-f-]+)/u,
    )?.[1];
    if (cancelledSessionId === undefined) {
      throw new Error("Codex CLI login start omitted its session ID.");
    }
    holdTokenPoll = true;
    const controller = new AbortController();
    const cancelledPoll = host.harness.behavior.runCli(
      ["account", "login-poll", "--session", cancelledSessionId],
      { signal: controller.signal },
    );
    await tokenPollStarted;
    controller.abort(new Error("cancelled by test"));
    expect(
      codexLoginPollSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: cancelledSessionId,
        }),
      ),
    ).toEqual({
      status: "error",
      message: "Login session was not found. Start again.",
    });
    releaseTokenPoll();
    expect(await cancelledPoll).toMatchObject({ exitCode: 1 });
    expect(host.harness.inspection.logEntries.join("\n")).not.toMatch(
      /device-secret|ABCD-1234|authorization-secret|verifier-secret|refresh-secret/u,
    );
  });

  it("resolves pooled env without a thread for bb model listing", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    // bb resolves provider env with a null thread and project when it lists models;
    // SDK types before 0.6.57 still declare both as strings.
    const catalogContext = {
      threadId: null,
      projectId: null,
      hostId: "host-one",
    } as unknown as Parameters<
      typeof fixture.host.harness.behavior.resolveProviderEnv
    >[1];
    const entries = await fixture.host.harness.behavior.resolveProviderEnv(
      "claude-code",
      catalogContext,
    );
    const token = entries.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    )?.value;
    if (typeof token !== "string") {
      throw new Error("Catalog env omitted the hub token.");
    }
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(token), body: "{}" },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(await fixture.host.bb.storage.kv.list("routed:")).not.toContain(
      "routed:null",
    );
  });

  it("resolves distinct secret machine tokens and honors per-thread bypass", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const first = await fixture.host.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    expect(first).toEqual([
      {
        name: "ANTHROPIC_BASE_URL",
        value: { serverPath: "/api/v1/plugins/account-pool/http" },
        reason: "Routed through the Account Pooler hub",
      },
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        value: fixture.key,
        reason: "Account Pooler hub token for this machine",
      },
      {
        name: "ENABLE_TOOL_SEARCH",
        value: "true",
        reason:
          "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
      },
      {
        name: "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
        value: "1",
        reason:
          "Preserve the native Opus context window through the Account Pooler hub",
      },
    ]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toEqual({
      label: "Proxied",
      statusMessage: "Credentials are provided by the Account Pooler hub.",
    });
    const secondToken = await resolveToken(
      fixture.host,
      "host-two",
      "thread-two",
    );
    expect(secondToken).not.toBe(fixture.key);
    expect(
      await fixture.host.harness.behavior.callRpc("bypass.set", {
        threadId: "thread-one",
        bypassed: true,
      }),
    ).toEqual({ threadId: "thread-one", bypassed: true });
    expect(
      await fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).toEqual([]);
    const off = await fixture.host.harness.behavior.runCli([
      "bypass",
      "thread-one",
      "--off",
    ]);
    expect(off.exitCode).toBe(0);
    expect(await resolveToken(fixture.host)).toBe(fixture.key);
  });

  it("retains pooled env but withholds healthy status when an enabled account secret is missing", async () => {
    let forwarded=0;
    const upstream = await startUpstream(async (request, response) => {
      forwarded++;
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const accountSecretFile = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      `account-${fixture.account.id}.json`,
    );
    await fs.rm(accountSecretFile);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-without-secret",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({name:"ANTHROPIC_BASE_URL"}),expect.objectContaining({name:"ANTHROPIC_AUTH_TOKEN"})]));
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
    const token=await resolveToken(fixture.host);
    const denied=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(token),body:'{}'});
    expect(denied.status).toBe(403);
    expect(forwarded).toBe(0);
    await denied.text();
  });

  it("rotates a machine token with a ten-minute grace window", async () => {
    let now = 1_000;
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { now: () => now },
    });
    const first = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(first.status).toBe(200);
    await first.text();
    now = 2_000;
    const rotate = await fixture.host.harness.behavior.runCli([
      "token",
      "rotate",
      "--machine",
      "One",
    ]);
    expect(rotate.exitCode).toBe(0);
    expect(rotate.stdout).not.toContain(fixture.key);
    const nextKey = await resolveToken(fixture.host);
    expect(nextKey).not.toBe(fixture.key);
    now += 9 * 60 * 1_000;
    const grace = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(grace.status).toBe(200);
    await grace.text();
    now = 2_000 + 10 * 60 * 1_000 + 1;
    const expired = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(expired.status).toBe(401);
    const current = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(nextKey), body: "{}" },
    );
    expect(current.status).toBe(200);
    await current.text();
    const tokenFile = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      "hub-token-host-one.json",
    );
    expect(await fs.readFile(tokenFile, "utf8")).not.toContain(fixture.key);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.hosts).toEqual([
      {
        hostId: "host-one",
        hostName: "One",
        mintedAt: 2_000,
        lastUsedAt: now,
      },
    ]);
    expect(JSON.stringify(status)).not.toContain(fixture.key);
    expect(JSON.stringify(status)).not.toContain(nextKey);
  });

  it("reports routed threads without local login and logs them on disable", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    await resolveToken(fixture.host, "host-two", "thread-two");
    fixture.host.harness.sdk.stub(
      "system.providerStates",
      async ({ hostId }) => ({
        providers: [
          {
            providerId: "claude-code",
            status: hostId === "host-one" ? "unauthenticated" : "ready",
            planLabel: null,
          },
        ],
      }),
    );
    const routedThreads = routedThreadStatusListSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.routedThreads", null),
    );
    expect(routedThreads).toEqual([
      {
        threadId: "thread-one",
        hostId: "host-one",
        hostName: "One",
        routedAt: expect.any(Number),
        localClaudeStatus: "unauthenticated",
      },
    ]);
    fixture.host.harness.sdk.stub("plugins.list", async () => ({
      plugins: [{ id: "account-pool", enabled: false }],
    }));
    await fixture.host.harness.lifecycle.dispose();
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message:
        "Account Pooler disabled with 1 recently routed thread on machines without a local Claude login. Run bb pool status before disabling to inspect them.",
    });
  });

  it("does not fail disposal when disable inspection rejects", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    fixture.host.harness.sdk.stub("plugins.list", async () => {
      throw new Error("plugin list unavailable");
    });
    await expect(fixture.host.harness.lifecycle.dispose()).resolves.toBe(
      undefined,
    );
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "debug",
      message:
        "Account Pooler disable inspection skipped: plugin list unavailable",
    });
  });

  it("bounds disable inspection when provider states hang", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { disposeTimeoutMs: 10 },
    });
    fixture.host.harness.sdk.stub("plugins.list", async () => ({
      plugins: [{ id: "account-pool", enabled: false }],
    }));
    fixture.host.harness.sdk.stub(
      "system.providerStates",
      () => new Promise(() => {}),
    );
    await expect(fixture.host.harness.lifecycle.dispose()).resolves.toBe(
      undefined,
    );
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "debug",
      message: "Account Pooler disable inspection timed out.",
    });
  });

  it("keeps proxied routed hosts visible in status", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    fixture.host.harness.sdk.stub("system.providerStates", async () => ({
      providers: [
        {
          providerId: "claude-code",
          status: "ready",
          planLabel: "Proxied",
        },
      ],
    }));
    const routedThreads = routedThreadStatusListSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.routedThreads", null),
    );
    expect(routedThreads).toEqual([
      {
        threadId: "thread-one",
        hostId: "host-one",
        hostName: "One",
        routedAt: expect.any(Number),
        localClaudeStatus: "proxied",
      },
    ]);
  });

  it("requires a machine token and forwards a streaming SSE response byte for byte", async () => {
    const seen: {
      url: string;
      authorization: string | undefined;
      clientApiKey: string | undefined;
      beta: string | undefined;
      version: string | undefined;
      userAgent: string | undefined;
      app: string | undefined;
      stainlessRetry: string | undefined;
      cookie: string | undefined;
      gateMachineId: string | undefined;
      forwarded: string | undefined;
      cfRay: string | undefined;
      body: Buffer;
    }[] = [];
    const first = Buffer.from('event: message_start\ndata: {"one":1}\n\n');
    const second = Buffer.from('event: message_stop\ndata: {"two":2}\n\n');
    const upstream = await startUpstream(async (request, response) => {
      seen.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        clientApiKey: request.headers["x-api-key"]?.toString(),
        beta: request.headers["anthropic-beta"]?.toString(),
        version: request.headers["anthropic-version"]?.toString(),
        userAgent: request.headers["user-agent"]?.toString(),
        app: request.headers["x-app"]?.toString(),
        stainlessRetry: request.headers["x-stainless-retry-count"]?.toString(),
        cookie: request.headers.cookie,
        gateMachineId: request.headers["x-bb-gate-machine-id"]?.toString(),
        forwarded: request.headers.forwarded,
        cfRay: request.headers["cf-ray"]?.toString(),
        body: await readRequestBody(request),
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "4102444800",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "anthropic-ratelimit-unified-7d-reset": "4102448400",
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "claim-a",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-overage-status": "rejected",
        "anthropic-ratelimit-unified-7d_oi-status": "rejected",
        "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
      });
      response.write(first);
      setTimeout(() => response.end(second), 60);
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: { importCredentials: async () => importedCredentials() },
    });
    const unauthorized = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(unauthorized.status).toBe(401);
    expect(seen).toHaveLength(0);
    const body = Buffer.from('{"model":"claude-fable-5","stream":true}');
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages?beta=true",
      {
        headers: {
          ...authHeaders(fixture.key),
          "x-api-key": "client-key-must-not-forward",
          "anthropic-beta": "feature-a,feature-b",
          "user-agent": "claude-code-test",
          "x-app": "cli",
          "x-stainless-retry-count": "2",
          cookie: "bb_session=browser-secret",
          "x-bb-gate-machine-id": "machine-stable-id",
          forwarded: "for=192.0.2.1",
          "cf-ray": "edge-request-id",
          "accept-encoding": "gzip",
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    const firstRead = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("First SSE chunk was buffered.")),
          30,
        ),
      ),
    ]);
    expect(firstRead.done).toBe(false);
    expect(Buffer.from(firstRead.value ?? []).equals(first)).toBe(true);
    const remaining: Buffer[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining.push(Buffer.from(chunk.value));
    }
    expect(
      Buffer.concat([Buffer.from(firstRead.value ?? []), ...remaining]),
    ).toEqual(Buffer.concat([first, second]));
    expect(seen).toEqual([
      {
        url: "/v1/messages?beta=true",
        authorization: "Bearer oauth-access",
        clientApiKey: undefined,
        beta: "feature-a,feature-b",
        version: "2023-06-01",
        userAgent: "claude-code-test",
        app: "cli",
        stainlessRetry: "2",
        cookie: undefined,
        gateMachineId: undefined,
        forwarded: undefined,
        cfRay: undefined,
        body,
      },
    ]);
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]).toMatchObject({
      fiveHourUtilization: 0.25,
      sevenDayUtilization: 0.5,
      fiveHourStatus: "allowed",
      sevenDayStatus: "allowed",
      representativeClaim: "claim-a",
      familyWeekly: {
        fable: {
          utilization: null,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: expect.any(Number),
          source: "header",
        },
      },
    });
    expect(fixture.host.harness.inspection.registrations.httpRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "HEAD",
          path: "/api/hello",
          auth: "none",
        }),
      ]),
    );
  });

  it("errors a failed non-SSE stream without appending an SSE frame", async () => {
    const partial = Buffer.from('{"partial":');
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.write(partial);
      setTimeout(() => response.destroy(new Error("upstream failed")), 30);
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value ?? [])).toEqual(partial);
    await expect(reader.read()).rejects.toThrow();
  });

  it("applies config threshold changes live and rotates quota rejections", async () => {
    const keys: string[] = [];
    let requestNumber = 0;
    const upstream = await startUpstream((request, response) => {
      requestNumber += 1;
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      if (requestNumber === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-utilization": "0.75",
          "anthropic-ratelimit-unified-5h-reset": "4102444800",
          "anthropic-ratelimit-unified-5h-status": "allowed",
        });
        response.end('{"first":true}');
        return;
      }
      if (requestNumber === 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": "4102444800",
        });
        response.end('{"rejected":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"rotated":true}');
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");
    await addApiAccount(fixture, "sk-three");
    const first = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(first.status).toBe(200);
    await first.text();
    expect(
      accountPoolConfigSchema.parse(
        await fixture.host.harness.behavior.callRpc("config.set", {
          switchThreshold: 0.7,
        }),
      ).switchThreshold,
    ).toBe(0.7);
    const rotated = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.text()).toBe('{"rotated":true}');
    expect(keys).toEqual(["sk-one", "sk-two", "sk-three"]);
  });

  it("routes around a Fable-spent account while retaining it for Opus", async () => {
    const keys: string[] = [];
    const upstream = await startUpstream(async (request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      await readRequestBody(request);
      if (keys.length === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d_oi-utilization": "0.99",
          "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
          "anthropic-ratelimit-unified-7d_oi-status": "allowed",
        });
      } else {
        response.writeHead(200, { "content-type": "application/json" });
      }
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");

    for (const model of [
      "claude-fable-5",
      "claude-fable-5",
      "claude-opus-4-1",
    ]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({ model }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(keys).toEqual(["sk-one", "sk-two", "sk-one"]);
  });

  it("rotates a family-only 429 without exhausting other families", async () => {
    const keys: string[] = [];
    const upstream = await startUpstream(async (request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      await readRequestBody(request);
      if (keys.length === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
          "anthropic-ratelimit-unified-7d_oi-status": "rejected",
        });
        response.end('{"rejected":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");

    const fable = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-fable-5" }),
      },
    );
    expect(fable.status).toBe(200);
    await fable.text();
    const opus = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-opus-4-1" }),
      },
    );
    expect(opus.status).toBe(200);
    await opus.text();

    expect(keys).toEqual(["sk-one", "sk-two", "sk-one"]);
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]).toMatchObject({
      status: "ready",
      familyWeekly: {
        fable: { status: "rejected", source: "header" },
      },
    });
  });

  it("rotates when a same-account retry reveals a family limit", async () => {
    const keys: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-one",
      options: {
        fetch: async (_input, init) => {
          keys.push(new Headers(init?.headers).get("x-api-key") ?? "");
          if (keys.length === 1) {
            return Response.json(
              { minute: true },
              { status: 429, headers: { "retry-after": "0" } },
            );
          }
          if (keys.length === 2) {
            return Response.json(
              { family: true },
              {
                status: 429,
                headers: {
                  "anthropic-ratelimit-unified-5h-status": "allowed",
                  "anthropic-ratelimit-unified-7d-status": "allowed",
                  "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
                  "anthropic-ratelimit-unified-7d_oi-status": "rejected",
                },
              },
            );
          }
          return Response.json({ rotated: true });
        },
      },
    });
    await addApiAccount(fixture, "sk-two");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-fable-5" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rotated: true });
    expect(keys).toEqual(["sk-one", "sk-one", "sk-two"]);
  });

  it("refreshes usage on import and routes from its family observations", async () => {
    const authorizations: Array<string | undefined> = [];
    const usageCalls = new Map<string, number>();
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/usage?cedar_ember=1&skip_spend=1") {
        const authorization = request.headers.authorization;
        usageCalls.set(
          authorization ?? "",
          (usageCalls.get(authorization ?? "") ?? 0) + 1,
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: "4102444800" },
            seven_day: { utilization: 20, resets_at: "4102448400" },
            cedar_ember: { eligible: true, grants: [{
              label: "Test reset", resets_left: authorization === "Bearer oauth-a" ? 2 : 1,
              ends_at: "2100-01-01T12:34:56Z", clears: ["five_hour", "seven_day"],
            }] },
            limits: [
              {
                kind: "weekly_scoped",
                group: "weekly",
                percent: authorization === "Bearer oauth-a" ? 100 : 0,
                resets_at: "4102452000",
                scope: { model: { display_name: "Fable" } },
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            account: { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const imports = [
      importedCredentials({
        accessToken: "oauth-a",
        accountUuid: null,
      }),
      importedCredentials({
        accessToken: "oauth-b",
        accountUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ];
    let importIndex = 0;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        usageUrl: `${upstream.url}/usage`,
        oauthProfileUrl: `${upstream.url}/profile`,
        importCredentials: async () => {
          const imported = imports[importIndex];
          importIndex += 1;
          if (imported === undefined) throw new Error("No import fixture.");
          return imported;
        },
      },
    });
    const second = accountSchema.parse(
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "import" },
        label: "second",
        priority: 100,
      }),
    );
    expect(usageCalls).toEqual(
      new Map([
        ["Bearer oauth-a", 1],
        ["Bearer oauth-b", 1],
      ]),
    );
    await fixture.host.harness.behavior.callRpc("account.disable", {
      id: second.id,
    });
    await fixture.host.harness.behavior.callRpc("account.enable", {
      id: second.id,
    });
    expect(usageCalls.get("Bearer oauth-a")).toBe(1);
    expect(usageCalls.get("Bearer oauth-b")).toBe(2);
    const listed = await fixture.host.harness.behavior.runCli([
      "account",
      "list",
    ]);
    expect(listed.stdout).toContain("Fable");
    expect(listed.stdout).toContain("100% rejected");
    expect(listed.stdout).toContain("0% allowed");
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.accountUuid).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(accounts[0]?.resetCredits?.availableCount).toBe(2);
    expect(accounts[1]?.resetCredits?.availableCount).toBe(1);
    expect(accounts[0]?.resetCredits?.credits?.[0]?.expiresAt).toBe(Date.parse("2100-01-01T12:34:56Z"));

    for (const model of ["claude-fable-5", "claude-opus-4-1"]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({ model }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(authorizations).toEqual(["Bearer oauth-b", "Bearer oauth-b"]);
  });

  it("rewrites both known metadata account UUID formats", async () => {
    const bodies: Buffer[] = [];
    const upstream = await startUpstream(async (request, response) => {
      bodies.push(await readRequestBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const accountUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        importCredentials: async () => importedCredentials({ accountUuid }),
      },
    });
    const inputs = [
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            device_id: "device",
            account_uuid: oldUuid,
          }),
        },
      }),
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: `user_hash_account_${oldUuid}_session_cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
        },
      }),
    ];
    for (const body of inputs) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.toString().includes(accountUuid))).toBe(
      true,
    );
    expect(bodies.every((body) => !body.toString().includes(oldUuid))).toBe(
      true,
    );
  });

  it("preserves request bytes when an account UUID rewrite cannot apply", async () => {
    const bodies: Buffer[] = [];
    const upstream = await startUpstream(async (request, response) => {
      bodies.push(await readRequestBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const inputs = [
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            account_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          }),
        },
      }),
      '{ "model": "claude-fable-5", "messages": [] }',
      "not-json-at-all",
    ];
    for (const body of inputs) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
    }
    expect(bodies.map((body) => body.toString())).toEqual(inputs);
  });

  it("paces a per-minute 429 on the same account without rotating", async () => {
    const keys: string[] = [];
    const times: number[] = [];
    const upstream = await startUpstream((request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      times.push(Date.now());
      if (keys.length === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.04",
        });
        response.end('{"minute":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"retried":true}');
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"retried":true}');
    expect(keys).toEqual(["sk-one", "sk-one"]);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(30);
  });

  it.each([401, 403, 408, 500, 502, 503, 504, 529, "disconnect"])(
    "tries another account after a pre-stream %s failure",
    async (failure) => {
      const attempts: Array<string | undefined> = [];
      const upstream = await startUpstream(async (request, response) => {
        await readRequestBody(request);
        const key = request.headers["x-api-key"];
        attempts.push(typeof key === "string" ? key : undefined);
        if (key === "sk-first") {
          if (typeof failure === "string") {
            request.socket.destroy();
            return;
          }
          response.writeHead(failure, { "content-type": "application/json" });
          response.end('{"error":{"message":"first account failed"}}');
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"result":"second"}');
      });
      cleanups.push(upstream.close);
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        apiKey: "sk-first",
        priority: 0,
      });
      await addApiAccount(fixture, "sk-second", 100);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload).toEqual({ result: "second" });
      expect(attempts).toEqual(["sk-first", "sk-second"]);
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(
        accounts.find((account) => account.id === fixture.account.id)?.error,
      ).toEqual(failure === 401 || failure === 403 ? expect.any(String) : null);
    },
  );

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider rejected-token recovery", ({ provider, route }) => {
    it.each([
      {
        name: "401",
        statuses: [401, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "429 then 401",
        statuses: [429, 401, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "same-token refresh",
        statuses: [401, 200],
        refreshStatus: 200,
        sameToken: true,
      },
      {
        name: "401 then 429",
        statuses: [401, 429, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "401 after both retry budgets",
        statuses: [401, 429, 401],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "repeated 401",
        statuses: [401, 401],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "refresh outage",
        statuses: [401],
        refreshStatus: 503,
        sameToken: false,
      },
    ])(
      "bounds $name recovery and never reuses rejected fallback credentials",
      async ({ statuses, refreshStatus, sameToken }) => {
        let now = 1_800_000_000_000;
        let refreshCalls = 0;
        let oauthStatus = refreshStatus;
        const newToken = sameToken
          ? "oauth-old"
          : testJwt({ exp: now / 1_000 + 3600 });
        const authorizations: Array<string | null> = [];
        const fixture = await createOAuthRequestFixture(
          provider,
          async (input, init) => {
            if (String(input).endsWith("/oauth/token")) {
              refreshCalls += 1;
              return Response.json(
                oauthStatus === 200
                  ? { access_token: newToken, expires_in: 3600 }
                  : { error: "temporarily_unavailable" },
                { status: oauthStatus },
              );
            }
            authorizations.push(
              new Headers(init?.headers).get("authorization"),
            );
            return Response.json(
              { result: "upstream" },
              {
                status: statuses[authorizations.length - 1] ?? 200,
                headers: { "retry-after": "0" },
              },
            );
          },
          () => now,
        );
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          {
            headers: authHeaders(fixture.key),
            body: "{}",
          },
        );
        await response.text();
        expect(response.status).toBe(
          refreshStatus === 503 ? 503 : statuses.at(-1),
        );
        expect(refreshCalls).toBe(1);
        expect(authorizations).toEqual(
          statuses.map(
            (_status, index) =>
              `Bearer ${index > statuses.indexOf(401) && refreshStatus === 200 ? newToken : "oauth-old"}`,
          ),
        );
        if (refreshStatus === 503) {
          const held = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: authHeaders(fixture.key),
              body: "{}",
            },
          );
          await held.text();
          expect(held.status).toBe(503);
          expect(authorizations).toHaveLength(1);
          expect(refreshCalls).toBe(1);
          now += 1_000;
          oauthStatus = 200;
          const recovered = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: authHeaders(fixture.key),
              body: "{}",
            },
          );
          await recovered.text();
          expect(recovered.status).toBe(200);
          expect(refreshCalls).toBe(2);
          expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
        }
      },
    );

    it("joins an unchanged normal flight once and reuses replacement tokens after a late 401", async () => {
      const now = 1_800_000_000_000;
      const newToken = testJwt({ exp: now / 1_000 + 3600 });
      const oldResponses: Array<() => void> = [];
      const authorizations: Array<string | null> = [];
      let refreshCalls = 0;
      let releaseRefresh = () => {};
      const refreshReleased = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const fixture = await createOAuthRequestFixture(
        provider,
        async (input, init) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            await refreshReleased;
            return Response.json({ access_token: newToken, expires_in: 3600 });
          }
          const authorization = new Headers(init?.headers).get("authorization");
          authorizations.push(authorization);
          if (authorization === "Bearer oauth-old") {
            await new Promise<void>((resolve) => {
              oldResponses.push(resolve);
            });
            return Response.json(
              { error: { message: "expired access token" } },
              { status: 401 },
            );
          }
          return Response.json({ result: "refreshed" });
        },
        () => now,
      );
      // This OAuth race intentionally needs three overlapping upstream calls.
      await fixture.host.harness.behavior.callRpc("config.set",{maxConcurrentRequestsPerAccount:3});
      const requests = [1, 2].map(() =>
        fixture.host.harness.behavior.fetchHttp("POST", route, {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      let releaseRead = () => {};
      const readReleased = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const originalRead = AccountStore.prototype.readSecret;
      const read = vi.spyOn(AccountStore.prototype, "readSecret");
      try {
        await vi.waitFor(() => expect(oldResponses).toHaveLength(2));
        read.mockImplementation(async function (this: AccountStore, id) {
          const secret = await originalRead.call(this, id);
          await readReleased;
          return secret;
        });
        read.mockClear();
        requests.push(
          fixture.host.harness.behavior.fetchHttp("POST", route, {
            headers: authHeaders(fixture.key),
            body: "{}",
          }),
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        oldResponses[0]?.();
        oldResponses[1]?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseRead();
        await vi.waitFor(() => {
          expect(oldResponses).toHaveLength(3);
          expect(refreshCalls).toBe(1);
        });
        releaseRefresh();
        const first = await Promise.all(requests.slice(0, 2));
        expect(first.map((response) => response.status)).toEqual([200, 200]);
        await Promise.all(first.map((response) => response.text()));
        oldResponses[2]?.();
        const late = await requests[2];
        expect(late?.status).toBe(200);
        await late?.text();
        expect(refreshCalls).toBe(1);
        expect(
          authorizations.filter((value) => value === `Bearer ${newToken}`),
        ).toHaveLength(3);
        const accounts = z
          .array(accountSummarySchema)
          .parse(
            await fixture.host.harness.behavior.callRpc("account.list", null),
          );
        expect(accounts[0]?.error).toBeNull();
      } finally {
        releaseRead();
        releaseRefresh();
        for (const release of oldResponses) release();
        await Promise.allSettled(
          requests.map(async (request) => {
            const response = await request;
            await response.text();
          }),
        );
        read.mockRestore();
      }
    });
  });

  it.each(["terminal", "same-token cooldown"])(
    "keeps late 401 recovery bounded after a %s refresh",
    async (outcome) => {
      const oldResponse = deferred();
      const refreshed = deferred();
      let now = 1_800_000_000_000;
      let attempts = 0;
      let refreshCalls = 0;
      const fixture = await createOAuthRequestFixture(
        "claude",
        async (input) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            if (refreshCalls === 1)
              return Response.json(
                {
                  error:
                    outcome === "terminal"
                      ? "invalid_grant"
                      : "temporarily_unavailable",
                },
                { status: outcome === "terminal" ? 400 : 503 },
              );
            await refreshed.promise;
            return Response.json({
              access_token: "oauth-old",
              expires_in: 3600,
            });
          }
          attempts += 1;
          const attempt = attempts;
          if (attempt === 1) await oldResponse.promise;
          return Response.json({}, { status: attempt <= 2 ? 401 : 200 });
        },
        () => now,
      );
      const send = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        });
      const requests = [send()];
      try {
        await vi.waitFor(() => expect(attempts).toBe(1));
        const rejected = await send();
        expect(rejected.status).toBe(outcome === "terminal" ? 401 : 503);
        await rejected.text();
        if (outcome === "same-token cooldown") {
          now += 1_000;
          requests.push(send());
          await vi.waitFor(() => expect(refreshCalls).toBe(2));
        }
        oldResponse.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        refreshed.resolve();
        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.text()));
        expect(responses.map((response) => response.status)).toEqual(
          outcome === "terminal" ? [401] : [200, 200],
        );
        expect(refreshCalls).toBe(outcome === "terminal" ? 1 : 2);
        expect(attempts).toBe(outcome === "terminal" ? 2 : 4);
      } finally {
        oldResponse.resolve();
        refreshed.resolve();
        await Promise.allSettled(
          requests.map(async (request) => (await request).text()),
        );
      }
    },
  );

  it.each([false, true])(
    "separates rejection checks from credential flights when the reporting request is canceled: %s",
    async (cancelReporter) => {
      let attempts = 0;
      const fixture = await createOAuthRequestFixture(
        "claude",
        async (input) => {
          if (String(input).endsWith("/oauth/token"))
            return Response.json({
              access_token: "oauth-new",
              expires_in: 3600,
            });
          attempts += 1;
          return Response.json({}, { status: attempts <= 2 ? 401 : 200 });
        },
        () => 1_800_000_000_000,
      );
      const gate = deferred();
      const checking = deferred();
      const originalRead = AccountStore.prototype.readSecret;
      let reads = 0;
      const read = vi
        .spyOn(AccountStore.prototype, "readSecret")
        .mockImplementation(async function (this: AccountStore, id) {
          const secret = await originalRead.call(this, id);
          reads += 1;
          if (reads === 3) {
            checking.resolve();
            await gate.promise;
          }
          return secret;
        });
      const recordUsed = vi.spyOn(AccountStore.prototype, "recordUsed");
      const controller = new AbortController();
      const requests = [
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
          signal: controller.signal,
        }),
      ];
      try {
        await checking.promise;
        requests.push(
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: "{}",
          }),
        );
        await vi.waitFor(() => expect(recordUsed).toHaveBeenCalledTimes(2));
        await Promise.all(
          recordUsed.mock.results.map((result) => result.value),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (cancelReporter) controller.abort();
        gate.resolve();
        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.text()));
        expect(responses.map((response) => response.status)).toEqual(
          cancelReporter ? [499, 200] : [401, 403],
        );
        expect(attempts).toBe(cancelReporter ? 3 : 2);
      } finally {
        gate.resolve();
        await Promise.allSettled(
          requests.map(async (request) => (await request).text()),
        );
        read.mockRestore();
        recordUsed.mockRestore();
      }
    },
  );

  it("cancels one forced-refresh waiter without canceling shared recovery", async () => {
    const gate = deferred();
    let refreshCalls = 0;
    const authorizations: Array<string | null> = [];
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          await gate.promise;
          return Response.json({ access_token: "oauth-new", expires_in: 3600 });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        authorizations.push(authorization);
        return Response.json(
          {},
          { status: authorization === "Bearer oauth-old" ? 401 : 200 },
        );
      },
      () => 1_800_000_000_000,
    );
    const controller = new AbortController();
    const requests = [controller.signal, undefined].map((signal) =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
        signal,
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(authorizations).toHaveLength(2);
        expect(refreshCalls).toBe(1);
      });
      controller.abort();
      const canceled = await requests[0];
      expect(canceled?.status).toBe(499);
      await canceled?.text();
      gate.resolve();
      const recovered = await requests[1];
      expect(recovered?.status).toBe(200);
      await recovered?.text();
      expect(refreshCalls).toBe(1);
      expect(authorizations).toEqual([
        "Bearer oauth-old",
        "Bearer oauth-old",
        "Bearer oauth-new",
      ]);
    } finally {
      gate.resolve();
      await Promise.allSettled(
        requests.map(async (request) => (await request).text()),
      );
    }
  });

  it("does not let a late second 401 poison a newer credential", async () => {
    const gate = deferred();
    let refreshCalls = 0;
    let newAttempts = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return Response.json({
            access_token: `oauth-new-${refreshCalls}`,
            expires_in: 3600,
          });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer oauth-new-2") return Response.json({});
        if (authorization === "Bearer oauth-new-1") {
          newAttempts += 1;
          if (newAttempts === 1) await gate.promise;
        }
        return Response.json({ error: "rejected token" }, { status: 401 });
      },
      () => 1_800_000_000_000,
    );
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      });
    const first = send();
    try {
      await vi.waitFor(() => expect(newAttempts).toBe(1));
      const second = await send();
      expect(second.status).toBe(200);
      await second.text();
      gate.resolve();
      const late = await first;
      expect(late.status).toBe(401);
      await late.text();
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(accounts[0]?.error).toBeNull();
      const next = await send();
      expect(next.status).toBe(200);
      await next.text();
      expect(refreshCalls).toBe(2);
    } finally {
      gate.resolve();
      const response = await first;
      if (!response.bodyUsed) await response.text();
    }
  });

  it("honors a newer token's rejected cooldown when an older 401 arrives late", async () => {
    const gate = deferred();
    let now = 1_800_000_000_000;
    let refreshCalls = 0;
    let attempts = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return refreshCalls === 2
            ? Response.json({}, { status: 503 })
            : Response.json({
                access_token: `oauth-new-${refreshCalls}`,
                expires_in: 3600,
              });
        }
        attempts += 1;
        if (attempts === 1) await gate.promise;
        return Response.json(
          {},
          { status: attempts === 3 || attempts >= 5 ? 200 : 401 },
        );
      },
      () => now,
    );
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      });
    const first = send();
    try {
      await vi.waitFor(() => expect(attempts).toBe(1));
      const second = await send();
      expect(second.status).toBe(200);
      await second.text();
      const rejected = await send();
      expect(rejected.status).toBe(503);
      await rejected.text();
      gate.resolve();
      const late = await first;
      expect(late.status).toBe(503);
      await late.text();
      const held = await send();
      expect(held.status).toBe(503);
      await held.text();
      expect(attempts).toBe(4);
      now += 1_000;
      const recovered = await send();
      expect(recovered.status).toBe(200);
      await recovered.text();
      expect(refreshCalls).toBe(3);
    } finally {
      gate.resolve();
      const response = await first;
      if (!response.bodyUsed) await response.text();
    }
  });

  it.each(["never ends", "cancel rejects", "cancel hangs"])(
    "bounds failed response disposal when the body %s",
    async (behavior) => {
      const cancel = vi.fn(() =>
        behavior === "cancel hangs"
          ? new Promise<void>(() => {})
          : behavior === "cancel rejects"
            ? Promise.reject(new Error("cancel failed"))
            : Promise.resolve(),
      );
      let attempts = 0;
      const fixture: Fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        priority: 0,
        options: {
          fetch: async (_input, init) => {
            attempts += 1;
            if (attempts === 1)
              return new Response(
                new ReadableStream({
                  start(controller) {
                    if (behavior !== "never ends")
                      controller.enqueue(new Uint8Array(2048).fill(65));
                  },
                  cancel,
                }),
                { status: 503 },
              );
            const status = statusSchema.parse(
              await fixture.host.harness.behavior.callRpc("status.get", null),
            );
            expect(
              status.accounts.find(
                (account) => account.id === fixture.account.id,
              )?.inFlight,
            ).toBe(0);
            expect(init?.signal?.aborted).toBe(false);
            return Response.json({});
          },
        },
      });
      await addApiAccount(fixture, "sk-backup", 100);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(attempts).toBe(2);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("finishes a successful in-flight fetch during graceful hub shutdown", async () => {
    const gate = deferred();
    const started = deferred();
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          started.resolve();
          await gate.promise;
          return Response.json({});
        },
      },
    });
    const request = fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    await started.promise;
    fixture.service.controller.abort();
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(false);
    });
    gate.resolve();
    const response = await request;
    expect(response.status).toBe(200);
    await response.text();
    await fixture.service.done;
  });

  it("accepts requests after stopping and restarting the hub service", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: { fetch: async () => Response.json({}) },
    });
    fixture.service.controller.abort();
    await fixture.service.done;
    const restarted = fixture.host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      restarted.controller.abort();
      await restarted.done;
    });
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(true);
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    await response.text();
  });

  it.each([true, false])(
    "uses only the initial account snapshot with a healthy fourth account: %s",
    async (healthyFourth) => {
      const attempts: Array<string | null> = [];
      const fixture: Fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-1",
        priority: 1,
        options: {
          fetch: async (_input, init) => {
            const key = new Headers(init?.headers).get("x-api-key");
            attempts.push(key);
            if (attempts.length === 1)
              await addApiAccount(fixture, "sk-late", -1);
            return Response.json(
              { result: key },
              {
                status:
                  key === "sk-late" || (healthyFourth && key === "sk-4")
                    ? 200
                    : 503,
              },
            );
          },
        },
      });
      for (const account of [2, 3, 4])
        await addApiAccount(fixture, `sk-${account}`, account);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: "{}",
        },
      );
      await response.text();
      expect(response.status).toBe(healthyFourth ? 200 : 503);
      expect(attempts).toEqual(["sk-1", "sk-2", "sk-3", "sk-4"]);
    },
  );

  it("does not start another inference after cancellation during pacing", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? new Response(
                new ReadableStream({
                  cancel() {
                    controller.abort();
                  },
                }),
                { status: 429, headers: { "retry-after": "0" } },
              )
            : Response.json({});
        },
      },
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
        signal: controller.signal,
      },
    );
    await response.text();
    expect(attempts).toBe(1);
  });

  it("never replays a committed SSE stream on another account", async () => {
    let failStream = () => {};
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          attempts += 1;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("data: started\n\n"),
                );
                failStream = () =>
                  controller.error(new Error("stream disconnected"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    });
    await addApiAccount(fixture, "sk-backup");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing SSE stream.");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "data: started\n\n",
    );
    failStream();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: error",
    );
    expect((await reader.read()).done).toBe(true);
    expect(attempts).toBe(1);
  });

  describe("session affinity", () => {
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const claudeBody = (id: string, model = "claude-fable-5") =>
      JSON.stringify({
        model,
        metadata: {
          user_id: JSON.stringify({
            account_uuid: "invalid-account-uuid",
            device_id: "device",
            parent_session_id: "parent",
            session_id: id,
          }),
        },
      });
    const openStream = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: started\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );

    async function affinityFixture(
      provider: "claude" | "codex",
      upstreamFetch: typeof fetch,
      now = () => 1_800_000_000_000,
    ): Promise<Fixture> {
      let imported = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider,
        apiKey: "sk-first",
        source: provider === "codex" ? "import" : "api-key",
        options: {
          now,
          codexUsageUrl: EMPTY_USAGE_URL,
          fetch: (input, init) =>
            String(input) === EMPTY_USAGE_URL
              ? Promise.resolve(Response.json({}))
              : upstreamFetch(input, init),
          importCodexCredentials: async () => ({
            accessToken:
              ["sk-first", "sk-second", "sk-third"][imported++] ?? "sk-extra",
            refreshToken: "refresh",
            idToken: null,
            accountId: `codex-account-${imported}`,
            email: null,
            expiresAt: now() + 24 * 60 * 60 * 1_000,
          }),
        },
      });
      if (provider === "claude") await addApiAccount(fixture, "sk-second");
      else
        await fixture.host.harness.behavior.callRpc("account.add", {
          provider,
          source: { kind: "import" },
          label: null,
          priority: 100,
        });
      return fixture;
    }

    it.each(["claude", "codex"] as const)(
      "keeps %s sessions and the pool cursor on the third account after two failures",
      async (provider) => {
        let outage = false;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return Response.json(
              {},
              { status: outage && key !== "sk-third" ? 503 : 200 },
            );
          },
        );
        if (provider === "claude") await addApiAccount(fixture, "sk-third");
        else
          await fixture.host.harness.behavior.callRpc("account.add", {
            provider,
            source: { kind: "import" },
            label: null,
            priority: 100,
          });
        const send = async (id: string) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        };
        await send("warm");
        outage = true;
        await send("warm");
        await send("warm");
        await send("fresh");
        outage = false;
        await send("warm");
        await send("fresh-after-recovery");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-third",
          "sk-third",
          "sk-third",
          "sk-third",
          "sk-third",
        ]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "lets new %s conversations bypass long holds while preserving established pins",
      async (provider) => {
        let now = 1_800_000_000_000;
        let limited = false;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return limited && key === "sk-first"
              ? Response.json(
                  {},
                  { status: 429, headers: { "retry-after": "60" } },
                )
              : Response.json({});
          },
          () => now,
        );
        const send = async (id: string, status = 200, signal?: AbortSignal) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
              signal,
            },
          );
          expect(response.status).toBe(status);
          await response.text();
        };
        await send("warm");
        limited = true;
        await send("warm", 429);
        await send("fresh");
        await send("warm", 499, AbortSignal.timeout(30));
        now += 60_000;
        limited = false;
        await send("warm");
        await send("fresh-after-recovery");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-first",
          "sk-second",
        ]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "fails over immediately when a new %s conversation receives a long rate limit",
      async (provider) => {
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return key === "sk-first"
              ? Response.json(
                  {},
                  { status: 429, headers: { "retry-after": "60" } },
                )
              : Response.json({});
          },
        );
        for (const id of ["fresh", "another"]) {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        }
        expect(attempts).toEqual(["sk-first", "sk-second", "sk-second"]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "restores the %s cursor and distinct session pins after a full plugin reload",
      async (provider) => {
        let outage = false;
        const attempts: string[] = [];
        const upstreamFetch: typeof fetch = async (input, init) => {
          if (String(input) === EMPTY_USAGE_URL) return Response.json({});
          const headers = new Headers(init?.headers);
          const key =
            headers.get("x-api-key") ??
            headers.get("authorization")?.slice(7) ??
            "";
          attempts.push(key);
          return Response.json(
            {},
            { status: outage && key === "sk-first" ? 503 : 200 },
          );
        };
        const fixture = await affinityFixture(provider, upstreamFetch);
        let host = fixture.host;
        const send = async (id: string) => {
          const response = await host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        };
        await send("original");
        outage = true;
        await send("fallback");
        outage = false;
        host = await host.harness.lifecycle.reload(
          createAccountPoolPlugin({
    vpnPayload: async (timestamp) => vpnProof(timestamp, "connected"),
            fetch: upstreamFetch,
            now: () => 1_800_000_000_000,
            usageUrl: EMPTY_USAGE_URL,
            codexUsageUrl: EMPTY_USAGE_URL,
          }),
        );
        const service = host.harness.behavior.runService("hub");
        cleanups.push(async () => {
          service.controller.abort();
          await service.done;
          await host.harness.lifecycle.dispose();
        });
        await vi.waitFor(async () => {
          const status = statusSchema.parse(
            await host.harness.behavior.callRpc("status.get", null),
          );
          expect(status.accepting).toBe(true);
        });
        await send("fresh-after-restart");
        await send("original");
        await send("fallback");
        await send("another-fresh");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-second",
          "sk-first",
          "sk-second",
          "sk-second",
        ]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "runs %s sequentially across conversations and keeps a recovered earlier account as backup",
      async (provider) => {
        let now = 1_800_000_000_000;
        let rejected: string | null = null;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            if (key === rejected)
              return Response.json(
                {},
                {
                  status: 429,
                  headers:
                    provider === "claude"
                      ? {
                          "anthropic-ratelimit-unified-5h-status": "rejected",
                          "anthropic-ratelimit-unified-5h-reset": String(
                            now / 1000 + 60,
                          ),
                        }
                      : {
                          "x-codex-primary-over-limit": "true",
                          "x-codex-primary-reset-after-seconds": "60",
                        },
                },
              );
            return attempts.length === 1 ? openStream() : Response.json({});
          },
          () => now,
        );
        const send = (id: string) =>
          fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "thread-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
        const first = await send("original");
        try {
          await (await send("new-while-busy")).text();
          expect(attempts).toEqual(["sk-first", "sk-first"]);
          rejected = "sk-first";
          await (await send("failover")).text();
          now += 60_000;
          rejected = null;
          await (await send("new-after-recovery")).text();
          await (await send("original")).text();
          await (await send("another-new")).text();
          expect(attempts).toEqual([
            "sk-first",
            "sk-first",
            "sk-first",
            "sk-second",
            "sk-second",
            "sk-first",
            "sk-second",
          ]);
          rejected = "sk-second";
          await (await send("wrap")).text();
          expect(attempts.slice(-2)).toEqual(["sk-second", "sk-first"]);
        } finally {
          await first.body?.cancel();
        }
      },
    );

    it.each(["claude", "codex"] as const)(
      "handles %s quota exhaustion and reset with session affinity",
      async (provider) => {
        let now = 1_800_000_000_000;
        const exhausted = new Set<string>();
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7);
            if (key === undefined)
              throw new Error("Missing account credential.");
            attempts.push(key);
            if (!exhausted.has(key)) return Response.json({ account: key });
            const resetSeconds = key === "sk-first" ? 60 : 120;
            return Response.json(
              { error: { message: "Account usage exhausted." } },
              {
                status: 429,
                headers:
                  provider === "claude"
                    ? {
                        "anthropic-ratelimit-unified-5h-status": "rejected",
                        "anthropic-ratelimit-unified-5h-reset": String(
                          now / 1000 + resetSeconds,
                        ),
                      }
                    : {
                        "x-codex-primary-used-percent": "100",
                        "x-codex-primary-window-minutes": "300",
                        "x-codex-primary-reset-after-seconds":
                          String(resetSeconds),
                      },
              },
            );
          },
          () => now,
        );
        const send = () =>
          fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: {
                ...authHeaders(fixture.key),
                "session-id": sessionId,
                "thread-id": "quota-thread",
              },
              body:
                provider === "claude"
                  ? claudeBody(sessionId)
                  : JSON.stringify({ model: "gpt-5", input: [] }),
            },
          );
        const expectAccount = async (account: string) => {
          const response = await send();
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ account });
        };

        await expectAccount("sk-first");
        exhausted.add("sk-first");
        await expectAccount("sk-second");
        await expectAccount("sk-second");
        now += 60_000;
        exhausted.delete("sk-first");
        await expectAccount("sk-second");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-second",
          "sk-second",
        ]);

        exhausted.add("sk-first");
        exhausted.add("sk-second");
        const unavailable = await send();
        expect(unavailable.status).toBe(403);
        expect(unavailable.headers.get("retry-after")).toBeNull();
        await unavailable.text();
        expect(attempts.slice(5)).toEqual(["sk-second", "sk-first"]);
        const stillUnavailable = await send();
        expect(stillUnavailable.status).toBe(403);
        expect(stillUnavailable.headers.get("retry-after")).toBeNull();
        await stillUnavailable.text();
        expect(attempts).toHaveLength(7);

        now += 60_000;
        exhausted.delete("sk-first");
        await expectAccount("sk-first");
        await expectAccount("sk-first");
        expect(attempts.slice(7)).toEqual(["sk-first", "sk-first"]);
        const status = statusSchema.parse(
          await fixture.host.harness.behavior.callRpc("status.get", null),
        );
        expect(status.accounts.map((account) => account.status)).toEqual([
          "ready",
          "exhausted",
        ]);
      },
    );

    describe("parent affinity", () => {
      type Wire =
        | "claude"
        | "codex-fork"
        | "codex-shared-session"
        | "codex-body"
        | "codex-parent-header"
        | "codex-parent-body"
        | "codex-spawn";
      function forkRequest(
        wire: Wire,
        own: string,
        parent: string | null,
      ): { headers: Record<string, string>; body: string } {
        if (wire === "claude")
          return {
            headers: {},
            body: JSON.stringify({
              model: "claude-fable-5",
              metadata: {
                user_id: JSON.stringify({
                  session_id: own,
                  parent_session_id: parent,
                  device_id: "device",
                  account_uuid: "invalid-account-uuid",
                  extra: "keep",
                }),
              },
              messages: [{ role: "user", content: "Identical cached prefix" }],
            }),
          };
        const session =
          (wire === "codex-shared-session" || wire === "codex-body") &&
          parent !== null
            ? parent
            : own;
        const turn = {
          session_id: session,
          thread_id: own,
          forked_from_thread_id:
            wire === "codex-fork" ||
            wire === "codex-shared-session" ||
            wire === "codex-body"
              ? parent
              : null,
          parent_thread_id: wire === "codex-spawn" ? parent : null,
          extra: "keep",
        };
        const bodyOnly = wire === "codex-body" || wire === "codex-parent-body";
        const headers: Record<string, string> = { "session-id": session };
        if (!bodyOnly) headers["thread-id"] = own;
        if (!bodyOnly) headers["x-codex-turn-metadata"] = JSON.stringify(turn);
        if (wire === "codex-parent-header" && parent !== null)
          headers["x-codex-parent-thread-id"] = parent;
        return {
          headers,
          body: JSON.stringify({
            model: "gpt-5",
            prompt_cache_key: "shared-parent-cache",
            client_metadata: {
              session_id: session,
              thread_id: own,
              "x-codex-turn-metadata": JSON.stringify(turn),
              ...(wire === "codex-parent-body" && parent !== null
                ? { "x-codex-parent-thread-id": parent }
                : {}),
            },
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: "Identical cached prefix" },
                ],
              },
              { type: "compaction", encrypted_content: "preserve" },
            ],
          }),
        };
      }

      it.each<Wire>(["claude", "codex-fork"])(
        "keeps a fork on its short-held parent account over %s",
        async (wire) => {
          const provider = wire === "claude" ? "claude" : "codex";
          const attempts: Array<string | null> = [];
          const fixture = await affinityFixture(
            provider,
            async (_input, init) => {
              const headers = new Headers(init?.headers);
              attempts.push(
                headers.get("x-api-key") ??
                  headers.get("authorization")?.slice(7) ??
                  null,
              );
              return attempts.length === 3
                ? Response.json(
                    {},
                    { status: 429, headers: { "retry-after": "0.25" } },
                  )
                : Response.json({});
            },
            Date.now,
          );
          const send = (own: string, parent: string | null) => {
            const request = forkRequest(wire, own, parent);
            return fixture.host.harness.behavior.fetchHttp(
              "POST",
              provider === "claude" ? "/v1/messages" : "/v1/responses",
              {
                headers: { ...authHeaders(fixture.key), ...request.headers },
                body: request.body,
              },
            );
          };
          await (await send("parent", null)).text();
          await movePoolToOtherAccount(fixture, provider);
          const paced = send("parent", null);
          try {
            await vi.waitFor(
              async () => {
                const status = statusSchema.parse(
                  await fixture.host.harness.behavior.callRpc(
                    "status.get",
                    null,
                  ),
                );
                expect(
                  status.accounts.find(
                    (account) => account.id === fixture.account.id,
                  )?.status,
                ).toBe("held");
              },
              { interval: 5 },
            );
            const child = await send("child", "parent");
            expect(child.status).toBe(200);
            await child.text();
            await (await paced).text();
            await (await send("child", "parent")).text();
            expect(attempts).toEqual([
              "sk-first",
              "sk-second",
              "sk-first",
              "sk-first",
              "sk-first",
              "sk-first",
            ]);
          } finally {
            const response = await paced;
            if (!response.bodyUsed) await response.text();
          }
        },
      );

      it.each<Wire>([
        "claude",
        "codex-fork",
        "codex-shared-session",
        "codex-body",
        "codex-parent-header",
        "codex-parent-body",
        "codex-spawn",
      ])(
        "inherits the eligible %s parent once and keeps child failover independent",
        async (wire) => {
          const provider = wire === "claude" ? "claude" : "codex";
          const route =
            provider === "claude" ? "/v1/messages" : "/v1/responses";
          const seen: Array<{ key: string | null; body: string }> = [];
          let rejectNext = false;
          const fixture = await affinityFixture(
            provider,
            async (_input, init) => {
              const headers = new Headers(init?.headers);
              seen.push({
                key:
                  headers.get("x-api-key") ??
                  headers.get("authorization")?.slice(7) ??
                  null,
                body: new TextDecoder().decode(
                  init?.body instanceof ArrayBuffer
                    ? init.body
                    : new ArrayBuffer(0),
                ),
              });
              if (seen.length === 1) return openStream();
              if (rejectNext) {
                rejectNext = false;
                return Response.json({}, { status: 503 });
              }
              return Response.json({});
            },
          );
          const send = (own: string, parent: string | null) => {
            const request = forkRequest(wire, own, parent);
            return fixture.host.harness.behavior.fetchHttp("POST", route, {
              headers: { ...authHeaders(fixture.key), ...request.headers },
              body: request.body,
            });
          };
          const held = await send("parent-session", null);
          try {
            const child = await send("child-session", "parent-session");
            expect(child.status).toBe(200);
            await child.text();
            expect(seen[1]?.key).toBe("sk-first");
            expect(seen[1]?.body).toBe(
              forkRequest(wire, "child-session", "parent-session").body,
            );
            rejectNext = true;
            const failover = await send("child-session", "parent-session");
            expect(failover.status).toBe(200);
            await failover.text();
            const parent = await send("parent-session", null);
            await parent.text();
            const repeatedChild = await send("child-session", "parent-session");
            await repeatedChild.text();
            expect(seen.map(({ key }) => key)).toEqual([
              "sk-first",
              "sk-first",
              "sk-first",
              "sk-second",
              "sk-first",
              "sk-second",
            ]);
          } finally {
            await held.body?.cancel();
          }
        },
      );

      describe.each<"claude" | "codex">(["claude", "codex"])(
        "%s parent eligibility",
        (provider) => {
          const wire = provider === "claude" ? "claude" : "codex-fork";
          const route =
            provider === "claude" ? "/v1/messages" : "/v1/responses";
          it.each(["disabled", "expired", "missing", "other host"])(
            "uses ordinary selection when the parent is %s",
            async (reason) => {
              let now = 1_800_000_000_000;
              const attempts: Array<string | null> = [];
              const fixture = await affinityFixture(
                provider,
                async (_input, init) => {
                  const headers = new Headers(init?.headers);
                  attempts.push(
                    headers.get("x-api-key") ??
                      headers.get("authorization")?.slice(7) ??
                      null,
                  );
                  return attempts.length === 1
                    ? openStream()
                    : Response.json({});
                },
                () => now,
              );
              const parent = forkRequest(wire, "parent-session", null);
              const held = await fixture.host.harness.behavior.fetchHttp(
                "POST",
                route,
                {
                  headers: { ...authHeaders(fixture.key), ...parent.headers },
                  body: parent.body,
                },
              );
              try {
                await movePoolToOtherAccount(fixture, provider);
                attempts.splice(1);
                if (reason === "disabled")
                  await fixture.host.harness.behavior.callRpc(
                    "account.disable",
                    { id: fixture.account.id },
                  );
                if (reason === "expired") now += 31 * 60 * 1_000;
                const key =
                  reason === "other host"
                    ? provider === "claude"
                      ? await resolveToken(fixture.host, "host-two")
                      : (await resolveCodexToken(fixture.host, "host-two"))
                          .token
                    : fixture.key;
                const request = forkRequest(
                  wire,
                  "child-session",
                  reason === "missing" ? "missing-parent" : "parent-session",
                );
                const child = await fixture.host.harness.behavior.fetchHttp(
                  "POST",
                  route,
                  {
                    headers: { ...authHeaders(key), ...request.headers },
                    body: request.body,
                  },
                );
                expect(child.status).toBe(200);
                await child.text();
                expect(attempts).toEqual(["sk-first", "sk-second"]);
              } finally {
                await held.body?.cancel();
              }
            },
          );

          it("does not extend the parent lifetime when a child inherits its account", async () => {
            let now = 1_800_000_000_000;
            const attempts: Array<string | null> = [];
            const fixture = await affinityFixture(
              provider,
              async (_input, init) => {
                const headers = new Headers(init?.headers);
                attempts.push(
                  headers.get("x-api-key") ??
                    headers.get("authorization")?.slice(7) ??
                    null,
                );
                return attempts.length === 1 ? openStream() : Response.json({});
              },
              () => now,
            );
            const send = (own: string, parent: string | null) => {
              const request = forkRequest(wire, own, parent);
              return fixture.host.harness.behavior.fetchHttp("POST", route, {
                headers: { ...authHeaders(fixture.key), ...request.headers },
                body: request.body,
              });
            };
            const held = await send("parent-session", null);
            try {
              await movePoolToOtherAccount(fixture, provider);
              attempts.splice(1);
              now += 29 * 60 * 1_000;
              await (await send("child-session", "parent-session")).text();
              now += 2 * 60 * 1_000;
              await (await send("parent-session", null)).text();
              await (await send("child-session", "parent-session")).text();
              expect(attempts).toEqual([
                "sk-first",
                "sk-first",
                "sk-second",
                "sk-first",
              ]);
            } finally {
              await held.body?.cancel();
            }
          });
        },
      );

      it("does not inherit a parent binding from another provider", async () => {
        const attempts: Array<string | null> = [];
        const fixture = await affinityFixture("codex", async (_input, init) => {
          const headers = new Headers(init?.headers);
          attempts.push(
            headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              null,
          );
          return attempts.length <= 2 ? openStream() : Response.json({});
        });
        await addApiAccount(fixture, "sk-claude-parent");
        const claude = forkRequest("claude", "parent-session", null);
        const codex = forkRequest("codex-fork", "unrelated-session", null);
        const held = [
          await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/messages",
            { headers: authHeaders(fixture.key), body: claude.body },
          ),
          await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), ...codex.headers },
              body: codex.body,
            },
          ),
        ];
        try {
          await movePoolToOtherAccount(fixture, "codex");
          attempts.splice(2);
          const request = forkRequest(
            "codex-fork",
            "child-session",
            "parent-session",
          );
          const child = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), ...request.headers },
              body: request.body,
            },
          );
          expect(child.status).toBe(200);
          await child.text();
          expect(attempts).toEqual([
            "sk-claude-parent",
            "sk-first",
            "sk-second",
          ]);
        } finally {
          for (const response of held) await response.body?.cancel();
        }
      });
    });

    it.each<{
      name: string;
      provider: "claude" | "codex";
      headers: Record<string, string>;
      body: string;
    }>([
      {
        name: "Claude JSON",
        provider: "claude",
        headers: {},
        body: claudeBody(sessionId),
      },
      {
        name: "Claude legacy",
        provider: "claude",
        headers: {},
        body: JSON.stringify({
          metadata: {
            user_id: `user_hash_account_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_session_${sessionId}`,
          },
        }),
      },
      {
        name: "Codex native",
        provider: "codex",
        headers: { "session-id": sessionId, "thread-id": "native-thread" },
        body: "{}",
      },
      {
        name: "Codex legacy",
        provider: "codex",
        headers: { session_id: sessionId },
        body: "{}",
      },
      {
        name: "Codex cache",
        provider: "codex",
        headers: {},
        body: JSON.stringify({ prompt_cache_key: sessionId }),
      },
    ])(
      "keeps $name sessions sticky with host isolation and idle expiry",
      async ({ provider, headers, body }) => {
        let now = 1_800_000_000_000;
        const attempts: Array<string | null> = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const requestHeaders = new Headers(init?.headers);
            attempts.push(
              provider === "claude"
                ? requestHeaders.get("x-api-key")
                : requestHeaders.get("authorization"),
            );
            return attempts.length === 1 ? openStream() : Response.json({});
          },
          () => now,
        );
        const route = provider === "claude" ? "/v1/messages" : "/v1/responses";
        const keyFor = (key: string) =>
          provider === "claude" ? key : `Bearer ${key}`;
        const send = async (
          key: string,
          requestBody: string,
          sessionHeaders = headers,
        ) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: { ...authHeaders(key), ...sessionHeaders },
              body: requestBody,
            },
          );
          await response.text();
          expect(response.status).toBe(200);
          return attempts.at(-1);
        };
        const held = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          {
            headers: { ...authHeaders(fixture.key), ...headers },
            body,
          },
        );
        try {
          const otherHost =
            provider === "codex"
              ? (await resolveCodexToken(fixture.host, "host-two")).token
              : await resolveToken(fixture.host, "host-two");
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fixture.account.id,
          });
          expect(await send(otherHost, body)).toBe(keyFor("sk-second"));
          await fixture.host.harness.behavior.callRpc("account.enable", {
            id: fixture.account.id,
          });
          expect(await send(fixture.key, "{}", {})).toBe(keyFor("sk-second"));
          now += 29 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          now += 2 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          now += 31 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-second"));
        } finally {
          await held.body?.cancel();
        }
      },
    );

    it("separates Codex session and cache namespaces and prefers the native header", async () => {
      const attempts: Array<string | null> = [];
      const fixture = await affinityFixture("codex", async (_input, init) => {
        attempts.push(new Headers(init?.headers).get("authorization"));
        return attempts.length === 1 ? openStream() : Response.json({});
      });
      const held = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: { ...authHeaders(fixture.key), "session-id": sessionId },
          body: "{}",
        },
      );
      try {
        await movePoolToOtherAccount(fixture, "codex");
        attempts.splice(1);
        const variants: Array<Record<string, string>> = [
          {},
          { session_id: sessionId },
          { "session-id": sessionId, session_id: "different-session" },
        ];
        for (const headers of variants) {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), ...headers },
              body: JSON.stringify({ prompt_cache_key: sessionId }),
            },
          );
          await response.text();
        }
        expect(attempts).toEqual([
          "Bearer sk-first",
          "Bearer sk-second",
          "Bearer sk-first",
          "Bearer sk-first",
        ]);
      } finally {
        await held.body?.cancel();
      }
    });

    it.each([
      "family quota",
      "auth error",
      "disabled account",
      "network error",
    ])(
      "preserves the correct binding after %s despite an older response completion",
      async (reason) => {
        const attempts: Array<string | null> = [];
        let finishOld = () => {};
        const fixture = await createFixture({
          upstreamUrl: "https://upstream.example",
          apiKey: "sk-first",
          options: {
            fetch: async (_input, init) => {
              const key = new Headers(init?.headers).get("x-api-key");
              attempts.push(key);
              if (attempts.length === 1)
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode("data: old\n\n"),
                      );
                      finishOld = () => {
                        controller.close();
                        finishOld = () => {};
                      };
                    },
                  }),
                  {
                    headers:
                      reason === "family quota"
                        ? {
                            "anthropic-ratelimit-unified-7d_fable-status":
                              "rejected",
                            "anthropic-ratelimit-unified-7d_fable-reset":
                              "4102444800",
                          }
                        : {},
                  },
                );
              if (
                reason === "network error" &&
                key === "sk-first" &&
                attempts.length === 2
              )
                throw new TypeError("network failed");
              return Response.json(
                {},
                {
                  status:
                    reason === "auth error" &&
                    key === "sk-first" &&
                    attempts.length === 2
                      ? 403
                      : 200,
                },
              );
            },
          },
        });
        await addApiAccount(fixture, "sk-second");
        const send = (model: string) =>
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: claudeBody(sessionId, model),
          });
        const held = await send(
          reason === "family quota" ? "claude-fable-5" : "claude-opus-4-1",
        );
        try {
          if (reason === "disabled account")
            await fixture.host.harness.behavior.callRpc("account.disable", {
              id: fixture.account.id,
            });
          const rebound = await send("claude-fable-5");
          expect(rebound.status).toBe(200);
          await rebound.text();
          if (reason !== "family quota")
            await fixture.host.harness.behavior.callRpc("account.enable", {
              id: fixture.account.id,
            });
          finishOld();
          await held.text();
          const afterCompletion = await send("claude-opus-4-1");
          await afterCompletion.text();
          expect(attempts).toEqual(
            reason === "auth error" || reason === "network error"
              ? ["sk-first", "sk-first", "sk-second", "sk-second"]
              : [
                  "sk-first",
                  "sk-second",
                  reason === "family quota" ? "sk-first" : "sk-second",
                ],
          );
        } finally {
          finishOld();
          if (!held.bodyUsed) await held.body?.cancel();
        }
      },
    );

    it("shares the first binding when simultaneous account listings resume under different load", async () => {
      const attempts: Array<string | null> = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        options: {
          fetch: async (_input, init) => {
            attempts.push(new Headers(init?.headers).get("x-api-key"));
            return attempts.length === 1 ? openStream() : Response.json({});
          },
        },
      });
      await addApiAccount(fixture, "sk-second");
      const gates = [deferred(), deferred()];
      const originalList = AccountStore.prototype.list;
      let listings = 0;
      const list = vi
        .spyOn(AccountStore.prototype, "list")
        .mockImplementation(async function (this: AccountStore) {
          const index = listings++;
          const accounts = await originalList.call(this);
          if (index < 2) await gates[index]?.promise;
          return accounts;
        });
      const requests = [1, 2].map(() =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        }),
      );
      try {
        await vi.waitFor(() => expect(listings).toBe(2));
        gates[0]?.resolve();
        await vi.waitFor(() => expect(attempts).toHaveLength(1));
        gates[1]?.resolve();
        const responses = await Promise.all(requests);
        await responses[1]?.text();
        await responses[0]?.body?.cancel();
        expect(attempts).toEqual(["sk-first", "sk-first"]);
      } finally {
        for (const gate of gates) gate.resolve();
        await Promise.allSettled(
          requests.map(async (request) => {
            const response = await request;
            if (!response.bodyUsed) await response.body?.cancel();
          }),
        );
        list.mockRestore();
      }
    });

    it("keeps native Codex HTTP compaction continuations on the same account", async () => {
      const seen: Array<{ headers: Headers; body: string }> = [];
      const compacted = {
        type: "compaction",
        encrypted_content: "encrypted-compaction-fixture",
      };
      const fixture = await affinityFixture("codex", async (_input, init) => {
        seen.push({
          headers: new Headers(init?.headers),
          body: new TextDecoder().decode(
            init?.body instanceof ArrayBuffer ? init.body : new ArrayBuffer(0),
          ),
        });
        if (seen.length === 1) return openStream();
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${seen.length}`, output: [compacted] } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const headers = {
        ...authHeaders(fixture.key),
        "session-id": sessionId,
        "thread-id": "native-thread",
      };
      const held = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        { headers, body: "{}" },
      );
      try {
        const fields = {
          model: "gpt-5",
          prompt_cache_key: "cache-key",
          client_metadata: {
            session_id: "body-session",
            thread_id: "body-thread",
            "x-codex-turn-metadata": "fixture",
          },
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "high" },
        };
        const input = [
          {
            type: "reasoning",
            encrypted_content: "encrypted-reasoning-fixture",
          },
          { type: "compaction_trigger" },
        ];
        const first = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          { headers, body: JSON.stringify({ ...fields, input }) },
        );
        expect(first.status).toBe(200);
        await first.text();
        const delta = { type: "message", role: "user", content: "next" };
        const second = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          {
            headers,
            body: JSON.stringify({
              ...fields,
              input: [...input, compacted, delta],
            }),
          },
        );
        expect(second.status).toBe(200);
        await second.text();
        expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({
          ...fields,
          input,
        });
        expect(JSON.parse(seen[2]?.body ?? "{}")).toMatchObject({
          ...fields,
          input: [...input, compacted, delta],
        });
        expect(seen.map(({ headers }) => headers.get("session-id"))).toEqual([
          sessionId,
          sessionId,
          sessionId,
        ]);
        expect(seen.map(({ headers }) => headers.get("thread-id"))).toEqual([
          "native-thread",
          "native-thread",
          "native-thread",
        ]);
        expect(seen.map(({ headers }) => headers.get("authorization"))).toEqual(
          ["Bearer sk-first", "Bearer sk-first", "Bearer sk-first"],
        );
      } finally {
        await held.body?.cancel();
      }
    });

    it.each([false, true])(
      "preserves a newer session binding outside an older candidate snapshot with a fallback: %s",
      async (hasFallback) => {
        const gate = deferred();
        const attempts: Array<string | null> = [];
        const fixture = await createFixture({
          upstreamUrl: "https://upstream.example",
          apiKey: "sk-first",
          priority: 0,
          options: {
            fetch: async (_input, init) => {
              attempts.push(new Headers(init?.headers).get("x-api-key"));
              if (attempts.length === 1) {
                await gate.promise;
                return Response.json({}, { status: 503 });
              }
              return Response.json({});
            },
          },
        });
        const fallback = await addApiAccount(fixture, "sk-fallback", 20);
        if (!hasFallback)
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fallback.id,
          });
        const send = () =>
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: claudeBody(sessionId),
          });
        const old = send();
        try {
          await vi.waitFor(() => expect(attempts).toEqual(["sk-first"]));
          await addApiAccount(fixture, "sk-new", 10);
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fixture.account.id,
          });
          const rebound = await send();
          expect(rebound.status).toBe(200);
          await rebound.text();
          gate.resolve();
          const exhausted = await old;
          expect(exhausted.status).toBe(hasFallback ? 200 : 503);
          await exhausted.text();
          await fixture.host.harness.behavior.callRpc("account.enable", {
            id: fixture.account.id,
          });
          const next = await send();
          expect(next.status).toBe(200);
          await next.text();
          expect(attempts).toEqual(
            hasFallback
              ? ["sk-first", "sk-new", "sk-fallback", "sk-new"]
              : ["sk-first", "sk-new", "sk-new"],
          );
        } finally {
          gate.resolve();
          const response = await old;
          if (!response.bodyUsed) await response.text();
        }
      },
    );

    it("preserves a newer session binding to an already-attempted account", async () => {
      const gate = deferred();
      const attempts: Array<string | null> = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        priority: 0,
        options: {
          fetch: async (_input, init) => {
            const key = new Headers(init?.headers).get("x-api-key");
            attempts.push(key);
            if (attempts.length === 1)
              return Response.json({}, { status: 503 });
            if (key === "sk-second") {
              await gate.promise;
              return Response.json({}, { status: 503 });
            }
            return Response.json({});
          },
        },
      });
      const second = await addApiAccount(fixture, "sk-second", 10);
      await addApiAccount(fixture, "sk-fallback", 20);
      const send = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        });
      const old = send();
      try {
        await vi.waitFor(() =>
          expect(attempts).toEqual(["sk-first", "sk-second"]),
        );
        await fixture.host.harness.behavior.callRpc("account.disable", {
          id: second.id,
        });
        const rebound = await send();
        expect(rebound.status).toBe(200);
        await rebound.text();
        gate.resolve();
        const fallback = await old;
        expect(fallback.status).toBe(200);
        await fallback.text();
        const next = await send();
        expect(next.status).toBe(200);
        await next.text();
        expect(attempts).toEqual([
          "sk-first",
          "sk-second",
          "sk-first",
          "sk-fallback",
          "sk-first",
        ]);
      } finally {
        gate.resolve();
        const response = await old;
        if (!response.bodyUsed) await response.text();
      }
    });

    it("isolates provider bindings and retains them on hub restart", async () => {
      const attempts: Array<string | null> = [];
      const started = new Set<string>();
      const fixture = await affinityFixture("codex", async (_input, init) => {
        const headers = new Headers(init?.headers);
        const provider = headers.has("x-api-key") ? "claude" : "codex";
        attempts.push(headers.get("x-api-key") ?? headers.get("authorization"));
        if (!started.has(provider)) {
          started.add(provider);
          return openStream();
        }
        return Response.json({});
      });
      await addApiAccount(fixture, "sk-claude-first");
      const claudeSecond = await addApiAccount(fixture, "sk-claude-second");
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      const codexSecond = accounts.find(
        (account) => account.codexAccountId === "codex-account-2",
      );
      if (codexSecond === undefined)
        throw new Error("Missing second Codex account.");
      const sendClaude = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        });
      const sendCodex = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
          headers: { ...authHeaders(fixture.key), "session-id": sessionId },
          body: "{}",
        });
      const held = [await sendClaude(), await sendCodex()];
      try {
        for (const account of [claudeSecond, codexSecond])
          await fixture.host.harness.behavior.callRpc("account.setPriority", {
            accountId: account.id,
            priority: 0,
          });
        await (await sendClaude()).text();
        await (await sendCodex()).text();
        for (const response of held) await response.body?.cancel();
        fixture.service.controller.abort();
        await fixture.service.done;
        const restarted = fixture.host.harness.behavior.runService("hub");
        cleanups.push(async () => {
          restarted.controller.abort();
          await restarted.done;
        });
        await vi.waitFor(async () => {
          const status = statusSchema.parse(
            await fixture.host.harness.behavior.callRpc("status.get", null),
          );
          expect(status.accepting).toBe(true);
        });
        await (await sendClaude()).text();
        await (await sendCodex()).text();
        expect(attempts).toEqual([
          "sk-claude-first",
          "Bearer sk-first",
          "sk-claude-first",
          "Bearer sk-first",
          "sk-claude-first",
          "Bearer sk-first",
        ]);
      } finally {
        for (const response of held)
          if (!response.bodyUsed) await response.body?.cancel();
      }
    });

    it("evicts the least recently used binding at capacity", async () => {
      let lastKey: string | null = null;
      let attempts = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        options: {
          now: () => 1_800_000_000_000,
          maxAffinityBindings: 4,
          fetch: async (_input, init) => {
            lastKey = new Headers(init?.headers).get("x-api-key");
            attempts += 1;
            return attempts === 1 ? openStream() : Response.json({});
          },
        },
      });
      const second = await addApiAccount(fixture, "sk-second");
      const send = async (id: string) => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: authHeaders(fixture.key),
            body: claudeBody(id),
          },
        );
        await response.text();
        return lastKey;
      };
      const held = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: claudeBody("oldest"),
        },
      );
      try {
        await movePoolToOtherAccount(fixture, "claude");
        for (let index = 1; index < 4; index += 1)
          await send(`session-${index}`);
        const touched = await send("oldest");
        await send("newest");
        const retained = await send("oldest");
        await held.body?.cancel();
        await movePoolToOtherAccount(fixture, "claude", second.id);
        const nextOldest = await send("session-2");
        const evicted = await send("session-1");
        expect([touched, retained, nextOldest, evicted]).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-first",
        ]);
      } finally {
        if (!held.bodyUsed) await held.body?.cancel();
      }
    });
  });

  it("serializes refresh, writes new tokens with 0600 mode, and uses them", async () => {
    let now = 1_800_000_000_000;
    let refreshCalls = 0;
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/oauth/token") {
        refreshCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "oauth-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        now: () => now,
        importCredentials: async () =>
          importedCredentials({ expiresAt: now + 10 * 60 * 1_000 }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    expect(refreshCalls).toBe(0);
    now += 6 * 60 * 1_000;
    let releaseSecretReads = () => {};
    const secretReadsReleased = new Promise<void>((resolve) => {
      releaseSecretReads = resolve;
    });
    const readSecret = AccountStore.prototype.readSecret;
    const pendingSecretReads: ReturnType<typeof readSecret>[] = [];
    const readSecretSpy = vi
      .spyOn(AccountStore.prototype, "readSecret")
      .mockImplementation(async function (this: AccountStore, accountId) {
        const reading = readSecret.call(this, accountId);
        pendingSecretReads.push(reading);
        const secret = await reading;
        await secretReadsReleased;
        return secret;
      });
    const recordUsed = vi.spyOn(AccountStore.prototype, "recordUsed");
    const requests = [1, 2].map(() =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(recordUsed).toHaveBeenCalledTimes(2);
      });
      await Promise.all(recordUsed.mock.results.map((result) => result.value));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(pendingSecretReads);
      releaseSecretReads();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await Promise.all(responses.map((response) => response.text()));
    } finally {
      releaseSecretReads();
      await Promise.allSettled(requests);
      readSecretSpy.mockRestore();
      recordUsed.mockRestore();
    }
    expect(refreshCalls).toBe(1);
    expect(authorizations).toEqual(["Bearer oauth-new", "Bearer oauth-new"]);
    const secretPath = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      `account-${fixture.account.id}.json`,
    );
    const secret = accountSecretSchema.parse(
      JSON.parse(await fs.readFile(secretPath, "utf8")),
    );
    expect(secret).toMatchObject({
      kind: "oauth",
      accessToken: "oauth-new",
      refreshToken: "refresh-new",
    });
    expect((await fs.stat(secretPath)).mode & 0o777).toBe(0o600);
  });

  it("refreshes unrelated accounts independently", async () => {
    let now = 1_800_000_000_000;
    let releaseFirstRefresh = () => {};
    const firstRefreshReleased = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const refreshes: string[] = [];
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/oauth/token") {
        const { refresh_token } = z
          .object({ refresh_token: z.string() })
          .parse(JSON.parse((await readRequestBody(request)).toString()));
        refreshes.push(refresh_token);
        if (refresh_token === "refresh-1") await firstRefreshReleased;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: `new-${refresh_token}`,
            refresh_token: `next-${refresh_token}`,
            expires_in: 3600,
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    let imported = 0;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        now: () => now,
        importCredentials: async () => {
          imported += 1;
          return importedCredentials({
            accessToken: `access-${imported}`,
            refreshToken: `refresh-${imported}`,
            email: `account-${imported}@example.com`,
            expiresAt: now + 10 * 60 * 1_000,
          });
        },
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    const second = accountSchema.parse(
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "import" },
        label: "second",
        priority: 200,
      }),
    );
    expect(refreshes).toEqual([]);
    now += 6 * 60 * 1_000;
    const requests: Promise<Response>[] = [];
    try {
      requests.push(
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      await vi.waitFor(() => {
        expect(refreshes).toEqual(["refresh-1"]);
      });
      await fixture.host.harness.behavior.callRpc("account.disable", {
        id: fixture.account.id,
      });
      requests.push(
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      await vi.waitFor(() => {
        expect(authorizations).toEqual(["Bearer new-refresh-2"]);
      });
    } finally {
      releaseFirstRefresh();
      await Promise.allSettled(requests);
    }
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect(refreshes).toEqual(["refresh-1", "refresh-2"]);
    expect(authorizations).toEqual([
      "Bearer new-refresh-2",
      // Account one was disabled while its refresh waited: final admission must not send it.
      "Bearer new-refresh-2",
    ]);
  });

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider OAuth refresh recovery", ({ provider, route }) => {
    it.each([
      {
        name: "uses valid tokens during temporary failure and retries after backoff",
        elapsedMinutes: 6,
        failureStatus: 503,
        expectedStatus: 200,
      },
      {
        name: "temporarily rejects expired tokens and recovers after backoff",
        elapsedMinutes: 11,
        failureStatus: 503,
        expectedStatus: 503,
      },
      {
        name: "recovers OAuth 403 after network disruption without toggling enabled",
        elapsedMinutes: 11,
        failureStatus: 403,
        expectedStatus: 503,
      },
      {
        name: "keeps invalid_grant accounts excluded despite a valid access token",
        elapsedMinutes: 6,
        failureStatus: 400,
        // Excluded account and nothing else to pick: a refusal, not a retry hint.
        expectedStatus: 403,
      },
    ])("$name", async ({ elapsedMinutes, failureStatus, expectedStatus }) => {
      let now = 1_800_000_000_000;
      const expiresAt = now + 10 * 60 * 1_000;
      const oldToken = testJwt({ exp: expiresAt / 1_000 });
      const newToken = testJwt({ exp: now / 1_000 + 3600 });
      let refreshStatus = failureStatus;
      let refreshCalls = 0;
      const authorizations: Array<string | undefined> = [];
      const upstream = await startUpstream(async (request, response) => {
        await readRequestBody(request);
        response.writeHead(
          request.url === "/oauth/token" ? refreshStatus : 200,
          { "content-type": "application/json" },
        );
        if (request.url === "/oauth/token") {
          refreshCalls += 1;
          response.end(
            JSON.stringify(
              refreshStatus === 200
                ? {
                    access_token: newToken,
                    refresh_token: "new-refresh",
                    expires_in: 3600,
                  }
                : {
                    error:
                      refreshStatus === 400
                        ? "invalid_grant"
                        : "temporarily_unavailable",
                  },
            ),
          );
          return;
        }
        authorizations.push(request.headers.authorization);
        response.end("{}");
      });
      cleanups.push(upstream.close);
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        provider,
        source: "import",
        options: {
          now: () => now,
          importCredentials: async () =>
            importedCredentials({ accessToken: oldToken, expiresAt }),
          importCodexCredentials: async () => ({
            accessToken: oldToken,
            refreshToken: "old-refresh",
            idToken: null,
            accountId: "chatgpt-account",
            email: "codex@example.com",
            expiresAt,
          }),
          refreshUrl: `${upstream.url}/oauth/token`,
          codexRefreshUrl: `${upstream.url}/oauth/token`,
          codexUsageUrl: EMPTY_USAGE_URL,
        },
      });
      expect(refreshCalls).toBe(0);
      now += elapsedMinutes * 60 * 1_000;
      for (let request = 0; request < 2; request += 1) {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          { headers: authHeaders(fixture.key), body: "{}" },
        );
        await response.text();
        expect(response.status).toBe(expectedStatus);
        expect(refreshCalls).toBe(1);
      }
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(accounts[0]?.error).toEqual(
        failureStatus === 400
          ? expect.stringContaining("OAuth refresh failed")
          : null,
      );
      expect(authorizations).toEqual(
        expectedStatus === 200
          ? [`Bearer ${oldToken}`, `Bearer ${oldToken}`]
          : [],
      );
      refreshStatus = 200;
      now += 1_000;
      const recovered = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      await recovered.text();
      expect(recovered.status).toBe(failureStatus === 400 ? 403 : 200);
      expect(refreshCalls).toBe(failureStatus === 400 ? 1 : 2);
      if (failureStatus !== 400) {
        expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
        const recoveredAccounts = z
          .array(accountSummarySchema)
          .parse(
            await fixture.host.harness.behavior.callRpc("account.list", null),
          );
        expect(recoveredAccounts[0]?.error).toBeNull();
      }
    });
  });

  it("expires fallback tokens during refresh backoff and caps Retry-After", async () => {
    let now = 1_800_000_000_000;
    const expiresAt = now + 10 * 60 * 1_000;
    let refreshCalls = 0;
    let refreshStatus = 503;
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      if (request.url === "/oauth/token") {
        refreshCalls += 1;
        response.writeHead(refreshStatus, {
          "content-type": "application/json",
          "retry-after": "120",
        });
        response.end(
          JSON.stringify(
            refreshStatus === 503
              ? { error: "temporarily_unavailable" }
              : { access_token: "oauth-new", expires_in: 3600 },
          ),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        now: () => now,
        importCredentials: async () => importedCredentials({ expiresAt }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    now = expiresAt - 500;
    const attempts: Array<
      [advanceMs: number, expectedStatus: number, expectedRefreshes: number]
    > = [
      [0, 200, 1],
      [500, 503, 1],
      [59_499, 503, 1],
      [1, 200, 2],
    ];
    for (const [advanceMs, expectedStatus, expectedRefreshes] of attempts) {
      now += advanceMs;
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(refreshCalls).toBe(expectedRefreshes);
      refreshStatus = 200;
    }
    expect(authorizations).toEqual(["Bearer oauth-access", "Bearer oauth-new"]);
  });

  it("marks refresh and upstream authorization failures as account errors", async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/oauth/token") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"bad account"}}');
    });
    cleanups.push(upstream.close);
    const refreshFixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        importCredentials: async () =>
          importedCredentials({ expiresAt: Date.now() + 1_000 }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    const refreshResponse =
      await refreshFixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(refreshFixture.key), body: "{}" },
      );
    expect(refreshResponse.status).toBe(403);
    const refreshAccounts = z
      .array(accountSummarySchema)
      .parse(
        await refreshFixture.host.harness.behavior.callRpc(
          "account.list",
          null,
        ),
      );
    expect(refreshAccounts[0]?.status).toBe("error");
    expect(refreshAccounts[0]?.error).toContain("OAuth refresh failed");

    const authFixture = await createFixture({ upstreamUrl: upstream.url });
    const authResponse = await authFixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(authFixture.key), body: "{}" },
    );
    expect(authResponse.status).toBe(401);
    await authResponse.text();
    const authAccounts = z
      .array(accountSummarySchema)
      .parse(
        await authFixture.host.harness.behavior.callRpc("account.list", null),
      );
    expect(authAccounts[0]?.status).toBe("error");
    expect(authAccounts[0]?.error).toContain("bad account");
  });

  it("suppresses env and health only for the provider whose routing is off", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => Response.json({}),
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({
          accessToken: "codex-access",
          refreshToken: "codex-refresh",
          idToken: "codex-id",
          accountId: "chatgpt-account",
          email: "codex@example.com",
          expiresAt: Date.now() + 60_000,
        }),
      },
    });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    const disabled = await fixture.host.harness.behavior.runCli([
      "routing",
      "claude",
      "--off",
    ]);
    expect(disabled).toMatchObject({ exitCode: 0 });
    await expect(
      fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-off",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
    await expect(resolveCodexToken(fixture.host)).resolves.toMatchObject({
      baseUrl: "/api/v1/plugins/account-pool/http/v1",
    });
    const result = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(result.routing).toEqual({
      claude: false,
      codex: true,
      kimi: true,
      zai: true,
      "opencode-go": true,
      neuraldeep: true,
      agy: true,
      cursor: true,
      devin: true,
    });
  });

  it("records the selected account's last-use time and host", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    let now = 1_800_000_000_000;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { now: () => now },
    });
    const changedCount = () =>
      fixture.host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "accounts-changed",
      ).length;
    const baseline = changedCount();
    const forward = async (key: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(key), body: "{}" },
      );
      await response.text();
    };
    await forward(fixture.key);
    expect(changedCount()).toBe(baseline + 1);
    now += 1_000;
    await forward(fixture.key);
    expect(changedCount()).toBe(baseline + 1);
    const secondHostKey = await resolveToken(
      fixture.host,
      "host-two",
      "thread-two",
    );
    await forward(secondHostKey);
    expect(changedCount()).toBe(baseline + 2);
    const result = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(result.accounts[0]).toMatchObject({
      lastUsedAt: now,
      lastUsedHostId: "host-two",
      lastUsedHostName: "Two",
    });
  });

  it("sets priority, refreshes one account, and returns status over RPC", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const priority = z.object({ account: accountSchema.nullable() }).parse(
      await fixture.host.harness.behavior.callRpc("account.setPriority", {
        accountId: fixture.account.id,
        priority: 42,
      }),
    );
    expect(priority.account?.priority).toBe(42);
    const refreshed = z
      .object({ account: accountSummarySchema.nullable() })
      .parse(
        await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
          accountId: fixture.account.id,
        }),
      );
    expect(refreshed.account?.id).toBe(fixture.account.id);
    expect(
      statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      ).accounts[0]?.priority,
    ).toBe(42);
  });

  it("releases an aborted request even when the downstream body is not consumed", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: buffered\n\n");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const client = new AbortController();
    const response = await fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
      headers: authHeaders(fixture.key), body: "{}", signal: client.signal,
    });
    // Fill the wrapper's queue without asking it to pull another chunk.
    await new Promise(resolve => setTimeout(resolve, 50));
    const inFlight = async () => statusSchema.parse(await fixture.host.harness.behavior.callRpc("status.get", null)).inFlight;
    expect(await inFlight()).toBe(1);
    client.abort();
    try {
      await vi.waitFor(async () => expect(await inFlight()).toBe(0));
    } finally {
      await response.body?.cancel();
    }
    expect(await inFlight()).toBe(0);
  });

  it("drains completed streams and aborts a stuck stream after the stop deadline", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: started\n\n");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: {},
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: started\n\n");
    const startedAt = Date.now();
    fixture.service.controller.abort();
    await fixture.service.done;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2900);
    expect(Date.now() - startedAt).toBeLessThan(4500);
    const stopped = await reader.read();
    expect(new TextDecoder().decode(stopped.value)).toContain(
      "Account Pooler stopped",
    );
    const rejected = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(rejected.status).toBe(503);
  });
});

describe("sequential pool recovery", () => {
  const body = JSON.stringify({
    model: "claude-opus-4-1",
    metadata: { user_id: JSON.stringify({ session_id: "review-session" }) },
  });

  it("bounds repeated waits when a session's rate-limit hold keeps extending", async () => {
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        now: Date.now,
        fetch: async () =>
          ++attempts === 1
            ? Response.json({})
            : Response.json(
                {},
                { status: 429, headers: { "retry-after": "0.01" } },
              ),
      },
    });
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
        signal: AbortSignal.timeout(1_000),
      });
    await (await send()).text();
    const paced = await send();
    expect(paced.status).toBe(429);
    await paced.text();
    const held = await send();
    expect(held.status).toBe(429);
    await held.text();
    expect(attempts).toBe(5);
  });

  it("keeps a paced session on its account when another request arrives during a short hold", async () => {
    const attempts: Array<string | null> = [];
    let now = 1_800_000_000_000;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        now: () => now,
        fetch: async (_input, init) => {
          attempts.push(new Headers(init?.headers).get("x-api-key"));
          return attempts.length === 2
            ? Response.json(
                {},
                { status: 429, headers: { "retry-after": "0.25" } },
              )
            : Response.json({});
        },
      },
    });
    await addApiAccount(fixture, "sk-second");
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
      });
    await (await send()).text();
    const paced = send();
    try {
      await vi.waitFor(async () => {
        const status = statusSchema.parse(
          await fixture.host.harness.behavior.callRpc("status.get", null),
        );
        expect(
          status.accounts.find((account) => account.id === fixture.account.id)
            ?.status,
        ).toBe("held");
      });
      const duringHold = send();
      now += 249;
      await new Promise(resolve=>setTimeout(resolve,20));
      expect(attempts).toHaveLength(2);
      now += 1;
      const duringHoldResponse = await duringHold;
      expect(duringHoldResponse.status).toBe(200);
      await duringHoldResponse.text();
      await (await paced).text();
      await (await send()).text();
      expect(attempts).toEqual([
        "sk-first",
        "sk-first",
        "sk-first",
        "sk-first",
        "sk-first",
      ]);
    } finally {
      const response = await paced;
      if (!response.bodyUsed) await response.text();
    }
  });

  it("keeps the last working binding after every account fails during a provider outage", async () => {
    const attempts: Array<string | null> = [];
    let outage = false;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        fetch: async (_input, init) => {
          attempts.push(new Headers(init?.headers).get("x-api-key"));
          return Response.json({}, { status: outage ? 503 : 200 });
        },
      },
    });
    await addApiAccount(fixture, "sk-second");
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
      });
    await (await send()).text();
    outage = true;
    const failed = await send();
    expect(failed.status).toBe(503);
    await failed.text();
    outage = false;
    await (await send()).text();
    expect(attempts).toEqual(["sk-first", "sk-first", "sk-second", "sk-first"]);
  });

  it("keeps Codex over-limit accounts ineligible until reset when utilization is omitted", async () => {
    let imported = 0;
    const attempts: Array<string | null> = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "codex",
      source: "import",
      options: {
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({
          accessToken: imported++ === 0 ? "sk-first" : "sk-second",
          refreshToken: "refresh",
          idToken: null,
          accountId: `review-codex-account-${imported}`,
          email: null,
          expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        }),
        fetch: async (input, init) => {
          if (String(input) === EMPTY_USAGE_URL) return Response.json({});
          const key = new Headers(init?.headers).get("authorization");
          attempts.push(key);
          return key === "Bearer sk-first"
            ? Response.json(
                {},
                {
                  status: 429,
                  headers: {
                    "x-codex-primary-over-limit": "true",
                    "x-codex-primary-reset-after-seconds": "60",
                    "x-codex-primary-window-minutes": "300",
                  },
                },
              )
            : Response.json({});
        },
      },
    });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    await fixture.host.harness.behavior.callRpc("account.setDrainOnce", {
      accountId: fixture.account.id, enabled: true,
    });
    for (const session of ["first-session", "second-session"]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: { ...authHeaders(fixture.key), "thread-id": session },
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(attempts).toEqual([
      "Bearer sk-first",
      "Bearer sk-second",
      "Bearer sk-second",
    ]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(
      status.accounts.find((account) => account.id === fixture.account.id)
        ?.status,
    ).toBe("exhausted");
  });
  it("routes sessions to its own plugin id when installed under another name", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-id-"));
    const host = createFakePluginHost({
      pluginId: "account-pool-balanced",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
    vpnPayload: async (timestamp) => vpnProof(timestamp, "connected"), usageUrl: "data:application/json,{}" })(
      host.bb,
    );
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "sk-renamed" },
      label: null,
      priority: 100,
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ),
      ).toMatchObject({
        accepting: true,
        route: "/api/v1/plugins/account-pool-balanced/http",
      });
    });
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
    );
    expect(
      entries.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value,
    ).toEqual({ serverPath: "/api/v1/plugins/account-pool-balanced/http" });
  });

  it.each([
    ["short window", 200, { "anthropic-ratelimit-unified-5h-utilization": "1" }, false],
    ["model quota", 200, { "anthropic-ratelimit-unified-7d_opus-utilization": "1" }, false],
    ["quota rejection", 429, { "anthropic-ratelimit-unified-7d-status": "rejected" }, false],
    ["pacing", 429, { "retry-after": "60" }, true],
    ["provider outage", 503, {}, true],
  ] as const)("one-shot drain handles %s", async (_name, code, headers, remainsArmed) => {
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example",
      options: { fetch: async () => Response.json({}, { status: code, headers }) },
    });
    await fixture.host.harness.behavior.callRpc("account.setDrainOnce", { accountId: fixture.account.id, enabled: true });
    const response = await fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
      headers: authHeaders(fixture.key), body: JSON.stringify({ model: "claude-opus-4" }),
    });
    await response.text();
    const status = statusSchema.parse(await fixture.host.harness.behavior.callRpc("status.get", null));
    expect(status.accounts[0]?.drainOnce).toBe(remainsArmed);
  });

  it("manually refreshes a disabled Codex OAuth account without enabling routing", async () => {
    let used = 10;
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", provider: "codex", source: "import",
      options: {
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({ accessToken: "test-access", refreshToken: "test-refresh", idToken: null,
          accountId: "synthetic-codex", email: null, expiresAt: Date.now() + 86400000 }),
        fetch: async () => Response.json({ rate_limit: { allowed: true, limit_reached: false,
          primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 86400,
            reset_at: Math.floor(Date.now() / 1000) + 86400 }, secondary_window: null } }),
      },
    });
    await fixture.host.harness.behavior.callRpc("account.disable", { id: fixture.account.id });
    used = 37;
    const refreshed = await fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: fixture.account.id });
    expect(refreshed).toMatchObject({ account: { enabled: false, status: "disabled",
      limitWindows: [{ windowMinutes: 10080, utilization: .37 }] } });
  });

  it("clears one-shot draining on Codex weekly usage refresh and never rearms after reset", async () => {
    let used = 99;
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", provider: "codex", source: "import",
      options: {
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({ accessToken: "test-access", refreshToken: "test-refresh", idToken: null,
          accountId: "synthetic-codex", email: null, expiresAt: Date.now() + 86400000 }),
        fetch: async () => Response.json({ rate_limit: { allowed: used < 100, limit_reached: used >= 100,
          primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 86400,
            reset_at: Math.floor(Date.now() / 1000) + 86400 }, secondary_window: null } }),
      },
    });
    const rpc = fixture.host.harness.behavior.callRpc;
    await rpc("account.setDrainOnce", { accountId: fixture.account.id, enabled: true });
    const current = async () => statusSchema.parse(await rpc("status.get", null)).accounts[0]!;
    await rpc("account.refreshUsage", { accountId: fixture.account.id });
    expect(await current()).toMatchObject({ drainOnce: true, status: "ready", fiveHourUtilization: null });
    expect((await current()).limitWindows).toHaveLength(1);
    used = 100;
    await rpc("account.refreshUsage", { accountId: fixture.account.id });
    expect((await current()).drainOnce).toBe(false);
    used = 0;
    await rpc("account.refreshUsage", { accountId: fixture.account.id });
    expect(await current()).toMatchObject({ drainOnce: false, status: "ready" });
  });

  it("drains an armed reserve past 98%, overrides weaker affinity, and clears once at exhaustion", async () => {
    const attempts: Array<string | null> = [];
    let used = "0.99";
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example", apiKey: "sk-reserve",
      options: { fetch: async (_input, init) => {
        const key = new Headers(init?.headers).get("x-api-key");
        attempts.push(key);
        return Response.json({}, { headers: {
          "anthropic-ratelimit-unified-7d-utilization": key === "sk-reserve" ? used : "0.1",
          "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 86400),
        } });
      } },
    });
    await addApiAccount(fixture, "sk-primary", 0);
    const rpc = fixture.host.harness.behavior.callRpc;
    await rpc("account.setRole", { accountId: fixture.account.id, role: "reserve" });
    const send = async (session: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: session }) } }),
      });
      await response.text();
      return response.status;
    };
    const current = async () => statusSchema.parse(await rpc("status.get", null)).accounts.find(a => a.id === fixture.account.id)!;
    expect(await send("bound-primary")).toBe(200);
    await rpc("account.setDrainOnce", { accountId: fixture.account.id, enabled: true });
    expect(await send("new-drain")).toBe(200);
    expect(await send("bound-primary")).toBe(200);
    expect(await send("another-new")).toBe(200);
    expect(attempts).toEqual(["sk-primary", "sk-reserve", "sk-reserve", "sk-reserve"]);
    expect(await current()).toMatchObject({ drainOnce: true, capLimit: null, status: "ready" });
    used = "1";
    expect(await send("exhausting")).toBe(200);
    expect(await current()).toMatchObject({ drainOnce: false, role: "reserve", status: "exhausted" });
    expect(await send("after-exhaustion")).toBe(200);
    expect(attempts.at(-1)).toBe("sk-primary");
    used = "0";
    expect((await current()).drainOnce).toBe(false);
    await expect(rpc("account.setDrainOnce", { accountId: fixture.account.id, enabled: "yes" })).rejects.toThrow();
  });

  it("applies account policy to sticky sessions and overrides schedule during drain", async () => {
    const attempts: Array<string | null> = [];
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", apiKey: "sk-work", priority: 0,
      options: { fetch: async (_input, init) => {
        attempts.push(new Headers(init?.headers).get("x-api-key"));
        return Response.json({}, { headers: { "anthropic-ratelimit-unified-7d-utilization": "0.6" } });
      } },
    });
    await addApiAccount(fixture, "sk-fallback", 100);
    const send = async () => {
      const response = await fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key), body: JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: "policy-session" }) } }),
      });
      expect(response.status).toBe(200); await response.text();
    };
    const set = async (enabled: boolean, schedule: unknown = null) => fixture.host.harness.behavior.callRpc("account.setPolicy", {
      accountId: fixture.account.id, policy: { enabled, weeklyKeep: 50, schedule },
    });
    await send();
    await set(true);
    await send();
    expect(attempts).toEqual(["sk-work", "sk-fallback"]);
    const status = statusSchema.parse(await fixture.host.harness.behavior.callRpc("status.get", null));
    expect(status.accounts.find(a => a.id === fixture.account.id)).toMatchObject({ eligible: false, policy: { enabled: true, weeklyKeep: 50 } });
    await set(true, { timeZone: "UTC", intervals: [] });
    await fixture.host.harness.behavior.callRpc("account.setDrainOnce", { accountId: fixture.account.id, enabled: true });
    await send();
    expect(attempts.at(-1)).toBe("sk-work");
    await set(false);
    const after = statusSchema.parse(await fixture.host.harness.behavior.callRpc("status.get", null));
    expect(after.accounts.find(a => a.id === fixture.account.id)?.eligible).toBe(true);
  });

  it("keeps reserve accounts out of routing while a primary account is eligible", async () => {
    const attempts: Array<string | null> = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-work",
      priority: 0,
      options: {
        fetch: async (_input, init) => {
          attempts.push(new Headers(init?.headers).get("x-api-key"));
          return Response.json({}, { status: 200 });
        },
      },
    });
    const personal = await addApiAccount(fixture, "sk-personal", 100);
    const role = await fixture.host.harness.behavior.runCli([
      "account",
      "role",
      fixture.account.id,
      "reserve",
    ]);
    expect(role.exitCode).toBe(0);
    expect(role.stdout).toContain("role to reserve");
    const cap = await fixture.host.harness.behavior.runCli([
      "account",
      "cap",
      personal.id,
      "0.2",
      "0.9",
    ]);
    expect(cap.exitCode).toBe(0);
    const send = async (session: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({
            metadata: { user_id: JSON.stringify({ session_id: session }) },
          }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    };
    await send("first");
    await send("second");
    await fixture.host.harness.behavior.callRpc("account.disable", {
      id: personal.id,
    });
    await send("after-primary-disabled");
    expect(attempts).toEqual(["sk-personal", "sk-personal", "sk-work"]);
    const pool = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(pool.activeAccounts).toEqual({
      claude: fixture.account.id,
      codex: null,
      kimi: null,
      zai: null,
      "opencode-go": null,
      neuraldeep: null,
      agy: null,
      cursor: null,
      devin: null,
    });
    expect(
      pool.accounts.find((account) => account.id === fixture.account.id)
        ?.capLimit,
    ).toBe(0.15);
    expect(
      pool.accounts.find((account) => account.id === personal.id)?.capLimit,
    ).toBe(0.2);
    expect(
      pool.accounts.find((account) => account.id === fixture.account.id),
    ).toMatchObject({ eligible: true, capReached: false });
    expect(
      pool.accounts.find((account) => account.id === personal.id),
    ).toMatchObject({ eligible: false, capReached: false });
    const listed = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(
      listed.find((account) => account.id === fixture.account.id),
    ).toMatchObject({ role: "reserve", cap: null });
    expect(
      listed.find((account) => account.id === personal.id),
    ).toMatchObject({ role: "primary", cap: { early: 0.2, late: 0.9 } });
    await expect(
      fixture.host.harness.behavior.callRpc("account.setCap", {
        accountId: personal.id,
        cap: { early: 0.9, late: 0.2 },
      }),
    ).rejects.toThrow();
  });

  it("applies reordered failover atomically without moving current conversations", async () => {
    const attempts: Array<string | null> = [];
    let rejectFirst = false;
    let rejectThird = false;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        fetch: async (_input, init) => {
          const key = new Headers(init?.headers).get("x-api-key");
          attempts.push(key);
          return Response.json(
            {},
            {
              status:
                (key === "sk-first" && rejectFirst) ||
                (key === "sk-third" && rejectThird)
                  ? 503
                  : 200,
            },
          );
        },
      },
    });
    const second = await addApiAccount(fixture, "sk-second");
    const third = await addApiAccount(fixture, "sk-third");
    const send = async (session: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({
            metadata: { user_id: JSON.stringify({ session_id: session }) },
          }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    };
    await send("original");
    const reorder = await fixture.host.harness.behavior.runCli([
      "account",
      "reorder",
      "claude",
      fixture.account.id,
      third.id,
      second.id,
    ]);
    expect(reorder.exitCode).toBe(0);
    const ordered = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(ordered.map((account) => account.id)).toEqual([
      fixture.account.id,
      third.id,
      second.id,
    ]);
    const persisted = z
      .array(accountSchema)
      .parse(await fixture.host.bb.storage.kv.get("accounts:v1"));
    expect(
      persisted.find((account) => account.id === third.id)?.priority,
    ).toBeLessThan(
      persisted.find((account) => account.id === second.id)?.priority ?? 0,
    );
    for (const accountIds of [
      [fixture.account.id],
      [fixture.account.id, third.id, third.id],
      [fixture.account.id, third.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ]) {
      await expect(
        fixture.host.harness.behavior.callRpc("account.reorder", {
          provider: "claude",
          accountIds,
        }),
      ).rejects.toThrow("exactly once");
    }
    expect(await fixture.host.bb.storage.kv.get("accounts:v1")).toEqual(
      persisted,
    );
    await send("new-before-failover");
    rejectFirst = true;
    await send("advance");
    rejectFirst = false;
    await send("new-after-recovery");
    rejectThird = true;
    await send("advance-again");
    expect(attempts).toEqual([
      "sk-first",
      "sk-first",
      "sk-first",
      "sk-third",
      "sk-third",
      "sk-third",
      "sk-second",
    ]);
    const priority = await fixture.host.harness.behavior.runCli([
      "account",
      "priority",
      second.id,
      "0",
    ]);
    expect(priority.exitCode).toBe(0);
    expect(
      z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )[0]?.id,
    ).toBe(second.id);
  });
});

it("logs a sanitized transport cause when pooled fetch fails", async () => {
  const fixture = await createFixture({
    upstreamUrl: "https://upstream.example",
    options: {
      fetch: async () => {
        throw new TypeError("fetch failed with private request data", {
          cause: Object.assign(
            new Error("The session has been destroyed: secret-token"),
            {
              code: "ERR_HTTP2_INVALID_SESSION",
            },
          ),
        });
      },
    },
  });
  const response = await fixture.host.harness.behavior.fetchHttp(
    "POST",
    "/v1/messages",
    {
      headers: authHeaders(fixture.key),
      body: "{}",
    },
  );
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret-token");
  const transportLogs = fixture.host.harness.inspection.logEntries.filter(
    entry => entry.message.startsWith("Account Pooler claude transport failed:"),
  );
  expect(transportLogs).toHaveLength(1);
  expect(transportLogs[0]?.level).toBe("warn");
  const prefix = "Account Pooler claude transport failed: ERR_HTTP2_INVALID_SESSION. ";
  expect(transportLogs[0]?.message).toMatch(/^Account Pooler claude transport failed: ERR_HTTP2_INVALID_SESSION\. /);
  expect(JSON.parse(transportLogs[0]!.message.slice(prefix.length))).toEqual({
    code: "ERR_HTTP2_INVALID_SESSION", category: "session", elapsedMs: expect.any(Number),
    stage: "fetch_headers", transport: "ipv4", operation: "model",
  });
  expect(
    JSON.stringify(fixture.host.harness.inspection.logEntries),
  ).not.toContain("secret-token");
  expect(
    JSON.stringify(fixture.host.harness.inspection.logEntries),
  ).not.toContain("private request data");
});

it("drains a streamed response before disposing the owned transport", async () => {
  const finish = deferred();
  const upstream = await startUpstream(async (request, response) => {
    await readRequestBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("first");
    await finish.promise;
    response.end("last");
  });
  cleanups.push(upstream.close);
  const hooks: Array<() => void | Promise<void>> = [];
  const fixture = await createFixture({
    upstreamUrl: upstream.url,
    beforePlugin(host) {
      const register = host.bb.onDispose.bind(host.bb);
      vi.spyOn(host.bb, "onDispose").mockImplementation((hook) => {
        hooks.push(hook);
        register(hook);
      });
    },
  });
  const response = await fixture.host.harness.behavior.fetchHttp(
    "POST",
    "/v1/messages",
    {
      headers: authHeaders(fixture.key),
      body: "{}",
    },
  );
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected a stream");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  const disposeTransport = hooks[0];
  if (disposeTransport === undefined)
    throw new Error("Expected transport disposal");
  const tail = reader.read().then(
    (result) => ({
      kind: "chunk",
      text: new TextDecoder().decode(result.value),
    }),
    () => ({ kind: "error", text: "" }),
  );
  const disposing = disposeTransport();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish.resolve();
    expect(await tail).toEqual({ kind: "chunk", text: "last" });
    expect((await reader.read()).done).toBe(true);
    await disposing;
  } finally {
    finish.resolve();
    await reader.cancel().catch(() => undefined);
    await disposing;
  }
});

describe('project subscription routing', () => {
  it('prefers project reserve to a global primary, isolates concurrent project affinity, and rechecks edited scopes', async () => {
    const attempts: Array<string|null> = [];
    const fixture = await createFixture({upstreamUrl:'https://upstream.example',apiKey:'sk-global',priority:0,
      options:{fetch:async(_input,init)=>{attempts.push(new Headers(init?.headers).get('x-api-key'));return Response.json({});}}});
    const rpc=fixture.host.harness.behavior.callRpc;
    const projectPrimary=await addApiAccount(fixture,'sk-project-primary',100);
    const projectReserve=await addApiAccount(fixture,'sk-project-reserve',200);
    const project = {onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]};
    await rpc('account.setProjects',{accountId:projectPrimary.id,projects:project});
    await rpc('account.setProjects',{accountId:projectReserve.id,projects:project});
    await rpc('account.setRole',{accountId:projectReserve.id,role:'reserve'});
    const tokenFor=async(projectId:string)=>{
      const env=await fixture.host.harness.behavior.resolveProviderEnv('claude-code',{threadId:`thread-${projectId}`,hostId:'host-one',projectId});
      return env.find(e=>e.name==='ANTHROPIC_AUTH_TOKEN')!.value as string;
    };
    const other=await tokenFor('project-two');
    const send=async(token:string,session='same-session')=>{
      const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:{...authHeaders(token),'x-bb-project-id':'project-one'},body:JSON.stringify({metadata:{user_id:JSON.stringify({session_id:session})}})});
      expect(response.status).toBe(200);await response.text();
    };
    await send(other);await send(fixture.key);await send(other);await send(fixture.key);
    expect(attempts).toEqual(['sk-global','sk-project-primary','sk-global','sk-project-primary']);
    await rpc('account.disable',{id:projectPrimary.id});await send(fixture.key);
    expect(attempts.at(-1)).toBe('sk-project-reserve');
    await rpc('account.disable',{id:projectReserve.id});await send(fixture.key);
    expect(attempts.at(-1)).toBe('sk-global');
    await rpc('account.enable',{id:projectPrimary.id});await send(fixture.key);
    expect(attempts.at(-1)).toBe('sk-project-primary');
    await rpc('account.setProjects',{accountId:projectPrimary.id,projects:{onlySelected:true,rules:[{projectId:'project-two',role:'reserve'}]}});
    await send(fixture.key);expect(attempts.at(-1)).toBe('sk-global');
    await send(other);expect(attempts.at(-1)).toBe('sk-project-primary');
    const stored=accountSchema.parse((await rpc('account.setProjects',{accountId:projectPrimary.id,projects:{onlySelected:false,rules:[{projectId:'project-two',role:'reserve'}]}}) as {account:unknown}).account);
    expect(stored.role).toBe('primary');expect(stored.projects?.rules[0]?.role).toBe('reserve');
  });

  it('drain overrides scope, schedule and existing pins but not disabled state', async()=>{
    const attempts:Array<string|null>=[];
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',apiKey:'sk-general',priority:0,options:{fetch:async(_input,init)=>{attempts.push(new Headers(init?.headers).get('x-api-key'));return Response.json({});}}});
    const draining=await addApiAccount(fixture,'sk-drain',200),rpc=fixture.host.harness.behavior.callRpc;
    await rpc('account.setProjects',{accountId:draining.id,projects:{onlySelected:true,rules:[{projectId:'project-other',role:'reserve'}]}});
    await rpc('account.setPolicy',{accountId:draining.id,policy:{enabled:true,schedule:{timeZone:'UTC',intervals:[]},weeklyKeep:90}});
    const send=async()=>{const r=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:JSON.stringify({metadata:{user_id:JSON.stringify({session_id:'sticky'})}})});expect(r.status).toBe(200);await r.text();};
    await send();await rpc('account.setDrainOnce',{accountId:draining.id,enabled:true});await send();
    expect(attempts).toEqual(['sk-general','sk-drain']);
    await rpc('account.disable',{id:draining.id});await send();expect(attempts.at(-1)).toBe('sk-general');
    await rpc('account.enable',{id:draining.id});await rpc('account.setDrainOnce',{accountId:draining.id,enabled:false});await send();expect(attempts.at(-1)).toBe('sk-general');
  });

  it('unknown clients cannot claim project identity; project-bound external tokens can use assigned accounts',async()=>{
    let calls=0;
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:async()=>{calls++;return Response.json({});}}}),rpc=fixture.host.harness.behavior.callRpc;
    await rpc('account.setProjects',{accountId:fixture.account.id,projects:{onlySelected:true,rules:[{projectId:'project-one',role:'primary'}]}});
    const unknownFile=path.join(fixture.dataDir,'unknown.token');const boundFile=path.join(fixture.dataDir,'bound.token');
    expect((await fixture.host.harness.behavior.runCli(['client','add','unknown','--output',unknownFile])).exitCode).toBe(0);
    expect((await fixture.host.harness.behavior.runCli(['client','add','bound','--output',boundFile,'--project','project-one'])).exitCode).toBe(0);
    const unknown=(await fs.readFile(unknownFile,'utf8')).trim(),bound=(await fs.readFile(boundFile,'utf8')).trim();
    const request=async(token:string)=>fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:{...authHeaders(token),'x-bb-project-id':'project-one'},body:'{}'});
    const refused=await request(unknown);expect(refused.status).toBe(403);expect(await refused.text()).toContain('allowed for this project');expect(calls).toBe(0);
    const accepted=await request(bound);expect(accepted.status).toBe(200);await accepted.text();expect(calls).toBe(1);
    await fixture.host.harness.behavior.runCli(['client','revoke','bound']);const revoked=await request(bound);expect(revoked.status).toBe(401);
    const edited=await fixture.host.harness.behavior.runCli(['account','projects',fixture.account.id,'off']);expect(edited.exitCode).toBe(0);const all=await request(unknown);expect(all.status).toBe(200);await all.text();
  });
});
it('retains authenticated project identity if a client is revoked while reading its body',async()=>{
 const attempts:Array<string|null>=[];
 const fixture=await createFixture({upstreamUrl:'https://upstream.example',apiKey:'sk-global',options:{fetch:async(_input,init)=>{attempts.push(new Headers(init?.headers).get('x-api-key'));return Response.json({});}}});
 const assigned=await addApiAccount(fixture,'sk-assigned',200);
 await fixture.host.harness.behavior.callRpc('account.setProjects',{accountId:assigned.id,projects:{onlySelected:true,rules:[{projectId:'project-one',role:'primary'}]}});
 const file=path.join(fixture.dataDir,'bound.token');
 await fixture.host.harness.behavior.runCli(['client','add','slow','--output',file,'--project','project-one']);
 const token=(await fs.readFile(file,'utf8')).trim();
 const original=Request.prototype.arrayBuffer;
 const body=vi.spyOn(Request.prototype,'arrayBuffer').mockImplementationOnce(async function(this:Request){
  await fixture.host.harness.behavior.runCli(['client','revoke','slow']);
  return original.call(this);
 });
 try {
  const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(token),body:'{}'});
  expect(response.status).toBe(200);await response.text();expect(attempts).toEqual(['sk-assigned']);
  const revoked=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(token),body:'{}'});expect(revoked.status).toBe(401);
 }finally{body.mockRestore();}
});
it('rejects stale project settings without overwriting another editor',async()=>{
 const fixture=await createFixture({upstreamUrl:'https://upstream.example'}),rpc=fixture.host.harness.behavior.callRpc;
 const a={onlySelected:true,rules:[{projectId:'project-a',role:'primary'}]};
 const b={onlySelected:true,rules:[{projectId:'project-b',role:'reserve'}]};
 await rpc('account.setProjects',{accountId:fixture.account.id,projects:a,expectedProjects:null});
 await expect(rpc('account.setProjects',{accountId:fixture.account.id,projects:b,expectedProjects:null})).rejects.toThrow('Project settings changed');
 const state=await rpc('account.list',null) as AccountSummary[];expect(state.find(value=>value.id===fixture.account.id)?.projects).toEqual(a);
 await expect(rpc('account.setProjects',{accountId:fixture.account.id,projects:b,expectedProjects:a})).resolves.toBeTruthy();
});

describe("VPN-only outbound protection", () => {
  it.each(["claude", "codex", "cursor", "devin"] as const)("blocks %s model calls without poisoning the account and recovers", async provider => {
    let connected = false;
    const outbound = vi.fn(async () => Response.json({}));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", provider, source: provider === "codex" ? "import" : undefined, options: { importCodexCredentials: async () => ({ accessToken: "synthetic", refreshToken: "refresh", idToken: null, accountId: "fixture-account", email: "fixture@example.com", expiresAt: Date.now() + 3600_000 }), fetch: outbound, vpnPayload: async (timestamp) => vpnProof(timestamp, connected ? "connected" : "disconnected")} });
    const routes = { claude: "/v1/messages", codex: "/v1/responses", cursor: "/cursor/agent.v1.AgentService/Run", devin: "/devin/exa.seat_management_pb.SeatManagementService/GetUserStatus" };
    // Use the actual hub routes; the early VPN refusal precedes protocol parsing.
    const key = new TextEncoder().encode(fixture.key);
    const metadata = Uint8Array.of(0x1a, key.length, ...key);
    const protobuf = Buffer.from(Uint8Array.of(0x0a, metadata.length, ...metadata));
    const request = () => fixture.host.harness.behavior.fetchHttp("POST", routes[provider], { headers: { authorization: `${provider === "devin" ? "Basic" : "Bearer"} ${fixture.key}`, "x-api-key": fixture.key, "content-type": provider === "devin" ? "application/proto" : "application/json" }, body: provider === "devin" ? protobuf : "{}" });
    const denied = await request();
    expect(denied.status).toBe(503);
    expect(denied.headers.get("x-bb-pool-error")).toBe("VPN_REQUIRED");
    expect(outbound).not.toHaveBeenCalled();
    const accounts = z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.error).toBeNull();
    connected = true;
    const allowed = await request();
    expect(allowed.headers.get("x-bb-pool-error")).not.toBe("VPN_REQUIRED");
    await allowed.text();
    expect(outbound).toHaveBeenCalled();
  });
  it("blocks background quotas, manual quotas and Codex login before transport", async () => {
    let connected = false;
    const outbound = vi.fn(async () => Response.json({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } } }));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", provider: "codex", source: "import", options: { fetch: outbound, vpnPayload: async (timestamp) => vpnProof(timestamp, connected ? "connected" : "unknown"), importCodexCredentials: async () => ({ accessToken: "synthetic", refreshToken: "refresh", idToken: null, accountId: "fixture-account", email: "fixture@example.com", expiresAt: Date.now() + 3600_000 }) } });
    expect(outbound).not.toHaveBeenCalled();
    await expect(fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: fixture.account.id })).rejects.toThrow("VPN_REQUIRED");
    await expect(fixture.host.harness.behavior.callRpc("codexLogin.start", null)).rejects.toThrow("VPN_REQUIRED");
    await expect(fixture.host.harness.behavior.callRpc("provider-usage.v1.getResource", { resourceId: fixture.account.id, refresh: true })).rejects.toThrow("VPN_REQUIRED");
    await expect(fixture.host.harness.behavior.callRpc("login.start", null)).rejects.toThrow("VPN_REQUIRED");
    expect(outbound).not.toHaveBeenCalled();
    connected = true;
    await fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: fixture.account.id });
    expect(outbound).toHaveBeenCalled();
  });
});

describe("recovery from persisted edge errors", () => {
  it.each(["OAuth refresh failed with HTTP 403.", "<html><body>temporary edge block</body></html>"])("rechecks %s without disabling the account", async failure => {
    const outbound = vi.fn(async () => Response.json({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } } }));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", provider: "codex", source: "import", options: { fetch: outbound, importCodexCredentials: async () => ({ accessToken: "synthetic", refreshToken: "refresh", idToken: null, accountId: "fixture-account", email: "fixture@example.com", expiresAt: Date.now() + 3600_000 }) } });
    await fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: fixture.account.id });
    fixture.host.bb.storage.database().prepare("UPDATE account_quota SET error = ? WHERE account_id = ?").run(failure, fixture.account.id);
    outbound.mockClear();
    await fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: fixture.account.id });
    expect(outbound).toHaveBeenCalled();
    const accounts = z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.error).toBeNull();
    expect(accounts[0]?.enabled).toBe(true);
  });
  it("keeps genuine credential rejection excluded", async () => {
    const outbound = vi.fn(async () => Response.json({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } } }));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", provider: "codex", source: "import", options: { fetch: outbound, importCodexCredentials: async () => ({ accessToken: "synthetic", refreshToken: "refresh", idToken: null, accountId: "fixture-account", email: "fixture@example.com", expiresAt: Date.now() + 3600_000 }) } });
    await fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: fixture.account.id });
    outbound.mockClear();
    fixture.host.bb.storage.database().prepare("UPDATE account_quota SET error = ? WHERE account_id = ?").run("OAuth refresh failed with HTTP 401.", fixture.account.id);
    await expect(fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: fixture.account.id })).rejects.toThrow("HTTP 401");
    const accounts = z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.error).toContain("HTTP 401");
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe("network policy boundaries", () => {
  it.each(["kimi", "zai"] as const)("keeps %s available when VPN is disconnected", async provider => {
    const outbound = vi.fn(async () => Response.json({}));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", provider, options: { fetch: outbound, vpnPayload: async (timestamp) => vpnProof(timestamp, "disconnected")} });
    outbound.mockClear();
    const response = await fixture.host.harness.behavior.fetchHttp("POST", provider === "kimi" ? "/kimi/v1/messages" : "/zai/v1/chat/completions", { headers: { authorization: `Bearer ${fixture.key}`, "x-api-key": fixture.key, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", max_tokens: 10, messages: [{ role: "user", content: "test" }] }) });
    expect(response.status).toBe(200);
    await response.text();
    expect(outbound).toHaveBeenCalledOnce();
  });
  it("rechecks VPN immediately before forwarding after initial admission", async () => {
    let checks = 0;
    const outbound = vi.fn(async () => Response.json({}));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", options: { fetch: outbound, vpnPayload: async (timestamp) => vpnProof(timestamp, ++checks === 1 ? "connected" : "disconnected")} });
    checks = 0;
    const response = await fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", { headers: authHeaders(fixture.key), body: "{}" });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-bb-pool-error")).toBe("VPN_REQUIRED");
    expect(outbound).not.toHaveBeenCalled();
    const accounts = z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.error).toBeNull();
  });
  it("recovers an HTML edge denial after a bounded pause", async () => {
    let now = 1_800_000_000_000;
    const outbound = vi.fn().mockResolvedValueOnce(new Response("<html>temporary block</html>", { status: 403, headers: { "content-type": "text/html" } })).mockResolvedValueOnce(Response.json({}));
    const fixture = await createFixture({ upstreamUrl: "https://upstream.example", options: { fetch: outbound, now: () => now } });
    const request = () => fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", { headers: authHeaders(fixture.key), body: "{}" });
    expect((await request()).status).toBe(403);
    const accounts = z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.error).toBeNull();
    expect(accounts[0]?.heldUntil).toBe(now + 60_000);
    now += 60_001;
    const recovered = await request();
    expect(recovered.status).toBe(200);
    await recovered.text();
    expect(outbound).toHaveBeenCalledTimes(2);
  });
});

describe('VPN Guard linked network policy',()=>{
  it('refuses verified protected traffic when no IPv4 transport exists',async()=>{
    const outbound=vi.fn(async()=>Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound,fetchIpv4:undefined}});
    const denied=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});
    expect(denied.status).toBe(503);
    expect(denied.headers.get('x-bb-pool-error')).toBe('VPN_REQUIRED');
    expect(outbound).not.toHaveBeenCalled();
  });
  it('checks status permissions concurrently while preserving provider order',async()=>{
    const outbound=vi.fn(async()=>Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    fixture.host.harness.sdk.stub('system.config',async()=>({primaryHostId:'pool-host'}));
    let active=0,maxActive=0;
    const call=vi.fn(async()=>{
      maxActive=Math.max(maxActive,++active);
      try {
        await new Promise(resolve=>setTimeout(resolve,25));
        return {schema:'bb-vpn-guard/network-decision/2',hostId:'pool-host',allowed:false,reason:'manual_block'};
      } finally {active--;}
    });
    fixture.host.harness.sdk.stub('plugins.callRpc',call);
    await fixture.host.harness.behavior.callRpc('config.set',{vpnGuardEnabled:true});
    const status=statusSchema.parse(await fixture.host.harness.behavior.callRpc('status.get',null));
    expect(maxActive).toBe(7);
    expect(call).toHaveBeenCalledTimes(7);
    expect(status.vpn?.blockedProviders).toEqual(['codex','claude','cursor','devin','opencode-go','neuraldeep','agy']);
    expect(outbound).not.toHaveBeenCalled();
  });
  it('shares one deadline across server lookup and a slow successful Guard RPC',async()=>{
    const outbound=vi.fn(async()=>Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    let sharedSignal:AbortSignal|undefined;
    fixture.host.harness.sdk.stub('system.config',async(args:{signal?:AbortSignal})=>{
      sharedSignal=args.signal;
      return {primaryHostId:'pool-host'};
    });
    fixture.host.harness.sdk.stub('plugins.callRpc',async(args:{signal?:AbortSignal})=>{
      expect(args.signal).toBe(sharedSignal);
      expect(args.signal).toBeInstanceOf(AbortSignal);
      await new Promise(resolve=>setTimeout(resolve,1200));
      expect(args.signal?.aborted).toBe(false);
      return {schema:'bb-vpn-guard/network-decision/2',hostId:'pool-host',allowed:true,reason:'connected'};
    });
    await fixture.host.harness.behavior.callRpc('config.set',{vpnGuardEnabled:true});
    const allowed=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});
    expect(allowed.status).toBe(200);
    await allowed.text();
    expect(outbound).toHaveBeenCalledTimes(1);
  });
  it('blocks model, quota, login and status refresh before any upstream when Guard denies',async()=>{
    const outbound=vi.fn(async()=>Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    fixture.host.harness.sdk.stub('system.config',async()=>({primaryHostId:'pool-host'}));
    let blocked=true;
    const call=vi.fn(async(args:{input?:unknown})=>{
      expect(args.input).toMatchObject({hostId:'pool-host'});
      return {schema:'bb-vpn-guard/network-decision/2',hostId:'pool-host',allowed:!blocked,reason:blocked?'manual_block':'observe'};
    });
    fixture.host.harness.sdk.stub('plugins.callRpc',call);
    await fixture.host.harness.behavior.callRpc('config.set',{vpnGuardEnabled:true,vpnOnlyProviders:[]});
    const request=()=>fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});
    const denied=await request();expect(denied.status).toBe(503);expect(denied.headers.get('x-bb-pool-error')).toBe('VPN_GUARD_BLOCKED');
    await fixture.host.harness.behavior.callRpc('account.refreshUsage',{accountId:fixture.account.id});
    await expect(fixture.host.harness.behavior.callRpc('login.start',null)).rejects.toThrow('VPN_GUARD_BLOCKED');
    expect(outbound).not.toHaveBeenCalled();
    blocked=false;const allowed=await request();expect(allowed.status).toBe(200);await allowed.text();expect(outbound).toHaveBeenCalledTimes(1);
  });
  it('reports Guard outage as local refusal without upstream or account poisoning',async()=>{
    const outbound=vi.fn(async()=>Response.json({}));const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    fixture.host.harness.sdk.stub('system.config',async()=>({primaryHostId:'pool-host'}));fixture.host.harness.sdk.stub('plugins.callRpc',async()=>{throw Error('Guard offline');});
    await fixture.host.harness.behavior.callRpc('config.set',{vpnGuardEnabled:true});
    const denied=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});
    expect(denied.status).toBe(503);expect(denied.headers.get('x-bb-pool-error')).toBe('VPN_GUARD_UNAVAILABLE');expect(outbound).not.toHaveBeenCalled();
    const accounts=z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc('account.list',null));expect(accounts[0]?.error).toBeNull();
  });
});


it('blocks Guard-linked OAuth quotas and login without corrupting account eligibility',async()=>{
 const outbound=vi.fn(async()=>Response.json({}));
 const fixture=await createFixture({
   upstreamUrl:'https://upstream.example',provider:'codex',source:'import',
   options:{fetch:outbound,importCodexCredentials:async()=>({
     accessToken:'synthetic',refreshToken:'refresh',idToken:null,
     accountId:'fixture-account',email:'fixture@example.com',expiresAt:Date.now()+3600000,
   })},
 });
 fixture.host.harness.sdk.stub('system.config',async()=>({primaryHostId:'pool-host'}));
 fixture.host.harness.sdk.stub('plugins.callRpc',async()=>({schema:'bb-vpn-guard/network-decision/2',hostId:'pool-host',allowed:false,reason:'manual_block'}));
 await fixture.host.harness.behavior.callRpc('config.set',{vpnGuardEnabled:true});outbound.mockClear();
 for(const method of ['account.refreshUsage','provider-usage.v1.getResource'] as const) {
   const input=method==='account.refreshUsage'?{accountId:fixture.account.id}:{resourceId:fixture.account.id,refresh:true};
   await expect(fixture.host.harness.behavior.callRpc(method,input)).rejects.toThrow('VPN_GUARD_BLOCKED');
 }
 await expect(fixture.host.harness.behavior.callRpc('codexLogin.start',null)).rejects.toThrow('VPN_GUARD_BLOCKED');
 expect(outbound).not.toHaveBeenCalled();
});

it('cancels a retained linked protected stream through the actual policy service',async()=>{
 let blocked=false;
 const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('first'));}}))}});
 fixture.host.harness.sdk.stub('system.config',async()=>({primaryHostId:'pool-host'}));
 fixture.host.harness.sdk.stub('plugins.callRpc',async()=>({schema:'bb-vpn-guard/network-decision/2',hostId:'pool-host',allowed:!blocked,reason:blocked?'manual_block':'observe'}));
 await fixture.host.harness.behavior.callRpc('config.set',{vpnGuardEnabled:true});
 const service=fixture.host.harness.behavior.runService('network-policy');
 try {
   const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});
   const reader=response.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
   blocked=true;
   const ended=await reader.read().then(r=>r.done,()=>true);expect(ended).toBe(true);
   await vi.waitFor(async()=>{const value=statusSchema.parse(await fixture.host.harness.behavior.callRpc('status.get',null));expect(value.inFlight).toBe(0);});
 }finally{service.controller.abort();await service.done;}
});

it.each(['devin','opencode-go'] as const)('refuses linked %s before any provider call on manual block',async provider=>{
 const outbound=vi.fn(async()=>Response.json({}));const fixture=await createFixture({upstreamUrl:'https://upstream.example',provider,options:{fetch:outbound}});
 fixture.host.harness.sdk.stub('system.config',async()=>({primaryHostId:'pool-host'}));
 fixture.host.harness.sdk.stub('plugins.callRpc',async()=>({schema:'bb-vpn-guard/network-decision/2',hostId:'pool-host',allowed:false,reason:'manual_block'}));
 await fixture.host.harness.behavior.callRpc('config.set',{vpnGuardEnabled:true});outbound.mockClear();
 const route=provider==='devin'?'/devin/exa.seat_management_pb.SeatManagementService/GetUserStatus':'/opencode-go/v1/chat/completions';
 const response=await fixture.host.harness.behavior.fetchHttp('POST',route,{headers:authHeaders(fixture.key),body:'{}'});
 expect(response.status).toBe(503);expect(response.headers.get('x-bb-pool-error')).toBe('VPN_GUARD_BLOCKED');expect(outbound).not.toHaveBeenCalled();
});

it('routes browser panel and CLI to the selected Mac with no server browser fallback',async()=>{
 const local=vi.spyOn(accountBrowser,'openAccountBrowser').mockRejectedValue(Error('must not launch locally'));
 const remote=vi.fn(async()=>({opened:true}));
 const fixture=await createFixture({upstreamUrl:'https://upstream.example',provider:'kimi',callBrowserHost:remote});
 fixture.host.harness.sdk.stub('hosts.list',async()=>[{id:'mac-browser',status:'connected'}]);
 await fixture.host.harness.behavior.callRpc('config.set',{browserHostId:'mac-browser'});
 expect(await fixture.host.harness.behavior.callRpc('browser.open',{accountId:fixture.account.id})).toEqual({opened:true});
 expect((await fixture.host.harness.behavior.runCli(['browser','open',fixture.account.id])).exitCode).toBe(0);
 expect(remote).toHaveBeenCalledTimes(2);expect(local).not.toHaveBeenCalled();
 for(const [request] of remote.mock.calls as unknown as [{hostId:string,input:{accounts:unknown[]}}][]){
  expect(request.hostId).toBe('mac-browser');expect(Object.keys(request.input.accounts[0] as object).sort()).toEqual(['email','id','label','provider']);
 }
 fixture.host.harness.sdk.stub('hosts.list',async()=>[]);
 await expect(fixture.host.harness.behavior.callRpc('browser.open',{accountId:fixture.account.id})).rejects.toThrow('unavailable');
 expect(remote).toHaveBeenCalledTimes(2);expect(local).not.toHaveBeenCalled();
});

describe('bounded request metadata observations',()=>{
  async function records(fixture:Fixture){
    const reply=await fixture.host.harness.behavior.runCli(['observations','--json']);
    expect(reply.exitCode).toBe(0);
    return JSON.parse(reply.stdout) as {rows:Array<import('./request-journal.js').Observation>;minutes:Array<{logicalRequests:number;attempts:number;upstream429:number;localHeld429:number}>};
  }
  it('binds typed Codex quota evidence to the actual selected account and upstream event',async()=>{
    const now=Date.now();
    const outbound=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('usage') ? Response.json({}) : new Response('synthetic private body',{headers:{
      'x-codex-primary-used-percent':'21','x-codex-primary-window-minutes':'10080','x-codex-primary-reset-at':String((now+86400000)/1000),
      'x-codex-secondary-window-minutes':'0','x-codex-secondary-used-percent':'0','x-codex-secondary-over-limit':'false',
      'set-cookie':'synthetic private cookie','x-other':'synthetic private header'}}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',provider:'codex',source:'import',options:{fetch:outbound,
      importCodexCredentials:async()=>({accessToken:'synthetic',refreshToken:'synthetic-refresh',idToken:null,accountId:'fixture-account',email:'fixture@example.com',expiresAt:now+3600000})}});
    const quotas=new QuotaStore(fixture.host.bb.storage.database());
    quotas.put(codexQuotaFromUsage(fixture.account.id,{rate_limit:{allowed:true,limit_reached:false,
      primary_window:{used_percent:20,limit_window_seconds:604800,reset_at:(now+86400000)/1000},secondary_window:null}},quotas.get(fixture.account.id),now)!);
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/responses',{headers:authHeaders(fixture.key),body:JSON.stringify({model:'gpt-6-sol',input:'synthetic private prompt'})});
    expect(response.status).toBe(200);expect(await response.text()).toBe('synthetic private body');
    const result=await records(fixture),events=result.rows.filter(e=>e.event==='upstream');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({provider:'codex',accountId:fixture.account.id,attempt:1,status:200,codexQuota:{
      primary:[21,10080,(now+86400000)/1000,'missing','missing'],secondary:[0,0,'missing','missing',false],
      priorUsage:{observedAt:now,allowed:true,limitReached:false,primary:'present',secondary:'absent'},priorDurations:[10080,null],evidencePreserved:false}});
    expect(JSON.stringify(result)).not.toMatch(/synthetic|cookie|authorization|refresh|fixture@example/);
    expect(quotas.get(fixture.account.id).codexUsageEvidence).toBeUndefined();
    expect(result.minutes[0]).toMatchObject({logicalRequests:1,attempts:1,upstream429:0});
  });
  it('attributes upstream429 with supplied delay without leaking body or headers',async()=>{
    const outbound=vi.fn().mockResolvedValue(new Response('synthetic private response',{status:429,headers:{'retry-after':'60','x-private':'synthetic-private'}}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:JSON.stringify({model:'claude-opus-4-6',messages:[{role:'user',content:'synthetic private prompt'}]})});
    expect(response.status).toBe(429);await response.text();
    const result=await records(fixture);
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({event:'upstream',status:429,retryAfterMs:60000,retryAfterSupplied:true,quotaEvidence:false}),
      expect.objectContaining({event:'hold',holdSource:'upstream429',heldUntil:expect.any(Number)}),
    ]));
    expect(result.minutes[0]).toMatchObject({logicalRequests:1,attempts:1,upstream429:1,localHeld429:0});
    expect(JSON.stringify(result)).not.toMatch(/private|authorization|messages|sk-account/);
  });
  it('queues an existing hold without manufacturing an upstream429 and preserves one logical ID per request',async()=>{
    const outbound=vi.fn().mockImplementation(async()=>Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    const body=JSON.stringify({model:'claude-opus-4-6',metadata:{user_id:'user_session_11111111-1111-4111-8111-111111111111'}});
    const first=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body});await first.text();
    fixture.host.bb.storage.database().prepare('UPDATE account_quota SET held_until=? WHERE account_id=?').run(Date.now()+60000,fixture.account.id);
    const second=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body,signal:AbortSignal.timeout(30)});expect(second.status).toBe(499);await second.text();
    const r=await records(fixture);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(r.rows.filter(e=>e.event==='local-held')).toEqual([]);
    expect(new Set(r.rows.filter(e=>e.event==='request').map(e=>e.requestId)).size).toBe(2);
    expect(r.minutes[0]).toMatchObject({logicalRequests:2,attempts:1,upstream429:0,localHeld429:0});
  });
  it('records recoverable upstream403 holds with a different causal source',async()=>{
    const outbound=vi.fn().mockResolvedValue(new Response('<html>synthetic block</html>',{status:403,headers:{'content-type':'text/html'}}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});await response.text();
    expect((await records(fixture)).rows).toEqual(expect.arrayContaining([expect.objectContaining({event:'hold',status:403,holdSource:'upstream403',heldUntil:expect.any(Number)})]));
  });
  it('records actual token-bound identifiers, not inbound guessed thread IDs',async()=>{
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:vi.fn().mockImplementation(async()=>Response.json({}))}});
    const env=await fixture.host.harness.behavior.resolveProviderEnv('claude-code',{hostId:'host-one',projectId:'proj_abcdef1234',threadId:'thr_abcdef1234'});
    const key=env.find(e=>e.name==='ANTHROPIC_AUTH_TOKEN')!.value as string;
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:{...authHeaders(key),'thread-id':'thr_forged1234'},body:JSON.stringify({model:'private-model',metadata:{user_id:'private-user'}})});await response.text();
    expect((await records(fixture)).rows.every(e=>e.projectId==='proj_abcdef1234'&&e.threadId==='thr_abcdef1234'&&e.model===null)).toBe(true);
  });
  it('counts failover attempts separately and reports final account outcome',async()=>{
    const outbound=vi.fn().mockResolvedValueOnce(new Response('synthetic fail',{status:500})).mockResolvedValueOnce(Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    await fixture.host.harness.behavior.callRpc('account.add',{provider:'claude',source:{kind:'api-key',apiKey:'synthetic-second-key'},label:null,priority:200});
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});expect(response.status).toBe(200);await response.text();
    const r=await records(fixture);expect(r.minutes[0]).toMatchObject({logicalRequests:1,attempts:2});
    expect(r.rows.filter(e=>e.event==='attempt').map(e=>e.attempt)).toEqual([1,2]);
    expect(r.rows).toContainEqual(expect.objectContaining({event:'result',outcome:'failed-over',status:200}));
  });
  it.each(['complete','cancel','error'] as const)('records stream %s once',async(kind)=>{
    let streamController!:ReadableStreamDefaultController<Uint8Array>;
    const stream=new ReadableStream<Uint8Array>({start(c){streamController=c;c.enqueue(new TextEncoder().encode('data: {}\n\n'));}});
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:vi.fn().mockResolvedValue(new Response(stream,{headers:{'content-type':'text/event-stream'}}))}});
    const abort=new AbortController();
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}',signal:abort.signal});
    const reader=response.body!.getReader();await reader.read();
    if(kind==='complete'){streamController.close();await reader.read();}
    if(kind==='cancel'){await reader.cancel();abort.abort();}
    if(kind==='error'){streamController.error(new Error('synthetic private error'));await reader.read();}
    const rows=(await records(fixture)).rows.filter(e=>e.event==='stream-end');
    expect(rows).toHaveLength(1);expect(rows[0]!.outcome).toBe(kind==='cancel'?'canceled':kind);
    expect(JSON.stringify(rows)).not.toContain('private error');
  });
  it('does not fail forwarding when the telemetry recorder throws',async()=>{
    const {RequestJournal}=await import('./request-journal.js');
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:vi.fn().mockImplementation(async()=>Response.json({ok:true}))}});
    vi.spyOn(RequestJournal.prototype,'record').mockImplementation(()=>{throw Error('synthetic journal failure');});
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(fixture.key),body:'{}'});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true});
  });
});

describe('trusted automation account admission', () => {
  async function issued(fixture:Fixture, name='worker') {
    const output=path.join(fixture.dataDir, `${name}.token`);
    const result=await fixture.host.harness.behavior.runCli(['client','add',name,'--output',output,'--project','project-one','--purpose','autopilot']);
    expect(result.exitCode).toBe(0);
    return (await fs.readFile(output,'utf8')).trim();
  }
  async function allow(fixture:Fixture, allowed=true, expectedAllowed=false, accountId=fixture.account.id) {
    return fixture.host.harness.behavior.callRpc('account.setAutopilotAllowed',{accountId,allowed,expectedAllowed});
  }
  const routes = {
    claude:['/v1/messages','/v1/messages/count_tokens'],
    codex:['/v1/responses','/v1/images/generations','/v1/images/edits','/v1/alpha/search','/v1/models'],
    kimi:['/kimi/v1/messages','/kimi/v1/messages/count_tokens'],
    zai:['/zai/v1/chat/completions','/zai/v1/responses','/zai/v1/models'],
    'opencode-go':['/opencode-go/v1/chat/completions','/opencode-go/v1/responses','/opencode-go/v1/models'],
    cursor:CURSOR_PROXIED_PATHS.filter(p=>p!=='auth/exchange_user_api_key').map(p=>`/cursor/${p}`),
    devin:DEVIN_PROXIED_PATHS.map(p=>`/devin/${p}`),
  };
  it.each(['claude','codex','kimi','zai','opencode-go','cursor','devin'] as const)('enforces opt-in on reachable %s routes and retains ordinary requests',async provider=>{
    const outbound=vi.fn(async()=>Response.json({accessToken:'synthetic-minted',refreshToken:'synthetic-renewal'}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',provider,source:provider==='codex'?'import':undefined,options:{fetch:outbound,importCodexCredentials:async()=>({accessToken:'synthetic',refreshToken:'refresh',idToken:null,accountId:'fixture',email:'fixture@example.com',expiresAt:Date.now()+3600000})}});
    const token=await issued(fixture);
    const request=async(key:string,route:string)=>{
      const bytes=new TextEncoder().encode(key);
      const metadata=Uint8Array.of(0x1a,bytes.length,...bytes);
      const proto=Buffer.from(Uint8Array.of(0x0a,metadata.length,...metadata));
      return fixture.host.harness.behavior.fetchHttp(route==='/v1/models'?'GET':'POST',route,{headers:{...authHeaders(key),authorization:`${provider==='devin'?'Basic':'Bearer'} ${key}`,'x-api-key':key,'content-type':provider==='devin'?'application/proto':'application/json'},...(route==='/v1/models'?{}:{body:provider==='devin'?proto:'{}'})});
    };
    // Drain/project role cannot turn an explicit purpose denial into an admission.
    await fixture.host.harness.behavior.callRpc('account.setDrainOnce',{accountId:fixture.account.id,enabled:true});
    outbound.mockClear();
    for(const route of routes[provider]) {
      const response=await request(token,route);
      if(provider==='opencode-go' && route.endsWith('/responses')) {expect(response.status).toBe(400);await response.text();continue;}
      expect(response.status,route).toBe(403);
      expect(response.headers.get('x-bb-pool-error')).toBe('POOL_ACCOUNT_POLICY');
      await response.text();
    }
    expect(outbound).not.toHaveBeenCalled();
    const ordinary=await request(fixture.key,routes[provider][0]!);await ordinary.text();
    expect(outbound).toHaveBeenCalled();
    outbound.mockClear();
    await allow(fixture);
    const permitted=await request(token,routes[provider][0]!);await permitted.text();
    expect(outbound).toHaveBeenCalled();
    expect(permitted.headers.get('x-bb-pool-error')).not.toBe('POOL_ACCOUNT_POLICY');
    await allow(fixture,false,true);
    outbound.mockClear();
    const deniedAgain=await request(token,routes[provider][0]!);await deniedAgain.text();
    expect(deniedAgain.status).toBe(403);expect(outbound).not.toHaveBeenCalled();
  });

  it.each(['project','disabled','schedule','cap'] as const)('keeps existing %s restrictions on an opted-in account',async restriction=>{
    const outbound=vi.fn(async()=>Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    await allow(fixture);const token=await issued(fixture);
    const rpc=fixture.host.harness.behavior.callRpc;
    if(restriction==='project') await rpc('account.setProjects',{accountId:fixture.account.id,projects:{onlySelected:true,rules:[{projectId:'foreign',role:'primary'}]}});
    if(restriction==='disabled') await rpc('account.disable',{id:fixture.account.id});
    if(restriction==='schedule') await rpc('account.setPolicy',{accountId:fixture.account.id,policy:{enabled:true,schedule:{timeZone:'UTC',intervals:[]}}});
    if(restriction==='cap') {
      const quotas=new QuotaStore(fixture.host.bb.storage.database());
      quotas.put({...quotas.get(fixture.account.id),sevenDayUtilization:0.8,sevenDayResetAt:Date.now()+86400000});
      await rpc('account.setCap',{accountId:fixture.account.id,cap:{early:0.1,late:0.1}});
    }
    outbound.mockClear();
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(token),body:'{}'});
    expect(response.ok).toBe(false);await response.text();expect(outbound).not.toHaveBeenCalled();
  });

  it('does not infer purpose from name/header and enforces strict permission CAS',async()=>{
    const outbound=vi.fn(async()=>Response.json({}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    const file=path.join(fixture.dataDir,'legacy.token');
    expect((await fixture.host.harness.behavior.runCli(['client','add','autopilot','--project','project-one','--output',file])).exitCode).toBe(0);
    const token=(await fs.readFile(file,'utf8')).trim();outbound.mockClear();
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:{...authHeaders(token),'x-bb-pool-purpose':'autopilot'},body:'{}'});await response.text();
    expect(outbound).toHaveBeenCalled();
    await allow(fixture);
    await expect(allow(fixture,false,false)).rejects.toThrow('permission changed');
    await expect(fixture.host.harness.behavior.callRpc('account.setAutopilotAllowed',{accountId:fixture.account.id,allowed:true,expectedAllowed:true,unexpected:true})).rejects.toThrow();
  });

  it('retains purpose through Cursor local exchange and guards the dynamic RPC route',async()=>{
    const outbound=vi.fn(async()=>Response.json({accessToken:'synthetic',refreshToken:'synthetic'}));
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',provider:'cursor',options:{fetch:outbound}});
    const token=await issued(fixture);outbound.mockClear();
    const exchange=await fixture.host.harness.behavior.fetchHttp('POST','/cursor/auth/exchange_user_api_key',{headers:authHeaders(token),body:'{}'});
    expect(await exchange.json()).toEqual({accessToken:token,refreshToken:token});
    for(const method of ['GET','POST'] as const){
      const response=await fixture.host.harness.behavior.fetchHttp(method,'/cursor/rpc',{headers:{...authHeaders(token),'x-bb-cursor-rpc-path':'agent.v1.AgentService/Run'},...(method==='POST'?{body:'{}'}:{})});
      expect(response.status).toBe(403);await response.text();
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it('rechecks opt-out on failover and never falls back to an ordinary account',async()=>{
    let fixture:Fixture;
    let calls=0;
    const outbound=vi.fn(async()=>{
      calls++;
      if(calls===1){await allow(fixture,false,true);return Response.json({error:'synthetic'},{status:401});}
      return Response.json({});
    });
    fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
    await addApiAccount(fixture,'ordinary-only',200);
    await allow(fixture);
    const token=await issued(fixture);
    outbound.mockClear();calls=0;
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(token),body:'{}'});await response.text();
    expect(calls).toBe(1);
  });

  it('rechecks purpose before a real OAuth authentication retry',async()=>{
    let fixture:Fixture;
    let modelCalls=0;
    const clock=Date.now();
    const fetcher:typeof fetch=async(input)=>{
      if(String(input).endsWith('/oauth/token')) return Response.json({access_token:'renewed',refresh_token:'renewal',expires_in:3600});
      modelCalls++;
      await allow(fixture,false,true);
      return Response.json({error:'synthetic'},{status:401});
    };
    fixture=await createOAuthRequestFixture('codex',fetcher,()=>clock);
    await allow(fixture);
    const token=await issued(fixture);
    const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/responses',{headers:authHeaders(token),body:'{}'});
    await response.text();expect(modelCalls).toBe(1);
  });

  it('isolates same-session affinity and includes purpose in conservative budget evidence',async()=>{
    const upstreamKeys:string[]=[];
    const fixture=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:async(_input,init)=>{upstreamKeys.push(new Headers(init?.headers).get('x-api-key')!);return Response.json({id:'synthetic-response'});}}});
    const second=await addApiAccount(fixture,'automation-only',200);
    await allow(fixture,true,false,second.id);
    const token=await issued(fixture);
    const body=JSON.stringify({model:'claude-opus-4-6',metadata:{user_id:JSON.stringify({session_id:'shared-session'})},messages:[]});
    const request=async(key:string)=>{const response=await fixture.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(key),body});await response.text();return response;};
    await request(fixture.key);await request(token);await request(fixture.key);
    expect(upstreamKeys).toEqual(['sk-account','automation-only','sk-account']);
    // Budget exists only for Codex; a trusted caller is attested even with no Codex account.
    const evidence=await (await fixture.host.harness.behavior.fetchHttp('GET','/budget/codex',{headers:authHeaders(token)})).json();
    expect(evidence.purpose).toBe('autopilot');expect(evidence.accounts).toEqual([]);
    const legacy=await (await fixture.host.harness.behavior.fetchHttp('GET','/budget/codex',{headers:authHeaders(fixture.key)})).json();
    expect(legacy).not.toHaveProperty('purpose');
  });
});


describe("busy Codex usage collection", () => {
  it.each(["complete", "missing-secondary", "malformed-duration"] as const)("shares one usage read during an open stream and validates %s evidence", async (shape) => {
    let blockUsage = false;
    let usageCalls = 0;
    let releaseUsage: (() => void) | undefined;
    const pendingUsage = new Promise<void>(resolve => { releaseUsage = resolve; });
    const usagePayload = () => ({rate_limit: {allowed: true, limit_reached: false,
      primary_window: {used_percent: 40, limit_window_seconds: shape === "malformed-duration" ? 604800.5 : 604800,
        reset_at: Math.floor(Date.now()/1000)+86400}, ...(shape === "missing-secondary" ? {} : {secondary_window: null})}});
    const fixture = await createFixture({upstreamUrl: "https://upstream.example", provider: "codex", source: "import",
      options: {codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({accessToken:"synthetic-access",refreshToken:"synthetic-refresh",idToken:null,
          accountId:"synthetic-account",email:null,expiresAt:Date.now()+86400000}),
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.url === EMPTY_USAGE_URL) {
            if (blockUsage) { usageCalls++; await pendingUsage; }
            return Response.json(usagePayload());
          }
          return new Response(new ReadableStream<Uint8Array>({start(controller) {
            controller.enqueue(new TextEncoder().encode("data: synthetic-open-stream\n\n"));
          }}), {headers:{"content-type":"text/event-stream"}});
        },
      }});
    const rpc=fixture.host.harness.behavior.callRpc;
    await rpc("account.refreshUsage",{accountId:fixture.account.id});
    const response=await fixture.host.harness.behavior.fetchHttp("POST","/v1/responses",{
      headers:authHeaders(fixture.key),body:JSON.stringify({model:"synthetic-model",input:"synthetic",stream:true})});
    expect(response.status).toBe(200);
    try {
      expect(statusSchema.parse(await rpc("status.get",null)).inFlight).toBe(1);
      blockUsage=true;
      const first=rpc("account.refreshUsage",{accountId:fixture.account.id});
      await vi.waitFor(()=>expect(usageCalls).toBe(1));
      const second=rpc("account.refreshUsage",{accountId:fixture.account.id});
      await new Promise(resolve=>setImmediate(resolve));
      expect(usageCalls).toBe(1);
      releaseUsage!(); await Promise.all([first,second]);
      expect(statusSchema.parse(await rpc("status.get",null)).inFlight).toBe(1);
      const budget=await fixture.host.harness.behavior.fetchHttp("GET","/budget/codex?projectId=project-one",{headers:authHeaders(fixture.key)});
      expect(budget.status).toBe(200);
      const payload=await budget.json() as {accounts:Array<{budgetReady:boolean;windows:unknown}>};
      if (shape === "complete") {
        expect(payload.accounts[0]).toMatchObject({budgetReady:true,windows:{fiveHour:{state:"absent",remainingPercent:null},weekly:{state:"present",remainingPercent:60}}});
      } else {
        expect(payload.accounts[0]).toMatchObject({budgetReady:false});
      }
    } finally { releaseUsage!(); await response.body?.cancel(); }
    await vi.waitFor(async()=>expect(statusSchema.parse(await rpc("status.get",null)).inFlight).toBe(0));
  });

  it("serializes a token refresh shared by busy usage and a new inference request", async () => {
    let clock=Date.now();
    let refreshCalls=0;
    let releaseRefresh:(()=>void)|undefined;
    const refreshing=new Promise<void>(resolve=>{releaseRefresh=resolve;});
    const oldToken=testJwt({exp:Math.floor(clock/1000)+3600});
    let newToken="";
    const inferenceTokens:Array<string|null>=[];
    const usageTokens:Array<string|null>=[];
    const fixture=await createFixture({upstreamUrl:"https://upstream.example",provider:"codex",source:"import",options:{
      now:()=>clock,codexUsageUrl:EMPTY_USAGE_URL,codexRefreshUrl:"https://refresh.example/token",
      importCodexCredentials:async()=>({accessToken:oldToken,refreshToken:"synthetic-refresh",idToken:null,accountId:"synthetic-account",email:null,expiresAt:clock+3600000}),
      fetch:async(input,init)=>{
        const request=new Request(input,init);
        if(request.url==="https://refresh.example/token"){
          refreshCalls++;await refreshing;
          newToken=testJwt({exp:Math.floor(clock/1000)+3600});
          return Response.json({access_token:newToken,refresh_token:"synthetic-next-refresh"});
        }
        if(request.url===EMPTY_USAGE_URL){
          usageTokens.push(request.headers.get("authorization"));
          return Response.json({rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:40,limit_window_seconds:604800,reset_at:Math.floor(clock/1000)+86400},secondary_window:null}});
        }
        inferenceTokens.push(request.headers.get("authorization"));
        return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("data: synthetic\n\n"));}}),{headers:{"content-type":"text/event-stream"}});
      }}});
    const rpc=fixture.host.harness.behavior.callRpc;
    await rpc("account.refreshUsage",{accountId:fixture.account.id});
    const send=()=>fixture.host.harness.behavior.fetchHttp("POST","/v1/responses",{headers:authHeaders(fixture.key),body:JSON.stringify({model:"synthetic-model",input:"synthetic",stream:true})});
    const first=await send();let second:Response|undefined;
    try {
      clock+=3590000;
      const usage=rpc("account.refreshUsage",{accountId:fixture.account.id});
      await vi.waitFor(()=>expect(refreshCalls).toBe(1));
      const next=send();
      await new Promise(resolve=>setImmediate(resolve));
      expect(refreshCalls).toBe(1);
      releaseRefresh!();await usage;second=await next;
      expect(refreshCalls).toBe(1);
      expect(inferenceTokens).toEqual([`Bearer ${oldToken}`,`Bearer ${newToken}`]);
      expect(usageTokens.at(-1)).toBe(`Bearer ${newToken}`);
      expect(statusSchema.parse(await rpc("status.get",null)).inFlight).toBe(2);
    } finally {releaseRefresh!();await first.body?.cancel();await second?.body?.cancel();}
  });

  it.each([false,true])("handles usage401 with refresh rejection=%s without interrupting the stream", async (denyRefresh) => {
    let rejectUsage=false;
    let refreshCalls=0;
    let usageAfterRejection=0;
    const clock=Date.now();
    const nextToken=testJwt({exp:Math.floor(clock/1000)+7200});
    const fixture=await createFixture({upstreamUrl:"https://upstream.example",provider:"codex",source:"import",options:{
      codexUsageUrl:EMPTY_USAGE_URL,codexRefreshUrl:"https://refresh.example/token",
      importCodexCredentials:async()=>({accessToken:"synthetic-old",refreshToken:"synthetic-refresh",idToken:null,accountId:"synthetic-account",email:null,expiresAt:clock+3600000}),
      fetch:async(input,init)=>{
        const request=new Request(input,init);
        if(request.url==="https://refresh.example/token"){
          refreshCalls++;
          return denyRefresh?Response.json({error:"invalid_grant"},{status:400}):Response.json({access_token:nextToken,refresh_token:"synthetic-next"});
        }
        if(request.url===EMPTY_USAGE_URL){
          if(rejectUsage){
            usageAfterRejection++;
            if(request.headers.get("authorization")!==`Bearer ${nextToken}`)return new Response(null,{status:401});
          }
          return Response.json({rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:40,limit_window_seconds:604800,reset_at:Math.floor(clock/1000)+86400},secondary_window:null}});
        }
        return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("data: synthetic\n\n"));}}),{headers:{"content-type":"text/event-stream"}});
      }}});
    const rpc=fixture.host.harness.behavior.callRpc;
    await rpc("account.refreshUsage",{accountId:fixture.account.id});
    const response=await fixture.host.harness.behavior.fetchHttp("POST","/v1/responses",{headers:authHeaders(fixture.key),body:JSON.stringify({model:"synthetic-model",input:"synthetic",stream:true})});
    try {
      rejectUsage=true;
      const refresh=rpc("account.refreshUsage",{accountId:fixture.account.id});
      if(denyRefresh)await expect(refresh).rejects.toThrow("invalid_grant");else await refresh;
      expect(refreshCalls).toBe(1);
      expect(usageAfterRejection).toBe(denyRefresh?1:2);
      const status=statusSchema.parse(await rpc("status.get",null));
      expect(status.inFlight).toBe(1);
      expect(Boolean(status.accounts[0]?.error)).toBe(denyRefresh);
    } finally {await response.body?.cancel();}
  });

  it("keeps other providers busy-protected while a stream is open", async () => {
    let usageCalls=0;
    const fixture=await createFixture({upstreamUrl:"https://upstream.example",source:"import",options:{
      usageUrl:EMPTY_USAGE_URL,importCredentials:async()=>importedCredentials(),
      fetch:async(input,init)=>{
        if(new Request(input,init).url===EMPTY_USAGE_URL){usageCalls++;return Response.json({});}
        return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("data: synthetic\n\n"));}}),{headers:{"content-type":"text/event-stream"}});
      }}});
    const response=await fixture.host.harness.behavior.fetchHttp("POST","/v1/messages",{headers:authHeaders(fixture.key),body:"{}"});
    try {
      const before=usageCalls;
      await expect(fixture.host.harness.behavior.callRpc("account.refreshUsage",{accountId:fixture.account.id})).rejects.toThrow("Аккаунт занят");
      expect(usageCalls).toBe(before);
    } finally {await response.body?.cancel();}
  });
});

describe('shared account request pressure',()=>{
 it('holds two slots through streaming and queues native hosts and an external client together',async()=>{
  const streams:ReadableStreamDefaultController<Uint8Array>[]=[];
  const outbound=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){streams.push(c);}})));
  const f=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
  const other=await resolveToken(f.host,'host-two','thread-two');
  const file=path.join(f.dataDir,'external.token');
  expect((await f.host.harness.behavior.runCli(['client','add','synthetic-pressure','--output',file])).exitCode).toBe(0);
  const external=(await fs.readFile(file,'utf8')).trim();
  const send=(key:string,signal?:AbortSignal)=>f.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(key),body:'{}',signal});
  const first=await send(f.key),second=await send(other),thirdPromise=send(external);
  await vi.waitFor(async()=>{
   const status=statusSchema.parse(await f.host.harness.behavior.callRpc('status.get',null));
   expect(status.accounts[0]).toMatchObject({inFlight:2,queuedRequests:1,concurrencyLimit:2});
  });
  expect(outbound).toHaveBeenCalledTimes(2);
  const firstText=first.text();streams[0]!.close();await firstText;
  const third=await thirdPromise;expect(outbound).toHaveBeenCalledTimes(3);
  const texts=[second.text(),third.text()];streams[1]!.close();streams[2]!.close();await Promise.all(texts);
  const status=statusSchema.parse(await f.host.harness.behavior.callRpc('status.get',null));
  expect(status.accounts[0]).toMatchObject({inFlight:0,queuedRequests:0});
 });
 it('preserves actual Codex429 hold through a late200 and queues another attempt instead of fabricating a429',async()=>{
  const now=Date.now();let calls=0,late!:(value:Response)=>void;
  const normal=()=>Response.json({}, {headers:{'x-codex-primary-used-percent':'15','x-codex-primary-window-minutes':'10080'}});
  const outbound=vi.fn(async(input:RequestInfo|URL)=>{
   if(String(input).includes('usage'))return Response.json({});
   calls++;if(calls===1)return normal();
   if(calls===2)return new Promise<Response>(resolve=>{late=resolve;});
   if(calls===3)return Response.json({}, {status:429,headers:{'retry-after':'60'}});
   return normal();
  });
  const f=await createFixture({upstreamUrl:'https://upstream.example',provider:'codex',source:'import',options:{fetch:outbound,
   importCodexCredentials:async()=>({accessToken:'synthetic',refreshToken:'synthetic-refresh',idToken:null,accountId:'fixture-account',email:'fixture@example.com',expiresAt:now+3600000})}});
  const send=(signal?:AbortSignal)=>f.host.harness.behavior.fetchHttp('POST','/v1/responses',{headers:authHeaders(f.key),body:JSON.stringify({model:'gpt-6-sol',prompt_cache_key:'synthetic-session',input:[]}),signal});
  await (await send()).text();const pending=send();await vi.waitFor(()=>expect(calls).toBe(2));
  const rejected=await send();expect(rejected.status).toBe(429);await rejected.text();
  const quotas=new QuotaStore(f.host.bb.storage.database());const hold=quotas.get(f.account.id).heldUntil!;expect(hold).toBeGreaterThan(Date.now()+59000);
  late(normal());await (await pending).text();expect(quotas.get(f.account.id).heldUntil).toBe(hold);
  const abort=new AbortController(),queued=send(abort.signal);
  await vi.waitFor(async()=>expect(statusSchema.parse(await f.host.harness.behavior.callRpc('status.get',null)).accounts[0]!.queuedRequests).toBe(1));
  expect(calls).toBe(3);abort.abort();expect((await queued).status).toBe(499);expect(calls).toBe(3);
 });
 it('rechecks account enablement after waiting and releases a canceled queued slot',async()=>{
  const streams:ReadableStreamDefaultController<Uint8Array>[]=[];
  const outbound=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){streams.push(c);}})));
  const f=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
  await f.host.harness.behavior.callRpc('config.set',{maxConcurrentRequestsPerAccount:1});
  const send=(signal?:AbortSignal)=>f.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(f.key),body:'{}',signal});
  const first=await send(),abort=new AbortController(),canceled=send(abort.signal);
  await vi.waitFor(async()=>expect(statusSchema.parse(await f.host.harness.behavior.callRpc('status.get',null)).accounts[0]!.queuedRequests).toBe(1));
  abort.abort();expect((await canceled).status).toBe(499);
  const denied=send();await vi.waitFor(async()=>expect(statusSchema.parse(await f.host.harness.behavior.callRpc('status.get',null)).accounts[0]!.queuedRequests).toBe(1));
  await f.host.harness.behavior.callRpc('account.disable',{id:f.account.id});
  const text=first.text();streams[0]!.close();await text;
  expect((await denied).status).toBe(403);expect(outbound).toHaveBeenCalledTimes(1);
 });
});

it('config.set wakes an already queued request while the first stream remains open',async()=>{
 const streams:ReadableStreamDefaultController<Uint8Array>[]=[];
 const outbound=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){streams.push(c);}})));
 const f=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:outbound}});
 await f.host.harness.behavior.callRpc('config.set',{maxConcurrentRequestsPerAccount:1});
 const send=()=>f.host.harness.behavior.fetchHttp('POST','/v1/messages',{headers:authHeaders(f.key),body:'{}'});
 const first=await send(),queued=send();
 await vi.waitFor(async()=>expect(statusSchema.parse(await f.host.harness.behavior.callRpc('status.get',null)).accounts[0]!.queuedRequests).toBe(1));
 expect(outbound).toHaveBeenCalledTimes(1);
 await f.host.harness.behavior.callRpc('config.set',{maxConcurrentRequestsPerAccount:2});
 await vi.waitFor(()=>expect(outbound).toHaveBeenCalledTimes(2));
 const second=await queued;
 const status=statusSchema.parse(await f.host.harness.behavior.callRpc('status.get',null));
 expect(status.accounts[0]).toMatchObject({inFlight:2,queuedRequests:0,concurrencyLimit:2});
 const texts=[first.text(),second.text()];for(const stream of streams)stream.close();await Promise.all(texts);
});

it('keeps managed Claude on the pool when every account is unavailable',async()=>{
 const f=await createFixture({upstreamUrl:'https://upstream.example',options:{fetch:async()=>Response.json({})}});
 await f.host.harness.behavior.callRpc('account.disable',{id:f.account.id});
 const env=await f.host.harness.behavior.resolveProviderEnv('claude-code',{threadId:'thread-no-account',projectId:'project-one',hostId:'host-one'});
 expect(env).toEqual(expect.arrayContaining([expect.objectContaining({name:'ANTHROPIC_BASE_URL'}),expect.objectContaining({name:'ANTHROPIC_AUTH_TOKEN'})]));
 await f.host.harness.behavior.runCli(['routing','claude','--off']);
 await expect(f.host.harness.behavior.resolveProviderEnv('claude-code',{threadId:'thread-no-account',projectId:'project-one',hostId:'host-one'})).resolves.toEqual([]);
});
