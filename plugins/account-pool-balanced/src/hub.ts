import {AccountStartPacing} from "./account-start-pacing.js";
import { AccountAdmission, AdmissionUnavailable, ACCOUNT_QUEUE_MAX_WAIT_MS } from "./account-admission.js";
import {createAgyAdapter} from "./agy-adapter.js";
import { observeCodexQuotaHeaders } from './codex-quota-observation.js';
import { zaiBudgetQuota, ZAI_BUDGET_MAX_AGE_MS } from './zai-budget.js';
import { RequestJournal, newTrace, type Trace, type Observation } from "./request-journal.js";
import { codexBudgetQuota, CODEX_BUDGET_MAX_AGE_MS } from './codex-budget.js';
import { NetworkFlights } from "./network-flights.js";
import { observeUpstreamFetch } from "./transport-diagnostics.js";
import { AccountAuthorizationRequiredError } from "./provider-adapter.js";
import { createVpnPolicy, VpnRequiredError } from "./vpn-policy.js";
import { isRecoverableAccessError } from "./recoverable-access.js";
import { projectTier, projectRole } from "./project-policy.js";
import { policyThresholds, reserveHours, scheduleAllows } from "./account-policy.js";
import type {
  Account,
  AccountPoolConfig,
  AccountQuota,
  AccountSecret,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./contracts.js";
import { providerSchema } from "./contracts.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./codex-adapter.js";
import { createCursorAdapter } from "./cursor-adapter.js";
import { createDevinAdapter } from "./devin-adapter.js";
import { createKimiAdapter } from "./kimi-adapter.js";
import {
  createOpenAiCompatibleAdapter,
  guardOpencodeGoRequestBody,
  normalizeOpencodeGoUpstreamPathSuffix,
  isChatCompletionsBody,
  OPENCODE_GO_MOUNT_PREFIX,
  ZAI_MOUNT_PREFIX,
} from "./openai-compatible-adapter.js";
import {
  opencodeGoQuotaFromUsages,
  zaiQuotaFromUsages,
} from "./openai-compatible-usage.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ImportedProviderAccount } from "./provider-adapter.js";
import { TransientOAuthRefreshError } from "./provider-adapter.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import {
  capLimit,
  drainOpensAt,
  gateMembership,
  rankByBalance,
  weeklyUtilization,
} from "./balancer.js";
import {
  accountStatus,
  blockingResetAt,
  governingWeeklyResetAt,
  isQuotaExhausted,
  isSharedQuotaExhausted,
  retryAfterMilliseconds,
} from "./quota.js";
import type {
  AccountBinding,
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
} from "./store.js";

const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const DEFAULT_ZAI_USAGES_URL =
  "https://api.z.ai/api/monitor/usage/quota/limit";
const DEFAULT_OPENCODE_GO_USAGES_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_CURSOR_EXCHANGE_URL =
  "https://api2.cursor.sh/auth/exchange_user_api_key";
const DEFAULT_CURSOR_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
// Strict ZAI proof expires after five minutes; collect with headroom for latency
// and manual refreshes between scheduler passes. Other provider due times stay intact.
const USAGE_SCHEDULER_TICK_MS = 60 * 1_000;
const ZAI_USAGE_REFRESH_INTERVAL_MS = 2 * 60 * 1_000;
const MAX_INLINE_HOLD_MS = 20_000;
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFFS = 1_024;
const MAX_FAILURE_DETAIL_BYTES = 1_024;
const FAILURE_DISPOSAL_TIMEOUT_MS = 250;
const AFFINITY_IDLE_TTL_MS = 30 * 60 * 1_000;
const MAX_AFFINITY_BINDINGS = 4_096;
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface HubOptions {
  journal?: RequestJournal;
  route: string;
  agyModels?:(ids:string[])=>Promise<void>;
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  maxAffinityBindings: number;
  hubTokens: Pick<HubTokenStore, "authenticate" | "list"> & Partial<Pick<HubTokenStore, "projectForToken" | "authenticateContext" | "inspectContext">>;
  getSettings: () => AccountPoolConfig;
  vpnPayload?: (nowMs:number) => Promise<unknown>;
  guardCheck?: (provider:PoolProvider)=>Promise<void|'direct'>;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  fetchIpv4?:typeof fetch;
  now: () => number;
  drainTimeoutMs: number;
  onAccountsChanged: () => void;
  onUpstreamError: (provider: PoolProvider, error: unknown, context: { elapsedMs: number; transport: "ipv4" | "default"; stage: "fetch_headers"; operation: "model" | "auxiliary" }) => void;
}

interface SelectedAccount {
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  accept: () => void;
}

interface ActiveAccount {
  accountId: string;
}

interface PacingFlight {
  heldUntil: number;
  result: Promise<void>;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
}
interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: (outcome?: "complete"|"error"|"canceled") => void;
}

interface RefreshBackoff {
  kind: "proactive" | "rejected";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

type SecretUse = { kind: "normal" } | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}

class ClientPolicyDenied extends Error {}

export class AccountPoolHub {
  private accepting = false;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly refreshes = new Map<string, SecretFlight>();
  // Internal binding only: rejected tokens must never become error properties
  // that RPC serializers or diagnostics could expose.
  private readonly authorizationFailures = new WeakMap<AccountAuthorizationRequiredError, AccountSecret>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private readonly pacingByAccount = new Map<string, PacingFlight>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<string, ActiveAccount>();
  private stopping: Promise<void> | null = null;
  private readonly usageRefreshes = new Map<string, Promise<void>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();

  private readonly vpn;
  private readonly networkFlights:NetworkFlights;
  private readonly admission: AccountAdmission;
  private readonly claudeStarts: AccountStartPacing;
  constructor(private readonly options: HubOptions) {
    this.claudeStarts = new AccountStartPacing(() => options.getSettings().claudeRequestStartIntervalMs, options.now);
    this.admission = new AccountAdmission(() => options.getSettings().maxConcurrentRequestsPerAccount, options.now);
    this.vpn = createVpnPolicy(options.getSettings, options.now, options.vpnPayload,options.guardCheck);
    this.networkFlights = new NetworkFlights(options.fetch, () => this.stopped.signal,
      provider => this.assertNetworkAllowed(provider), (provider, drainable) => {
        const ipv4 = this.requiresIpv4(provider);
        return observeUpstreamFetch(ipv4 ? options.fetchIpv4! : options.fetch,
          (error, elapsedMs) => options.onUpstreamError(provider, error, {
            elapsedMs, transport: ipv4 ? "ipv4" : "default", stage: "fetch_headers",
            operation: drainable ? "model" : "auxiliary",
          }));
      });
  }

  private requiresIpv4(provider:PoolProvider):boolean {const settings=this.options.getSettings();return settings.vpnOnlyProviders.some(value=>value===provider)||(settings.vpnGuardEnabled&&provider!=="kimi"&&provider!=="zai");}
  async assertNetworkAllowed(provider: PoolProvider): Promise<void> { await this.vpn.assert(provider);if(this.requiresIpv4(provider)&&!this.options.fetchIpv4)throw new VpnRequiredError(provider); }

  outboundFetch(provider: PoolProvider): typeof fetch {
    return (input,init)=>this.networkFlights.fetch(provider,input,init);
  }

  admissionLimitsChanged(): void { this.admission.limitsChanged(); }
  async enforceNetworkPolicy():Promise<void>{await this.networkFlights.enforce();}

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - AFFINITY_IDLE_TTL_MS,
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = new Map([...this.options.affinity.loadActiveAccounts(), ...this.options.affinity.loadProjectActiveAccounts()]);
    this.pacingByAccount.clear();
    this.claudeStarts.clear();
    this.stopped = new AbortController();
    this.accepting = true;
    this.stopping = null;
    const stop = () => { void this.stop(); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) stop();
      while (!signal.aborted) {
        await this.refreshUsage();
        await waitForDelay(USAGE_SCHEDULER_TICK_MS, signal);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      await this.stop();
    }
  }

  async authenticate(
    request: Request,
    adapter?: ProviderAdapter,
  ): Promise<string | null> {
    return this.options.hubTokens.authenticate(this.requestToken(request, adapter));
  }

  requestToken(request: Request, adapter?: ProviderAdapter): string | null {
    return request.headers.get("x-bb-account-pool-token") ??
      readBearer(request.headers.get("authorization")) ?? adapter?.inboundToken?.(request.headers) ?? null;
  }

  async importAccount(
    provider: PoolProvider,
  ): Promise<ImportedProviderAccount> {
    return this.adapter(provider).importAccount();
  }

  observations() { return this.options.journal?.snapshot(100) ?? { unavailable:true }; }
  trafficHistory(offset = 0, limit = 100) { return this.options.journal?.historySnapshot(offset,limit) ?? { unavailable:true as const }; }
  private observe(trace: Trace, fields: Partial<Observation>): void {
    try {
      this.options.journal?.record({ ...trace, at:this.options.now(), attempt:0, event:'request', accountId:null,
        status:null,durationMs:null,inFlight:this.inFlightCount(),accountInFlight:fields.accountId?(this.inFlightByAccount.get(fields.accountId)??0):0,retryAfterMs:null,retryAfterSupplied:null,
        quotaEvidence:null,holdSource:null,heldUntil:null,outcome:null,failover:null,errorClass:null,...fields });
    } catch { /* Observability must not alter requests or streams. */ }
  }
  async handle(request: Request, provider: PoolProvider): Promise<Response> {
    const adapter = this.adapter(provider);
    const token = this.requestToken(request, adapter);
    const context = this.options.hubTokens.authenticateContext
      ? await this.options.hubTokens.authenticateContext(token)
      : { hostId: await this.authenticate(request, adapter), projectId: await this.options.hubTokens.projectForToken?.(token) ?? null };
    if (context === null || context.hostId === null) {
      return this.errorResponse(adapter, request, 401, "Invalid Account Pooler bearer token.");
    }
    if (!this.accepting)
      return this.errorResponse(adapter, request,
        503,
        "Account Pooler is not accepting requests.",
        {"x-bb-pool-error":"POOL_SHUTTING_DOWN"},
      );
    try { await this.assertNetworkAllowed(provider); }
    catch (error) {
      if (error instanceof VpnRequiredError) return this.errorResponse(adapter, request, 503, error.message, { 'x-bb-pool-error': error.code, 'retry-after': '10' });
      throw error;
    }
    const body = new Uint8Array(await request.arrayBuffer());
    const refusal = adapter.guardRequest?.(request, body);
    if (refusal !== null && refusal !== undefined) return refusal;
    return this.forward(request, body, adapter, context.hostId, context.projectId, "threadId" in context ? context.threadId ?? null : null, "purpose" in context ? context.purpose : undefined);
  }

  threadObservation(provider:PoolProvider,hostId:string,threadId:string,projectId:string|null):AccountBinding|null {
    return this.options.affinity.observation(JSON.stringify(['thread',provider,hostId,projectId,threadId]));
  }

  sessionObservation(provider: PoolProvider, hostId: string, sessionId: string, projectId: string | null = null): AccountBinding | null {
    return this.options.affinity.observation(JSON.stringify([provider, projectId === null ? hostId : JSON.stringify([hostId, projectId]), `session:${sessionId}`]));
  }

  async refreshUsage(accountId?: string, force = false, reportErrors = false): Promise<void> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        (account.enabled || (force && accountId !== undefined)) &&
        (account.kind === "oauth" ||
          this.adapter(account.provider).refreshesApiKeyUsage === true) &&
        (accountId === undefined || account.id === accountId),
    );
    await Promise.all(
      accounts.map((account) => this.refreshAccountUsage(account, force).catch((error: unknown) => { if (reportErrors) throw error; })),
    );
  }

  async replaceAccountAuthorization<T>(
    accountId: string,
    write: () => Promise<T>,
  ): Promise<T> {
    // Finish quota checks using the old authorization before replacing it, so
    // their late refusal cannot mark the newly authorized account as broken.
    await this.usageRefreshes.get(accountId)?.catch(() => undefined);
    const previous = this.refreshes.get(accountId);
    let result: T;
    let failure: unknown;
    let failed = false;
    const flight: Extract<SecretFlight, { kind: "refresh" }> = {
      kind: "refresh",
      use: { kind: "normal" },
      result: Promise.resolve().then(async () => {
        if (previous) await previous.result.catch(() => undefined);
        try {
          result = await write();
        } catch (error) {
          failed = true;
          failure = error;
        }
        return this.options.accounts.readSecret(accountId).catch(error => {
          if (failed) throw failure;
          throw error;
        });
      }),
    };
    this.refreshes.set(accountId, flight);
    try {
      await flight.result;
      if (failed) throw failure;
      return result!;
    } finally {
      if (this.refreshes.get(accountId) === flight)
        this.refreshes.delete(accountId);
    }
  }

  private async refreshAccountUsage(
    account: Account,
    force: boolean,
  ): Promise<void> {
    await this.assertNetworkAllowed(account.provider);
    const adapter = this.adapter(account.provider);
    if (!adapter.refreshesUsageWhileBusy && (this.inFlightByAccount.get(account.id) ?? 0) > 0) {
      if (force) throw new Error("Аккаунт занят запросом. Повторите обновление квот после его завершения.");
      return;
    }
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);
    if (
      !force &&
      last !== undefined &&
      now - last < (account.provider === "zai" ? ZAI_USAGE_REFRESH_INTERVAL_MS : DEFAULT_USAGE_REFRESH_INTERVAL_MS)
    )
      return;
    const running = this.usageRefreshes.get(account.id);
    if (running !== undefined) return running;
    this.lastUsageRefreshAt.set(account.id, now);
    let usageSecret: AccountSecret | undefined;
    const refresh = adapter
      .refreshUsage({
        account,
        freshSecret: async (rejectedAccessToken) => {
          const secret = await this.freshSecret(account, adapter, rejectedAccessToken === undefined
            ? { kind: "normal" }
            : { kind: "rejected", accessToken: rejectedAccessToken });
          usageSecret = secret;
          return secret;
        },
        accounts: this.options.accounts,
        quotas: this.options.quotas,
        fetch: (input, init) => this.outboundFetch(account.provider)(input, { ...init, signal: AbortSignal.any([this.stopped.signal, ...(init?.signal ? [init.signal] : [])]) }),
        now: this.options.now,
      })
      .then(async () => { await this.settleDrain(account); })
      .catch(async error => {
        if (error instanceof AccountAuthorizationRequiredError) {
          const rejected = this.authorizationFailures.get(error) ?? usageSecret;
          const marked = rejected === undefined ? false : await this.markAuthError(account, rejected, error.accountMessage, this.stopped.signal);
          if (!marked) throw new TransientOAuthRefreshError("Авторизация изменилась во время проверки квот. Повторите проверку / Authorization changed while checking quotas; retry.", 0);
          this.options.onAccountsChanged();
          throw new Error(error.accountMessage);
        }
        throw error;
      })
      .finally(() => this.usageRefreshes.delete(account.id));
    this.usageRefreshes.set(account.id, refresh);
    return refresh;
  }

  stop(): Promise<void> {
    this.stopping ??= this.drainAndStop();
    return this.stopping;
  }

  private async drainAndStop(): Promise<void> {
    this.accepting = false;
    this.stopped.abort(new Error("Account Pooler stopped accepting requests."));
    if (this.inFlightCount() === 0) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.drainTimeoutMs);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    if (this.inFlightCount() === 0) return;
    for (const controller of this.activeControllers) {
      controller.abort(
        new Error(
          "Account Pooler stopped before the upstream response completed.",
        ),
      );
    }
  }

  private async settleDrain(account: Account, rejected = false): Promise<Account> {
    if (!account.drainOnce) return account;
    const quota = this.options.quotas.get(account.id);
    const exhausted = rejected || (["fable", "sonnet", "opus", "haiku", "other"] as const)
      .some((family) => isQuotaExhausted(quota, family, 1, this.options.now()));
    if (!exhausted) return account;
    const updated = await this.options.accounts.finishDrain(account);
    this.options.onAccountsChanged();
    return updated ?? account;
  }

  private async routingAccounts(): Promise<Account[]> {
    return Promise.all((await this.options.accounts.list()).map((account) => this.settleDrain(account)));
  }

  async status(): Promise<Omit<PoolStatus, "routing">> {
    const settings = this.options.getSettings();
    const now = this.options.now();
    const vpnEvidence=await this.vpn.evidence();
    const vpnState=vpnEvidence.state;
    const providers = [...new Set<PoolProvider>(["codex","claude","cursor","devin","opencode-go",...providerSchema.options])];
    const decisions=await Promise.all(providers.map(async provider=>{
      try {await this.assertNetworkAllowed(provider);return null;} catch {return provider;}
    }));
    const blockedProviders=decisions.filter((provider):provider is Exclude<typeof provider,null>=>provider!==null);
    const accounts = (await this.routingAccounts()).sort(
      (left, right) => left.priority - right.priority,
    );
    const workWeek = {
      restDays: settings.restDays,
      offsetMinutes: -new Date(now).getTimezoneOffset(),
    };
    const drainMs = settings.reserveDrainHours * 60 * 60 * 1_000;
    const eligibleIds = new Set<string>();
    for (const provider of providerSchema.options) {
      const entries = accounts
        .filter(
          (account) => account.provider === provider && account.enabled && (account.drainOnce || scheduleAllows(account.policy, now)),
        )
        .map((account) => ({
          account,
          quota: this.options.quotas.get(account.id),
        }))
        .filter(({ quota }) => quota.error === null)
        .filter(
          ({ account, quota }) =>
            !isSharedQuotaExhausted(quota, policyThresholds(account, settings.switchThreshold), now),
        );
      for (const entry of gateMembership(entries, now, drainMs, workWeek))
        eligibleIds.add(entry.account.id);
    }
    const activeFor = (provider: PoolProvider) => this.activeAccounts.get(provider)?.accountId ??
      [...this.activeAccounts].filter(([key]) => key.startsWith(`${provider}:`)).at(-1)?.[1].accountId ?? null;
    return {
      route: this.options.route,
      vpn: { state: vpnState, blockedProviders,guardEnabled:settings.vpnGuardEnabled,assurance:vpnEvidence.assurance,reason:vpnEvidence.reason },
      enabledAccountCount: accounts.filter((account) => account.enabled).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts: await this.options.hubTokens.list(),
      activeAccounts: {
        claude: activeFor("claude"),
        codex: activeFor("codex"),
        kimi: activeFor("kimi"),
        zai: activeFor("zai"),
        "opencode-go":
          activeFor("opencode-go"),
        neuraldeep: activeFor("neuraldeep"),
        agy: activeFor("agy"),
        cursor: activeFor("cursor"),
        devin: activeFor("devin"),
      },
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        const { accountId: _accountId, ...quotaFields } = quota;
        const limit = capLimit(account, quota, now, workWeek);
        return {
          ...account,
          lastUsedHostName: null,
          ...quotaFields,
          successfulRequests: this.options.quotas.successfulRequests(account.id),
          resetCredits: account.provider === "codex" || account.provider === "claude" ? this.options.quotas.resetCredits(account.id) : null,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          queuedRequests: this.admission.waiting(account.id) + Math.max(0, this.admission.reserved(account.id) - (this.inFlightByAccount.get(account.id) ?? 0)),
          concurrencyLimit: settings.maxConcurrentRequestsPerAccount,
          capLimit: limit,
          eligible: eligibleIds.has(account.id),
          drainOpensAt: drainOpensAt(quota, now, reserveHours(account, settings.reserveDrainHours) * 3600000, workWeek),
          capReached:
            limit !== null && (weeklyUtilization(quota, now) ?? 0) >= limit,
          status: accountStatus(account, quota, policyThresholds(account, settings.switchThreshold), now),
        };
      }),
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    hostId: string,
    projectId: string | null,
    threadId: string | null = null,
    purpose?: "autopilot",
  ): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    const attempted = new Set<string>();
    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
    };
    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === adapter.provider,
    );
    const candidateIds = new Set(accounts.map((account) => account.id));
    const legacyAffinityHost = projectId === null ? hostId : JSON.stringify([hostId, projectId]);
    const affinityHost = purpose ? JSON.stringify([legacyAffinityHost, "purpose", purpose]) : legacyAffinityHost;
    const parsed = adapter.parseRequest(body, request.headers, request);
    const family = parsed.family;
    const trace = newTrace(adapter.provider, hostId, projectId, threadId, parsed.model, family, request.headers.get("user-agent"));
    const startedAt = this.options.now();
    let attempt = 0;
    let lastAccount: string|null = null;
    const distinctAccounts = new Set<string>();
    const result = (response:Response) => {
      this.observe(trace,{event:'result',attempt,accountId:lastAccount,status:response.status,durationMs:Math.max(0,this.options.now()-startedAt),
        outcome:distinctAccounts.size>1?'failed-over':'returned',failover:distinctAccounts.size>1?(response.ok?'succeeded':'failed'):'none'});
      return response;
    };
    this.observe(trace,{event:'request'});
    const affinityKey =
      parsed.affinityId === null
        ? null
        : JSON.stringify([adapter.provider, affinityHost, parsed.affinityId]);
    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify([adapter.provider, affinityHost, parsed.parentAffinityId]);
    try {
      while (attempted.size < candidateIds.size) {
        signal.throwIfAborted();
        const selected = await this.select(
          adapter.provider,
          candidateIds,
          attempted,
          family,
          affinityKey,
          parentAffinityKey,
          previousAccountId,
          routing,
          projectId,
          signal,
          purpose,
        );
        if (selected === null) break;
        lastAccount=selected.account.id;
        let pacing: PacingFlight | null = null;
        previousAccountId = selected.account.id;
        attempted.add(selected.account.id);
        const changed = await this.options.accounts.recordUsed(
          selected.account.id,
          this.options.now(),
          hostId,
        );
        if (changed) this.options.onAccountsChanged();
        let secret: AccountSecret;
        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          if (error instanceof VpnRequiredError) throw error;
          if (pacing !== null) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          signal.throwIfAborted();
          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else if (error instanceof AccountAuthorizationRequiredError) {
            const rejected = this.authorizationFailures.get(error);
            if (rejected !== undefined)
              await this.markAuthError(selected.account, rejected, error.accountMessage, signal);
          } else {
            this.markError(selected.account.id, errorMessage(error));
          }
          continue;
        }
        let authRetried = false;
        let paced = false;
        while (true) {
          signal.throwIfAborted();
          if (purpose === "autopilot") {
            const current = this.eligibleEntries(adapter.provider, projectId,
              await this.options.accounts.list(), family, this.options.now(), purpose).eligible;
            if (!current.some(entry => entry.account.id === selected.account.id)) break;
          }
          let upstream: UpstreamResult;
          attempt++;
          distinctAccounts.add(selected.account.id);
          const attemptStartedAt=this.options.now();
          try {
            upstream = await this.fetchUpstream(
              request,
              parsed.forAccount(selected.account, secret),
              selected.account,
              secret,
              adapter,
              trace, attempt,
              {purpose,projectId,family,deadline:startedAt + ACCOUNT_QUEUE_MAX_WAIT_MS},
            );
          } catch (error) {
            if (pacing !== null) {
              this.releasePacing(selected.account.id, pacing);
              pacing = null;
            }
            signal.throwIfAborted();
            if (error instanceof ClientPolicyDenied) {
              failure = {status:403,message:"No enabled account is allowed for this client purpose.",headers:{"x-bb-pool-error":"POOL_ACCOUNT_POLICY"}};
              break;
            }
            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Account Pooler could not reach " + adapter.upstreamName + ".",
              headers: {},
            };
            break;
          }
          if (request.signal.aborted) {
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }
          const { response } = upstream;
          const previousQuota = this.options.quotas.get(selected.account.id);
          const quotaObservedAt = this.options.now();
          const observed = adapter.quotaFromHeaders(
            selected.account.id,
            response.headers,
            previousQuota,
            family,
            quotaObservedAt,
          );
          this.options.quotas.put(observed);
          this.observe(trace,{event:'upstream',attempt,accountId:selected.account.id,status:response.status,durationMs:Math.max(0,this.options.now()-attemptStartedAt),
            retryAfterMs:response.status===429?retryAfterMilliseconds(response.headers.get('retry-after'),this.options.now()):null,
            retryAfterSupplied:response.status===429?response.headers.has('retry-after'):null,
            quotaEvidence:response.status===429?adapter.isQuotaRejection(response.headers):null,errorClass:response.status===429?'upstream429':null,
            ...(adapter.provider === 'codex' ? {codexQuota:observeCodexQuotaHeaders(response.headers, previousQuota, observed, quotaObservedAt)} : {})});
          await this.settleDrain(selected.account, response.status === 429 && adapter.isQuotaRejection(response.headers));
          if (pacing !== null && !response.ok) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          if (response.status === 429) {
            if (adapter.isQuotaRejection(response.headers)) {
              await this.discardUpstream(upstream, false);
              break;
            }
            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );
            const heldUntil = this.options.now() + waitMs;
            this.observe(trace,{event:'hold',attempt,accountId:selected.account.id,status:429,holdSource:'upstream429',heldUntil,retryAfterMs:waitMs,retryAfterSupplied:response.headers.has('retry-after'),quotaEvidence:false});
            this.options.quotas.put({
              ...observed,
              heldUntil,
            });
            if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
              paced = true;
              pacing = {
                heldUntil,
                result: waitForDelay(waitMs, this.stopped.signal),
              };
              this.pacingByAccount.set(selected.account.id, pacing);
              await this.discardUpstream(upstream, false);
              await abortable(pacing.result, signal);
              continue;
            }
            if (!selected.keepAffinity) {
              failure = {
                status: 429,
                message: await this.discardUpstream(upstream, true),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              break;
            }
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            if (
              response.status === 401 &&
              secret.kind === "oauth" &&
              !authRetried
            ) {
              authRetried = true;
              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                if (error instanceof VpnRequiredError) throw error;
                signal.throwIfAborted();
                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  await this.markAuthError(
                    selected.account,
                    secret,
                    errorMessage(error),
                    signal,
                  );
                }
                break;
              }
              continue;
            }
            if (response.status === 403 && (/text\/html/iu.test(response.headers.get('content-type') ?? '') || isRecoverableAccessError(detail))) {
              const quota = this.options.quotas.get(selected.account.id);
              const heldUntil=Math.max(quota.heldUntil ?? 0, this.options.now() + 60_000);
              this.observe(trace,{event:'hold',attempt,accountId:selected.account.id,status:403,holdSource:'upstream403',errorClass:'upstream403-hold',heldUntil});
              this.options.quotas.put({ ...quota, error: null, heldUntil });
            } else if (response.status === 401 || response.status === 403) {
              await this.markAuthError(
                selected.account,
                secret,
                failure.message,
                signal,
              );
            }
            break;
          }
          if (response.ok) {
            if(threadId!==null)this.options.affinity.recordObservation(JSON.stringify(['thread',adapter.provider,hostId,projectId,threadId]),selected.account.id,this.options.now());
            selected.accept();
            this.options.quotas.recordSuccessfulRequest(selected.account.id);
          }
          return result(this.clientResponse(upstream));
        }
      }
      signal.throwIfAborted();
      return result(failure === null
        ? this.noEligibleResponse(accounts, family, adapter, projectId, request, purpose)
        : this.errorResponse(adapter, request,
            failure.status,
            failure.message,
            failure.headers,
          ));
    } catch (error) {
      if (error instanceof AdmissionUnavailable) {
        this.observe(trace,{event:'queue-wait',attempt,accountId:lastAccount,status:503,errorClass:error.code==='POOL_QUEUE_FULL'?'queue-full':'queue-timeout',durationMs:Math.max(0,this.options.now()-startedAt)});
        return result(this.errorResponse(adapter, request, 503, error.message, {"x-bb-pool-error":error.code,"retry-after":"1"}));
      }
      if (error instanceof VpnRequiredError) return result(this.errorResponse(adapter, request, 503, error.message, { "x-bb-pool-error": error.code, "retry-after": "10" }));
      if (!signal.aborted) {
        this.observe(trace,{event:'result',attempt,accountId:lastAccount,outcome:'error',errorClass:'request-error',durationMs:Math.max(0,this.options.now()-startedAt)});
        throw error;
      }
      return result(this.errorResponse(adapter, request,
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
        {"x-bb-pool-error":request.signal.aborted?"POOL_REQUEST_CANCELED":"POOL_SHUTTING_DOWN"},
      ));
    }
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();
    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();
      return "";
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });
    let detail = "";
    try {
      if (!readDetail) return detail;
      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes < MAX_FAILURE_DETAIL_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const part = chunk.value.subarray(
              0,
              MAX_FAILURE_DETAIL_BYTES - bytes,
            );
            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }
          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async markAuthError(
    account: Account,
    rejected: AccountSecret,
    message: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (rejected.kind !== "oauth") {
      this.markError(account.id, message);
      return true;
    }
    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }
      let marked = false;
      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account.id)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);
            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff?.kind === "rejected" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              this.markError(account.id, message);
              marked = true;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);
      return marked;
    }
  }

  private eligibleEntries(provider: PoolProvider, projectId: string | null, accounts: Account[], family: ModelFamily, now: number, purpose?: "autopilot") {
    const settings = this.options.getSettings();
    const threshold = settings.switchThreshold;
    const workWeek = { restDays: settings.restDays, offsetMinutes: -new Date(now).getTimezoneOffset() };
    const scopedEntries = (
      accounts
        .filter(account => purpose !== "autopilot" || account.autopilotAllowed)
        .filter(account => projectTier(account, projectId) !== null)
        .map(account => ({ ...account, role: projectRole(account, projectId) }))
        .filter((account) => account.provider === provider && account.enabled && (account.drainOnce || scheduleAllows(account.policy, now)))
        .map((account) => ({
          account,
          quota: this.options.quotas.get(account.id),
        }))
        .filter(({ quota }) => quota.error === null)
        .filter(({ account, quota }) => !isSharedQuotaExhausted(quota, policyThresholds(account, threshold), now))
    );
    const available = scopedEntries.flatMap(entry => gateMembership(
      [entry], now, settings.reserveDrainHours * 3600000, workWeek,
    ));
    const eligible = available.filter(
      ({ account, quota }) => !isQuotaExhausted(quota, family, policyThresholds(account, threshold), now),
    );
    return { available, eligible };
  }

  /** Read-only, project-bound evidence. No selection, quota refresh, credential read or model request. */
  async codexBudget(request: Request, routingEnabled: boolean, bypassed: (threadId: string) => Promise<boolean>): Promise<Response> {
    const token = this.requestToken(request);
    const context = await this.options.hubTokens.inspectContext?.(token);
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    if (!context) return reply({ error: 'Invalid pool token.' }, 401);
    if (!context.projectId) return reply({ error: 'A project-bound pool client is required.' }, 403);
    const expected = new URL(request.url).searchParams.get('projectId');
    if (expected !== null && expected !== context.projectId) return reply({ error: 'Pool project binding mismatch.' }, 403);
    const now = this.options.now();
    let networkAllowed = true;
    try { await this.assertNetworkAllowed('codex'); } catch { networkAllowed = false; }
    const threadBypassed = context.threadId ? await bypassed(context.threadId) : false;
    const routeReady = this.accepting && routingEnabled && networkAllowed && !threadBypassed;
    const accounts = (await this.options.accounts.list()).filter(a => a.provider === 'codex' && projectTier(a, context.projectId) !== null);
    const eligible = new Set(this.eligibleEntries('codex', context.projectId, accounts, 'other', now, context.purpose).eligible.map(({ account }) => account.id));
    return reply({
      schema: 'bb-account-pool/codex-budget/1', observedAt: now, maxAgeMs: CODEX_BUDGET_MAX_AGE_MS,
      projectId: context.projectId,
      ...(context.purpose ? {purpose:context.purpose} : {}),
      route: { provider: 'codex', path: '/v1/responses', accepting: this.accepting, routingEnabled, networkAllowed, threadBypassed, ready: routeReady },
      accounts: accounts.map(account => {
        const quota = this.options.quotas.get(account.id);
        const budget = codexBudgetQuota(quota, now);
        return { accountId: account.id, eligible: routeReady && eligible.has(account.id), ...budget, heldUntil: quota.heldUntil, budgetReady: budget.budgetReady && (quota.heldUntil === null || quota.heldUntil <= now) };
      }),
    });
  }

  /** Cached ZAI proof using the same project/purpose admission as inference. */
  async zaiBudget(request: Request, routingEnabled: boolean, bypassed: (threadId: string) => Promise<boolean>): Promise<Response> {
    const reply = (body: unknown, status = 200) => Response.json(body, {status,headers:{'cache-control':'no-store'}});
    try {
    const context = await this.options.hubTokens.inspectContext?.(this.requestToken(request));
    if (!context) return reply({error:'Invalid pool token.'},401);
    if (!context.projectId) return reply({error:'A project-bound pool client is required.'},403);
    const expected = new URL(request.url).searchParams.get('projectId');
    if (expected !== null && expected !== context.projectId) return reply({error:'Pool project binding mismatch.'},403);
    const now=this.options.now();
    let networkAllowed=true;
    try {await this.assertNetworkAllowed('zai');} catch {networkAllowed=false;}
    const threadBypassed=context.threadId?await bypassed(context.threadId):false;
    const routeReady=this.accepting && routingEnabled && networkAllowed && !threadBypassed;
    const accounts=(await this.options.accounts.list()).filter(a=>a.provider==='zai' && projectTier(a,context.projectId)!==null);
    const eligible=new Set(this.eligibleEntries('zai',context.projectId,accounts,'other',now,context.purpose).eligible.map(({account})=>account.id));
    return reply({schema:'bb-account-pool/zai-budget/1',observedAt:now,maxAgeMs:ZAI_BUDGET_MAX_AGE_MS,projectId:context.projectId,
      ...(context.purpose?{purpose:context.purpose}:{}),
      route:{provider:'zai',path:'/zai/v1/chat/completions',accepting:this.accepting,routingEnabled,networkAllowed,threadBypassed,ready:routeReady},
      accounts:accounts.map(account=>{
        const quota=this.options.quotas.get(account.id),budget=zaiBudgetQuota(quota,now);
        return {accountId:account.id,eligible:routeReady && eligible.has(account.id),heldUntil:quota.heldUntil,...budget,
          budgetReady:budget.budgetReady && (quota.heldUntil===null || quota.heldUntil<=now)};
      }),
    });
    } catch {return reply({error:'Pool budget evidence unavailable.'},503);}
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    projectId: string | null,
    signal: AbortSignal,
    purpose?: "autopilot",
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.routingAccounts()).sort(
      (left, right) => left.priority - right.priority,
    );
    signal.throwIfAborted();
    const now = this.options.now();
    const settings = this.options.getSettings();
    const threshold = settings.switchThreshold;
    const balanced = settings.routingStrategy === "balanced";
    const workWeek = {
      restDays: settings.restDays,
      offsetMinutes: -new Date(now).getTimezoneOffset(),
    };
    const { available, eligible } = this.eligibleEntries(provider, projectId, accounts, family, now, purpose);
    const unattempted = eligible.filter(
      ({ account }) =>
        candidateIds.has(account.id) && !attempted.has(account.id),
    );
    const ready = unattempted.filter(({ quota }) => quota.heldUntil === null || quota.heldUntil <= now);
    const candidates = ready.length ? ready : [...unattempted].sort((a,b) => (a.quota.heldUntil ?? 0) - (b.quota.heldUntil ?? 0)).slice(0,1);
    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);
    const boundAccountId =
      binding !== undefined && now - binding.lastUsedAt < AFFINITY_IDLE_TTL_MS
        ? binding.accountId
        : null;
    const bound =
      boundAccountId !== null
        ? eligible.find(({ account }) => account.id === boundAccountId)
        : undefined;
    let inherited: (typeof candidates)[number] | undefined;
    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);
      if (
        parent !== undefined &&
        now - parent.lastUsedAt < AFFINITY_IDLE_TTL_MS
      ) {
        inherited = unattempted.find(
          ({ account }) => account.id === parent.accountId,
        );
      }
    }
    const legacyActiveKey = projectId === null ? provider : `${provider}:${projectId}`;
    const activeKey = purpose ? JSON.stringify([legacyActiveKey, "purpose", purpose]) : legacyActiveKey;
    let active = this.activeAccounts.get(activeKey);
    const activeAccount = eligible.find(
      ({ account }) => account.id === active?.accountId,
    );
    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;
    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );
    const ordered = [
      ...accounts.slice(anchorIndex + 1),
      ...accounts.slice(0, anchorIndex + 1),
    ];
    const draining = candidates.filter(({ account }) => account.drainOnce);
    const tier = (entry: (typeof eligible)[number]) => {
      const base = projectTier(entry.account, projectId)!;
      if ((base === 2 || base === 4) && (drainOpensAt(entry.quota, now, reserveHours(entry.account, settings.reserveDrainHours) * 3600000, workWeek) ?? Infinity) <= now) return base - 1;
      return base;
    };
    const bestTier = Math.min(...candidates.map(tier));
    const preferredCandidates = candidates.filter(entry => tier(entry) === bestTier);
    const next = balanced
      ? rankByBalance(
          preferredCandidates,
          (accountId) => this.inFlightByAccount.get(accountId) ?? 0,
          now,
          workWeek,
        )[0]
      : ordered
          .map((account) =>
            preferredCandidates.find((candidate) => candidate.account.id === account.id),
          )
          .find((candidate) => candidate !== undefined);
    const selected =
      bound !== undefined && unattempted.includes(bound) && (candidates.length === 0 || tier(bound) <= bestTier)
        ? bound
        : ((inherited && (candidates.length === 0 || tier(inherited) <= bestTier) ? inherited : undefined) ??
          (draining.length === 0 && !balanced &&
          boundAccountId === null &&
          previousAccountId === null &&
          activeAccount !== undefined &&
          candidates.includes(activeAccount) && tier(activeAccount) <= bestTier
            ? activeAccount
            : next) ??
          null);
    if (selected === null) return null;
    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    if (affinityKey !== null && binding === undefined) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }
    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;
      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }
    while (this.affinityBindings.size > this.options.maxAffinityBindings) {
      const oldest = this.affinityBindings.keys().next();
      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }
    if (active === undefined) {
      active = { accountId: selected.account.id };
      this.activeAccounts.set(activeKey, active);
    }
    routing.binding ??= binding ?? null;
    routing.active ??= active;
    const familyDetour = (accountId: string | null) =>
      available.some(({ account }) => account.id === accountId) &&
      !eligible.some(({ account }) => account.id === accountId);
    const rebind =
      affinityKey !== null &&
      !familyDetour(boundAccountId) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        tier(selected) < tier(bound) ||
        (binding === routing.binding && attempted.has(bound.account.id)));
    const advance =
      !familyDetour(active.accountId) &&
      (activeAccount === undefined ||
        // Skipping a cooling unbound cursor has the same effect as its former
        // local-held detour; established session bindings still wait in place.
        (boundAccountId === null && (activeAccount.quota.heldUntil ?? 0) > now && active.accountId !== selected.account.id) ||
        active.accountId === selected.account.id ||
        (activeAccount !== undefined && tier(selected) < tier(activeAccount)) ||
        (active === routing.active && attempted.has(active.accountId)));
    return {
      ...selected,
      keepAffinity: selected.account.id === routing.pinnedAccountId,
      accept: () => {
        if (affinityKey !== null) this.options.affinity.recordObservation(affinityKey, selected.account.id, this.options.now());
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };
          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }
        if (advance && this.activeAccounts.get(activeKey) === active) {
          if (purpose === undefined) {
            if (projectId === null) this.options.affinity.putActiveAccount(provider, selected.account.id);
            else this.options.affinity.putProjectActiveAccount(provider, projectId, selected.account.id);
          }
          this.activeAccounts.set(activeKey, { accountId: selected.account.id });
        }
      },
    };
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
  ): Promise<AccountSecret> {
    while (true) {
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        if (existing.kind === "rejection-check") {
          await existing.result;
          continue;
        }
        let secret: AccountSecret;
        try {
          secret = await existing.result;
        } catch (error) {
          const current = this.refreshes.get(account.id);
          if (current !== undefined && current !== existing) continue;
          throw error;
        }
        const current = this.refreshes.get(account.id);
        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);
        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind === "rejected"
        )
          continue;
        if (
          use.kind === "normal" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }
        continue;
      }
      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account.id)
          .then(async (secret) => {
            let backoff = this.refreshBackoffs.get(account.id);
            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }
            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;
            const forceRefresh =
              explicitlyRejected || backoff?.kind === "rejected";
            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }
            const error = this.options.quotas.get(account.id).error;
            if (error !== null && !isRecoverableAccessError(error)) throw new Error(error);
            if (
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind === "rejected")
            ) {
              if (
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw backoff.error;
            }
            try {
              const result = await adapter.refreshSecret({
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: (input, init) => this.outboundFetch(account.provider)(input, { ...init, signal: AbortSignal.any([this.stopped.signal, ...(init?.signal ? [init.signal] : [])]) }),
                now: this.options.now,
                forceRefresh,
              });
              this.refreshBackoffs.delete(account.id);
              if (result.refreshed) {
                const quota = this.options.quotas.get(account.id);
                this.options.quotas.put({ ...quota, error: null });
              }
              return result.secret;
            } catch (error) {
              if (error instanceof AccountAuthorizationRequiredError)
                this.authorizationFailures.set(error, secret);
              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);
                throw error;
              }
              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );
              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });
              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();
                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }
              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      return flight.result;
    }
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
    trace: Trace, attempt: number,
    admission: {purpose?:"autopilot";projectId:string|null;family:ModelFamily;deadline:number},
  ): Promise<UpstreamResult> {
    const admissionSignal = AbortSignal.any([request.signal, this.stopped.signal]);
    const deadline = admission.deadline;
    const cooldown = () => {
      const hold = this.options.quotas.get(account.id).heldUntil;
      const spaced = account.provider === "claude" ? this.claudeStarts.readyAt(account.id) : null;
      return hold === null ? spaced : spaced === null ? hold : Math.max(hold, spaced);
    };
    const queuedAt = this.options.now();
    const waiting = this.admission.waiting(account.id)>0 || this.admission.reserved(account.id)>=this.options.getSettings().maxConcurrentRequestsPerAccount || (cooldown() ?? 0)>queuedAt;
    const slotRelease = await this.admission.acquire(account.id, admissionSignal, cooldown, deadline);
    if (waiting) this.observe(trace,{event:'queue-wait',attempt,accountId:account.id,durationMs:Math.max(0,this.options.now()-queuedAt)});
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.add(controller);
    this.increment(account.id);
    let released = false;
    const openedAt=this.options.now();
    let upstreamStatus:number|null=null;
    const release = (outcome: "complete"|"error"|"canceled" = "complete") => {
      if (released) return;
      released = true;
      request.signal.removeEventListener("abort", abortFromRequest);
      controller.signal.removeEventListener("abort", abortRelease);
      this.activeControllers.delete(controller);
      this.decrement(account.id);
      slotRelease();
      this.observe(trace,{event:'stream-end',attempt,accountId:account.id,status:upstreamStatus,durationMs:Math.max(0,this.options.now()-openedAt),outcome:controller.signal.aborted?'canceled':upstreamStatus===null?'error':outcome,errorClass:controller.signal.aborted?'canceled':(upstreamStatus===null||outcome==='error')?'stream-error':null});
    };
    // A queued downstream chunk can stop pull() indefinitely after disconnect.
    // Abort is terminal even when nobody reads or cancels the response body.
    const abortRelease=()=>release("canceled");
    controller.signal.addEventListener("abort", abortRelease, { once: true });
    if (request.signal.aborted) abortFromRequest();
    else request.signal.addEventListener("abort", abortFromRequest, { once: true });
    try {
      const upstreamBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(upstreamBody).set(body);
      const url = adapter.upstreamUrl(request, this.options.getSettings());
      const headers = adapter.requestHeaders(request.headers, account, secret);
      const method=adapter.upstreamMethod?.(request)??request.method;
      const response = await this.networkFlights.fetch(account.provider,url, {
          method,
          headers,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: upstreamBody }),
          signal: controller.signal,
        },true, async send => {
          while (true) {
            const waited = await this.admission.waitCooldown(AbortSignal.any([controller.signal, this.stopped.signal]), cooldown, deadline);
            if (waited) await this.assertNetworkAllowed(account.provider);
            const started = await this.options.accounts.withSnapshot(accounts => {
              const current = this.eligibleEntries(adapter.provider, admission.projectId,
                accounts, admission.family, this.options.now(), admission.purpose).eligible;
              if (!current.some(entry => entry.account.id === account.id)) throw new ClientPolicyDenied();
              // Metadata serialization can outlast admission: never start new work after its deadline.
              if (this.options.now() >= deadline) throw new AdmissionUnavailable("POOL_QUEUE_TIMEOUT");
              // Snapshot acquisition is asynchronous: another response may have set a hold.
              if ((cooldown() ?? 0) > this.options.now()) return null;
              this.stopped.signal.throwIfAborted();
              this.observe(trace,{event:'attempt',attempt,accountId:account.id});
              if (account.provider === 'claude') this.claudeStarts.dispatched(account.id);
              return {response: send()};
            });
            if (started.value !== null) return started.value.response;
          }
        })
        .catch((cause: unknown) => {
          if (cause instanceof VpnRequiredError || cause instanceof ClientPolicyDenied || cause instanceof AdmissionUnavailable) throw cause;
          throw new UpstreamConnectionError("Upstream connection failed.", {
            cause,
          });
        });
      upstreamStatus=response.status;
      let forwarded=response;
      if(response.ok&&adapter.transformResponse){
        try{forwarded=adapter.transformResponse(request,response,controller.signal);}
        catch{controller.abort();void response.body?.cancel().catch(()=>undefined);throw new UpstreamConnectionError('Invalid provider response');}
      }
      return { response:forwarded, controller, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private clientResponse(upstream: UpstreamResult): Response {
    const headers = new Headers();
    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }
    if (upstream.response.body === null) {
      upstream.release();
      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }
    const reader = upstream.response.body.getReader();
    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            upstream.release();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          upstream.release("error");
          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });
    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  private errorResponse(adapter: ProviderAdapter, request: Request, status: number, message: string, headers?: HeadersInit): Response {
    return adapter.errorResponse(status, message, headers, request);
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    adapter: ProviderAdapter,
    projectId: string | null,
    request: Request,
    purpose?: "autopilot",
  ): Response {
    accounts = accounts.filter(account => purpose !== "autopilot" || account.autopilotAllowed);
    if (purpose === "autopilot" && !accounts.some(account => account.enabled)) {
      return this.errorResponse(adapter, request, 403, "No enabled account is allowed for this client purpose.", {"x-bb-pool-error":"POOL_ACCOUNT_POLICY"});
    }
    const enabled = accounts.filter(account => account.enabled);
    accounts = accounts.filter(account => projectTier(account, projectId) !== null);
    if (enabled.length > 0 && !accounts.some(account => account.enabled)) {
      return this.errorResponse(adapter, request, 403, "Для проекта нет разрешённого аккаунта / No enabled account is allowed for this project context.", {"x-bb-pool-error":"POOL_PROJECT_RESTRICTED"});
    }
    if (!accounts.some((account) => account.enabled)) {
      return this.errorResponse(adapter, request,
        503,
        "Account Pooler has no enabled account",
        {"x-bb-pool-error":"POOL_NO_ACCOUNTS"},
      );
    }
    const now = this.options.now();
    if (!accounts.some(account => account.enabled && (account.drainOnce || scheduleAllows(account.policy, now)))) {
      return this.errorResponse(adapter, request, 403, "Аккаунты недоступны по расписанию / Every enabled account is outside its allowed schedule.", {"x-bb-pool-error":"POOL_SCHEDULE_RESTRICTED"});
    }
    accounts = accounts.filter(account => account.enabled && (account.drainOnce || scheduleAllows(account.policy, now)));
    if (accounts.every(account => this.options.quotas.get(account.id).error !== null)) {
      return this.errorResponse(adapter, request, 403,
        `${adapter.upstreamName}: аккаунты недоступны из-за сохранённых ошибок авторизации или подключения; проверьте карточки / Accounts have stored credential or connection errors.`,
        {"x-bb-pool-error":"POOL_ACCOUNT_UNAVAILABLE"});
    }
    const threshold = this.options.getSettings().switchThreshold;
    const next = accounts
      .filter((account) => account.enabled)
      .flatMap((account) => {
        const quota = this.options.quotas.get(account.id);
        if (quota.error !== null) return [];
        const effectiveThreshold = policyThresholds(account, threshold);
        const quotaResetAt = blockingResetAt(quota, family, effectiveThreshold, now);
        if (
          quotaResetAt === null &&
          isQuotaExhausted(quota, family, effectiveThreshold, now)
        )
          return [];
        const resetAt = Math.max(quota.heldUntil ?? 0, quotaResetAt ?? 0);
        return resetAt > now ? [resetAt] : [];
      })
      .sort((left, right) => left - right)[0];
    // A refusal, not a rate limit with a hint to wait: short pacing has already been sat
    // out by the selector, so anything reaching here needs a decision from the caller. A
    // 429 carrying `retry-after` was worse than useless — coding agents honour it in
    // silence, and an exhausted weekly quota looked like a hang with no error at all.
    const resetAt = next === undefined ? null : new Date(next).toISOString();
    const usable = accounts.filter(account => this.options.quotas.get(account.id).error === null);
    const quotaBlocked = usable.every(account => isQuotaExhausted(this.options.quotas.get(account.id), family, policyThresholds(account, threshold), now));
    const providerSpent = quotaBlocked && usable.every(account => isQuotaExhausted(this.options.quotas.get(account.id), family, 1, now));
    const upstreamHeld = !quotaBlocked && usable.length>0 && usable.every(account => (this.options.quotas.get(account.id).heldUntil??0)>now);
    const reason = providerSpent ? "POOL_QUOTA_EXHAUSTED" : quotaBlocked ? "POOL_QUOTA_THRESHOLD" : upstreamHeld ? "POOL_ACCOUNT_HELD" : "POOL_ACCOUNT_POLICY";
    let message = upstreamHeld
      ? `${adapter.upstreamName}: пул временно не использует аккаунты / Accounts temporarily held by Pooler.`
      : providerSpent
      ? `${adapter.upstreamName}: лимит провайдера исчерпан / Provider quota exhausted.`
      : quotaBlocked ? `${adapter.upstreamName}: достигнут порог квоты в настройках пула / Pool quota threshold reached.`
      : `${adapter.upstreamName}: нет доступных аккаунтов по настройкам пула / No eligible account under pool policy.`;
    if (quotaBlocked && !providerSpent) {
      const account = usable.find(account => !isQuotaExhausted(this.options.quotas.get(account.id), family, 1, now));
      if (account) {
        const q = this.options.quotas.get(account.id);
        const limits = policyThresholds(account, threshold);
        const windows = [
          {used:q.fiveHourUtilization,reset:q.fiveHourResetAt,limit:limits.fiveHour},
          {used:q.sevenDayUtilization,reset:q.sevenDayResetAt,limit:limits.weekly},
          {used:q.familyWeekly[family]?.utilization??null,reset:q.familyWeekly[family]?.resetAt??null,limit:limits.weekly},
          ...q.limitWindows.map(w=>({used:w.utilization,reset:w.resetAt,limit:w.windowMinutes===300?limits.fiveHour:w.windowMinutes===10080?limits.weekly:limits.other})),
        ];
        const window = windows.find(w=>w.used!==null&&w.used>=w.limit&&(w.reset===null||w.reset>now));
        if (window) message += ` Использовано / used ${Number((window.used!*100).toFixed(2))}%, порог / threshold ${Number((window.limit*100).toFixed(2))}%.`;
      }
    }
    if (resetAt!==null) message += upstreamHeld ? ` Повторная попытка не ранее / Retry no earlier than: ${resetAt}.` : ` Сброс / reset: ${resetAt}.`;
    return this.errorResponse(adapter, request, 403, message, {"x-bb-pool-error":reason});
  }

  private markError(accountId: string, message: string): void {
    const quota = this.options.quotas.get(accountId);
    this.options.quotas.put({ ...quota, error: message.slice(0, 1_000) });
  }

  private releasePacing(accountId: string, pacing: PacingFlight): void {
    if (this.pacingByAccount.get(accountId) === pacing)
      this.pacingByAccount.delete(accountId);
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);
    if (adapter === undefined)
      throw new Error(`Missing ${provider} Account Pooler adapter.`);
    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);
    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);
    if (this.inFlightCount() !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;
    for (const count of this.inFlightByAccount.values()) total += count;
    return total;
  }
}

export function createHub(options: {
  route: string;
  agyModels?:(ids:string[])=>Promise<void>;
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: Pick<HubTokenStore, "authenticate" | "list"> & Partial<Pick<HubTokenStore, "projectForToken" | "authenticateContext" | "inspectContext">>;
  getSettings: () => AccountPoolConfig;
  vpnPayload?: (nowMs:number) => Promise<unknown>;
  guardCheck?: (provider:PoolProvider)=>Promise<void|'direct'>;
  fetch?: typeof fetch;
  fetchIpv4?:typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  importClaudeCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  kimiUsagesUrl?: string;
  zaiUsagesUrl?: string;
  opencodeGoUsagesUrl?: string;
  cursorExchangeUrl?: string;
  cursorUsageUrl?: string;
  usageUrl?: string;
  profileUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  onAccountsChanged?: () => void;
  onUpstreamError?: HubOptions["onUpstreamError"];
  journal?: RequestJournal;
}): AccountPoolHub {
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    ["agy",createAgyAdapter(options.agyModels)],
    [
      "claude",
      createClaudeAdapter({
        refreshUrl: options.refreshUrl ?? DEFAULT_REFRESH_URL,
        usageUrl: options.usageUrl ?? DEFAULT_USAGE_URL,
        profileUrl: options.profileUrl ?? DEFAULT_PROFILE_URL,
        importCredentials: options.importClaudeCredentials,
      }),
    ],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
        importCredentials: options.importCodexCredentials,
      }),
    ],
    [
      "kimi",
      createKimiAdapter({
        usagesUrl: options.kimiUsagesUrl ?? DEFAULT_KIMI_USAGES_URL,
      }),
    ],
    [
      "zai",
      createOpenAiCompatibleAdapter({
        provider: "zai",
        upstreamName: "Z.ai Coding Plan",
        mountPrefix: ZAI_MOUNT_PREFIX,
        upstreamBaseUrl: (settings) => settings.zaiUpstreamBaseUrl,
        usagesUrl: options.zaiUsagesUrl ?? DEFAULT_ZAI_USAGES_URL,
        parseUsages: zaiQuotaFromUsages,
      }),
    ],
    [
      "opencode-go",
      createOpenAiCompatibleAdapter({
        provider: "opencode-go",
        upstreamName: "OpenCode Go",
        mountPrefix: OPENCODE_GO_MOUNT_PREFIX,
        upstreamBaseUrl: (settings) => settings.opencodeGoUpstreamBaseUrl,
        usagesUrl:
          options.opencodeGoUsagesUrl ?? DEFAULT_OPENCODE_GO_USAGES_URL,
        allowedHeaderPrefixes: ["x-opencode-"],
        normalizeUpstreamPathSuffix: normalizeOpencodeGoUpstreamPathSuffix,
        guardRequestBody: guardOpencodeGoRequestBody,
        parseUsages: opencodeGoQuotaFromUsages,
      }),
    ],
    [
      "neuraldeep",
      createOpenAiCompatibleAdapter({
        provider: "neuraldeep",
        upstreamName: "NeuralDeep",
        mountPrefix: "neuraldeep/",
        upstreamBaseUrl: (settings) => settings.neuraldeepUpstreamBaseUrl,
        usagesUrl: "https://api.neuraldeep.ru/v1/limits",
        // RPM and model entitlements are not subscription-window percentages.
        parseUsages: () => null,
        guardRequestBody: (suffix, body) => suffix === "chat/completions" && !isChatCompletionsBody(body)
          ? "NeuralDeep requires a Chat Completions messages array." : null,
      }),
    ],
    [
      "cursor",
      createCursorAdapter({
        exchangeUrl: options.cursorExchangeUrl ?? DEFAULT_CURSOR_EXCHANGE_URL,
        usageUrl: options.cursorUsageUrl ?? DEFAULT_CURSOR_USAGE_URL,
      }),
    ],
    ["devin", createDevinAdapter()],
  ]);
  return new AccountPoolHub({
    route: options.route,
    accounts: options.accounts,
    quotas: options.quotas,
    journal:options.journal,
    affinity: options.affinity,
    maxAffinityBindings: options.maxAffinityBindings ?? MAX_AFFINITY_BINDINGS,
    hubTokens: options.hubTokens,
    getSettings: options.getSettings,
    vpnPayload: options.vpnPayload,
    guardCheck: options.guardCheck,
    adapters,
    fetch: options.fetch ?? fetch,fetchIpv4:options.fetchIpv4,
    now: options.now ?? Date.now,
    drainTimeoutMs: options.drainTimeoutMs ?? 3_000,
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
    onUpstreamError: options.onUpstreamError ?? (() => {}),
  });
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof AccountAuthorizationRequiredError) return error.accountMessage;
  return error instanceof Error ? error.message : String(error);
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timeout.unref();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
