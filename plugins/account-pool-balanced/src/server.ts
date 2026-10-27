import {AgyOAuthLogin,readNativeAgyConfig,type AgyAppConfig} from "./agy-oauth-login.js";
import { RequestJournal } from "./request-journal.js";
import {createGuardNetworkCheck,bindGuardNetworkDecision,hostGuardDecisionSchema} from "./guard-network.js";
import {z} from "zod";
import { describeTransportError } from "./transport-diagnostics.js";
import { registerNetworkRetry } from "./network-retry.js";
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import { ExternalClients, combinedTokens } from "./external-clients.js";
import {
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  type AccountPoolConfigController,
  type PoolProvider,
} from "./contracts.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { createHub } from "./hub.js";
import { CURSOR_RPC_PATH_HEADER, isCursorRpcPath } from "./cursor-rpc.js";
import {
  CURSOR_EXCHANGE_PATH,
  CURSOR_MOUNT_PREFIX,
  CURSOR_PROXIED_PATHS,
} from "./cursor-adapter.js";
import { KIMI_MOUNT_PREFIX } from "./kimi-adapter.js";
import { DEVIN_MOUNT_PREFIX, DEVIN_PROXIED_PATHS } from "./devin-adapter.js";
import {
  OPENCODE_GO_MOUNT_PREFIX,
  ZAI_MOUNT_PREFIX,
} from "./openai-compatible-adapter.js";
import { PoolOperations } from "./operations.js";
import { registerUsageSource } from "./usage-source.js";
import { accountPoolRpcContract, createRpcHandlers } from "./rpc.js";
import { openAccountBrowser, listBrowserProfiles } from "./browser-profiles.js";
import {createBrowserRouter,browserHostContract} from "./browser-host.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";

export interface AccountPoolPluginOptions {
  agyAppConfig?:()=>Promise<AgyAppConfig>;
  fetch?: typeof fetch;
  fetchIpv4?:typeof fetch;
  vpnPayload?: (nowMs:number) => Promise<unknown>;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  kimiUsagesUrl?: string;
  zaiUsagesUrl?: string;
  opencodeGoUsagesUrl?: string;
  cursorExchangeUrl?: string;
  cursorUsageUrl?: string;
  usageUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  disposeTimeoutMs?: number;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
}

interface ProviderEnvScope {
  hostId: string;
  projectId: string | null;
  threadId: string | null;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");
function hubBasePath(pluginId: string): string {
  return `/api/v1/plugins/${pluginId}/http`;
}

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    let currentSettings = accountPoolConfigSchema.parse(
      (await bb.storage.kv.get("config")) ?? {},
    );
    // Persist the sanitized configuration so retired switches are not retained.
    await bb.storage.kv.set("config",currentSettings);
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        if(update.browserHostId && !(await bb.sdk.hosts.list()).some(h=>h.id===update.browserHostId))throw Error('Account browser host must be enrolled.');
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return next;
      },
    };
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const hubTokens = new HubTokenStore(secretDir, now);
    await hubTokens.initialize();
    const enrolledHosts = await bb.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const externalClients = new ExternalClients(path.join(secretDir, "external-clients"));
    await externalClients.tokens.initialize();
    const routing = new RoutingStore(bb.storage.kv, now);
    // bb resolves provider env with a null thread and project when it lists models.
    const isThreadBypassed = async (context: ProviderEnvScope) =>
      context.threadId !== null && (await routing.isBypassed(context.threadId));
    const scopedHubToken = (context: ProviderEnvScope) =>
      context.threadId === null
        ? hubTokens.forProject(context.hostId, context.projectId)
        : hubTokens.forThread(context.hostId, context.projectId, context.threadId);
    const db = bb.storage.database();
    bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const journal=new RequestJournal(path.join(bb.server.experimental_dataDir,'plugins',bb.pluginId,'request-metadata','recent.json'),now);
    await journal.initialize();
    bb.onDispose(()=>journal.close());
    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;
    const upstreamFetch = options.fetch ?? transport?.fetch;
    // BB HTTP registrations are exact paths. Cache only validated model IDs,
    // never credentials, and derive routes from authenticated provider catalogs.
    const agyModels=new Set<string>();
    const registerAgyModels=async(ids:string[])=>{
      const safe=z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)).max(512).parse(ids);
      const next=new Set([...agyModels,...safe]);
      if(next.size>512)throw Error('Antigravity registered model limit reached');
      for(const id of next){
        if(agyModels.has(id))continue;
        for(const action of ['generateContent','streamGenerateContent'])bb.http.route('POST',`/agy/v1beta/models/${id}:${action}`,context=>hub.handle(context.req.raw,'agy'),{auth:'none'});
        agyModels.add(id);
      }
      await bb.storage.kv.set('agy-model-ids-v1',[...agyModels]);
    };
    await registerAgyModels((await bb.storage.kv.get<string[]>('agy-model-ids-v1'))??[]);
    const hub = createHub({
      agyModels:registerAgyModels,
      route: hubBasePath(bb.pluginId),
      accounts,
      quotas,
      journal,
      affinity: new PoolAffinityStore(db),
      hubTokens: combinedTokens(hubTokens, externalClients.tokens),
      getSettings: () => currentSettings,
      fetch: upstreamFetch,fetchIpv4:options.fetchIpv4??transport?.fetchIpv4,
      vpnPayload: options.vpnPayload,
      guardCheck:createGuardNetworkCheck(async (provider,signal)=>{
        const hostId=(await bb.sdk.system.config({signal})).primaryHostId;
        if(!hostId) throw new Error("Pool server machine unknown");
        const decision=await bb.sdk.plugins.callRpc({pluginId:"vpn-guard",method:"networkDecisionV2",input:{hostId,provider},outputSchema:hostGuardDecisionSchema,signal});
        // Rebind after I/O: migration during the RPC cannot grant another host's egress.
        if((await bb.sdk.system.config({signal})).primaryHostId!==hostId)throw Error('Pool server machine changed');
        return bindGuardNetworkDecision(decision,hostId);
      }),
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      kimiUsagesUrl: options.kimiUsagesUrl,
      zaiUsagesUrl: options.zaiUsagesUrl,
      opencodeGoUsagesUrl: options.opencodeGoUsagesUrl,
      cursorExchangeUrl: options.cursorExchangeUrl,
      cursorUsageUrl: options.cursorUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      importClaudeCredentials: options.importCredentials,
      importCodexCredentials: options.importCodexCredentials,
      drainTimeoutMs: options.drainTimeoutMs,
      maxAffinityBindings: options.maxAffinityBindings,
      onUpstreamError: (provider, error, context) => {
        const diagnostic = describeTransportError(error);
        bb.log.warn(
          `Account Pooler ${provider} transport failed: ${transportErrorCode(error)}. ` +
          JSON.stringify({ ...diagnostic, ...context }),
        );
      },
      onAccountsChanged: () =>
        bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
    });
    if (transport !== null) {
      bb.providers.experimental_contributeEnv("acp-oxi-devin-pool", async context => {
        if (!(await operations.isRoutingEnabled("devin")) || await isThreadBypassed(context) ||
          !(await operations.hasUsableEnabledAccount("devin"))) return [];
        return [
          { name: "OXI_DEVIN_POOL_TOKEN", value: await scopedHubToken(context), reason: "Project-bound Account Pooler token" },
          { name: "OXI_DEVIN_POOL_URL", value: { serverPath: hubBasePath(bb.pluginId) }, reason: "Account Pooler route" },
        ];
      });
      bb.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }
    bb.background.service("network-policy",{async start(signal){
      while(!signal.aborted){await hub.enforceNetworkPolicy();await new Promise<void>(resolve=>{
        const done=()=>{clearTimeout(timer);signal.removeEventListener("abort",done);resolve();};
        const timer=setTimeout(done,1000);signal.addEventListener("abort",done,{once:true});if(signal.aborted)done();
      });}
    }});
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => bb.sdk.hosts.list(),
      async (hostId) =>
        (await bb.sdk.system.providerStates({ hostId })).providers,
      now,
      () => bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      (accountId) => hub.refreshUsage(accountId, true),
    );
    const retryProviders:Readonly<Record<string,PoolProvider>>={
      codex:'codex','claude-code':'claude','acp-oxi-cursor':'cursor',
      'acp-oxi-devin-pool':'devin','acp-opencode-zai':'zai',
      'acp-agy':'agy','acp-opencode-neuraldeep':'neuraldeep','acp-opencode-go':'opencode-go','acp-opencode-kimi':'kimi',
      'acp-opencode-kimi-highspeed':'kimi',
    };
    await registerNetworkRetry(bb,async(threadId,providerId)=>{
      const provider=retryProviders[providerId];
      return !!provider && !await routing.isBypassed(threadId) &&
        await operations.isRoutingEnabled(provider) && await operations.hasUsableEnabledAccount(provider);
    },now);
    const login = new ClaudeOAuthLogin({
      beforeStart: () => hub.assertNetworkAllowed("claude"),
      fetch: hub.outboundFetch("claude"),
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated, targetAccountId) => operations.addOAuth(authenticated, targetAccountId),
    });
    const agyLogin=new AgyOAuthLogin({fetch:hub.outboundFetch("agy"),appConfig:options.agyAppConfig??readNativeAgyConfig,onModels:registerAgyModels,now});
    const codexLogin = new CodexDeviceLogin({
      fetch: hub.outboundFetch("codex"),
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
    });
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(
        "Add and enable a Claude or Codex account with `bb pool account add`.",
      );
    }
    const browserHost=bb.hosts.experimental_client({contract:browserHostContract});
    const browser=createBrowserRouter({
      getHostId:()=>config.get().browserHostId,
      listHosts:()=>bb.sdk.hosts.list(),accounts:()=>operations.list(),
      callHost:(method,input,hostId)=>method==='open'
        ? browserHost.call('open',browserHostContract.open.input.parse(input),{hostId,timeoutMs:60000})
        : browserHost.call('list',browserHostContract.list.input.parse(input),{hostId,timeoutMs:10000}),
      localOpen:async(query,url)=>openAccountBrowser({accounts:await operations.list(),query,url,dataDir:bb.server.experimental_dataDir,pluginId:bb.pluginId,vpnStatusFile:config.get().vpnStatusFile}),
      localList:async()=>listBrowserProfiles({accounts:await operations.list(),dataDir:bb.server.experimental_dataDir,pluginId:bb.pluginId}),
    });
    bb.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(operations, login, codexLogin, config, async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
        const provider:PoolProvider|null = ({codex:'codex','claude-code':'claude','acp-oxi-cursor':'cursor','acp-oxi-devin-pool':'devin','acp-opencode-zai':'zai','acp-agy':'agy','acp-opencode-neuraldeep':'neuraldeep','acp-opencode-go':'opencode-go','acp-opencode-kimi':'kimi','acp-opencode-kimi-highspeed':'kimi'} as Record<string,PoolProvider>)[thread.providerId]??null;
        const empty = { account: null, lastUsedAt: null };
        if (provider === null) return { state: "unsupported", ...empty };
        if (await routing.isBypassed(threadId) || !(await operations.isRoutingEnabled(provider)))
          return { state: "bypassed", ...empty };
        const hostId = "environment" in thread ? thread.environment?.hostId : undefined;
        if (!hostId) return { state: "unobserved", ...empty };
        const direct=hub.threadObservation(provider,hostId,threadId,thread.projectId);
        if(direct!==null){const account=(await operations.list()).find(item=>item.id===direct.accountId)??null;return {state:'observed',account,lastUsedAt:direct.lastUsedAt};}
        if(provider!=='codex'&&provider!=='claude')return {state:'unobserved',...empty};
        const events = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "5", types: ["thread/started", "thread/identity", "turn/started"] });
        let sessionId: string | null = null;
        for (const event of events) {
          const data = event.data;
          if (typeof data === "object" && data !== null && "providerThreadId" in data && typeof data.providerThreadId === "string") {
            sessionId = data.providerThreadId;
            break;
          }
        }
        const observation = sessionId === null ? null : hub.sessionObservation(provider, hostId, sessionId, thread.projectId);
        if (observation === null) return { state: "unobserved", ...empty };
        const account = (await operations.list()).find((item) => item.id === observation.accountId) ?? null;
        return { state: "observed", account, lastUsedAt: observation.lastUsedAt };
      }, async () => (await bb.sdk.projects.list({ includePersonal: true })).map(project => ({ id: project.id, name: project.name })), async ({ accountId, url }) => {
        const inventory = await operations.list();
        if (!inventory.some(account => account.id === accountId)) throw new Error("Account no longer exists");
        await browser.open(accountId,url);
        return { opened: true };
      }, agyLogin),
    );
    registerPoolCli(bb, operations, login, codexLogin, config, externalClients,browser);
    registerUsageSource(bb, hub);
    const proxiedHealth = async (provider: PoolProvider) =>
      (await operations.isRoutingEnabled(provider)) &&
      (await operations.hasUsableEnabledAccount(provider))
        ? {
            label: "Proxied",
            statusMessage:
              "Credentials are provided by the Account Pooler hub.",
          }
        : null;
    bb.providers.experimental_contributeEnv("claude-code", async (context) => {
      if (
        !(await operations.isRoutingEnabled("claude")) ||
        (await isThreadBypassed(context)) ||
        !(await operations.hasUsableEnabledAccount("claude"))
      ) {
        return [];
      }
      const token = await scopedHubToken(context);
      if (context.threadId !== null) {
        await routing.recordRouted(context.threadId, context.hostId);
      }
      return [
        {
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: hubBasePath(bb.pluginId) },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
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
      ];
    });
    bb.providers.experimental_contributeEnvHealth("claude-code", () =>
      proxiedHealth("claude"),
    );
    bb.providers.experimental_contributeEnv("codex", async (context) => {
      if (
        !(await operations.isRoutingEnabled("codex")) ||
        (await isThreadBypassed(context)) ||
        !(await operations.hasUsableEnabledAccount("codex"))
      ) {
        return [];
      }
      const token = await scopedHubToken(context);
      return [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: { serverPath: `${hubBasePath(bb.pluginId)}/v1` },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("codex", () =>
      proxiedHealth("codex"),
    );
    bb.http.route('GET','/agy/v1beta/models',context=>hub.handle(context.req.raw,'agy'),{auth:'none'});
    bb.providers.experimental_contributeEnv('acp-agy',async context=>{
      if(!(await operations.isRoutingEnabled('agy'))||await isThreadBypassed(context)||!(await operations.hasUsableEnabledAccount('agy')))return [];
      const token=await scopedHubToken(context);
      return [{name:'OXI_AGY_POOL_BASE_URL',value:{serverPath:`${hubBasePath(bb.pluginId)}/agy`},reason:'Native Antigravity gateway through Pooler'},
        {name:'OXI_AGY_POOL_AUTH_TOKEN',value:token,reason:'Pool credential only; Google OAuth remains server-side'}];
    });
    bb.providers.experimental_contributeEnvHealth('acp-agy',()=>proxiedHealth('agy'));
    const openAiCompatibleRoutes: ReadonlyArray<{
      provider: PoolProvider;
      mountPrefix: string;
      providerId: string;
      keyEnv: string;
      baseUrlEnv: string;
    }> = [
      {
        provider: "zai",
        mountPrefix: ZAI_MOUNT_PREFIX,
        providerId: "acp-opencode-zai",
        keyEnv: "ZAI_API_KEY",
        baseUrlEnv: "OXI_ZAI_BASE_URL",
      },
      {
        provider: "neuraldeep",
        mountPrefix: "neuraldeep/",
        providerId: "acp-opencode-neuraldeep",
        keyEnv: "NEURALDEEP_API_KEY",
        baseUrlEnv: "OXI_NEURALDEEP_BASE_URL",
      },
      {
        provider: "opencode-go",
        mountPrefix: OPENCODE_GO_MOUNT_PREFIX,
        providerId: "acp-opencode-go",
        keyEnv: "OPENCODE_API_KEY",
        baseUrlEnv: "OXI_OPENCODE_GO_BASE_URL",
      },
    ];
    // Cursor's CLI exchanges its configured key for tokens before anything else. The hub
    // answers that itself instead of forwarding: it hands the machine back its own pool
    // token, so the real subscription credential never leaves this host, and every later
    // request arrives bearing a token the hub can recognise and swap for a minted one.
    bb.http.route(
      "POST",
      `/${CURSOR_MOUNT_PREFIX}${CURSOR_EXCHANGE_PATH}`,
      async (context) => {
        const hostId = await hub.authenticate(context.req.raw);
        if (hostId === null) {
          return Response.json(
            { error: { message: "Invalid Account Pooler bearer token.", code: 401 } },
            { status: 401 },
          );
        }
        const token = hub.requestToken(context.req.raw)!;
        return Response.json({ accessToken: token, refreshToken: token });
      },
      { auth: "none" },
    );
    for (const method of ["POST", "GET"] as const) {
      bb.http.route(method, "/cursor/rpc", (context) => {
        if (!isCursorRpcPath(context.req.raw.headers.get(CURSOR_RPC_PATH_HEADER) ?? "")) {
          return Response.json({ error: "Invalid Cursor RPC path." }, { status: 400 });
        }
        return hub.handle(context.req.raw, "cursor");
      }, { auth: "none" });
    }
    for (const path of CURSOR_PROXIED_PATHS) {
      if (path === CURSOR_EXCHANGE_PATH) continue;
      for (const method of ["POST", "GET"] as const) {
        bb.http.route(
          method,
          `/${CURSOR_MOUNT_PREFIX}${path}`,
          (context) => hub.handle(context.req.raw, "cursor"),
          { auth: "none" },
        );
      }
    }
    for (const rpcPath of DEVIN_PROXIED_PATHS) {
      bb.http.route(
        "POST",
        `/${DEVIN_MOUNT_PREFIX}${rpcPath}`,
        async (context) =>
          (await operations.isRoutingEnabled("devin"))
            ? hub.handle(context.req.raw, "devin")
            : Response.json({ error: { message: "Devin pool routing is disabled.", code: 503 } }, { status: 503 }),
        { auth: "none" },
      );
    }
    for (const cursorProviderId of ["acp-oxi-cursor"]) {
      bb.providers.experimental_contributeEnv(cursorProviderId, async (context) => {
      if (
        !(await operations.isRoutingEnabled("cursor")) ||
        (await isThreadBypassed(context)) ||
        !(await operations.hasUsableEnabledAccount("cursor"))
      ) {
        return [];
      }
      const token = await scopedHubToken(context);
      return [
        {
          name: "CURSOR_API_ENDPOINT",
          value: {
            serverPath: `${hubBasePath(bb.pluginId)}/${CURSOR_MOUNT_PREFIX}`.replace(
              /\/$/u,
              "",
            ),
          },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CURSOR_API_KEY",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
        {
          name: "CURSOR_POOL_RPC_GATEWAY",
          value: "1",
          reason: "Use the generic Cursor RPC gateway",
        },
        {
          // Without this the CLI prefers a credential it already stored on the machine —
          // on a developer's own Mac that is a real Cursor login, which the hub cannot
          // authenticate, and the session dies at "Failed to initialize session services".
          // A pooled session must neither read nor write the machine's credential store.
          name: "AGENT_CLI_CREDENTIAL_STORE",
          value: "memory",
          reason: "Pooled session must ignore any credential stored on the machine",
        },
      ];
    });
      bb.providers.experimental_contributeEnvHealth(cursorProviderId, () =>
        proxiedHealth("cursor"),
      );
    }
    for (const entry of openAiCompatibleRoutes) {
      for (const route of (entry.provider === "neuraldeep" ? ["chat/completions", "models"] : ["chat/completions", "responses", "models"])) {
        bb.http.route(
          entry.provider === "neuraldeep" && route === "models" ? "GET" : "POST",
          `/${entry.mountPrefix}v1/${route}`,
          (context) => hub.handle(context.req.raw, entry.provider),
          { auth: "none" },
        );
      }
      bb.providers.experimental_contributeEnv(
        entry.providerId,
        async (context) => {
          if (
            !(await operations.isRoutingEnabled(entry.provider)) ||
            (await isThreadBypassed(context)) ||
            !(await operations.hasUsableEnabledAccount(entry.provider))
          ) {
            return [];
          }
          const token = await scopedHubToken(context);
          return [
            {
              name: entry.baseUrlEnv,
              value: {
                serverPath: `${hubBasePath(bb.pluginId)}/${entry.mountPrefix}v1`,
              },
              reason: "Routed through the Account Pooler hub",
            },
            {
              name: entry.keyEnv,
              value: token,
              reason: "Account Pooler hub token for this machine",
            },
          ];
        },
      );
      bb.providers.experimental_contributeEnvHealth(entry.providerId, () =>
        proxiedHealth(entry.provider),
      );
    }
    for (const providerId of [
      "acp-opencode-kimi",
      "acp-opencode-kimi-highspeed",
    ]) {
      bb.providers.experimental_contributeEnv(providerId, async (context) => {
        if (
          !(await operations.isRoutingEnabled("kimi")) ||
          (await isThreadBypassed(context)) ||
          !(await operations.hasUsableEnabledAccount("kimi"))
        ) {
          return [];
        }
        const token = await scopedHubToken(context);
        return [
          {
            name: "OXI_KIMI_BASE_URL",
            value: {
              serverPath: `${hubBasePath(bb.pluginId)}/${KIMI_MOUNT_PREFIX}v1`,
            },
            reason: "Routed through the Account Pooler hub",
          },
          {
            name: "KIMI_API_KEY",
            value: token,
            reason: "Account Pooler hub token for this machine",
          },
        ];
      });
      bb.providers.experimental_contributeEnvHealth(providerId, () =>
        proxiedHealth("kimi"),
      );
    }
    bb.onDispose(async () => {
      agyLogin.dispose();
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Account Pooler disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    bb.http.route("GET", "/budget/codex", async context => hub.codexBudget(
      context.req.raw, await routing.isProviderEnabled("codex"), threadId => routing.isBypassed(threadId),
    ), { auth: "none" });
    bb.http.route(
      "POST",
      "/v1/messages",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/messages/count_tokens",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    for (const route of [
      "/v1/responses",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/alpha/search",
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "codex"),
        { auth: "none" },
      );
    }
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    for (const route of [
      `/${KIMI_MOUNT_PREFIX}v1/messages`,
      `/${KIMI_MOUNT_PREFIX}v1/messages/count_tokens`,
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "kimi"),
        { auth: "none" },
      );
    }
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: (signal) => hub.start(signal),
    });
  };
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb pool status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
