import {maintenanceStatusSchema, type PoolMaintenance} from './maintenance.js';
import {updateStatusSchema, type PoolUpdate} from './pool-update.js';
import { accountProxyInputSchema, egressProfileSchema, egressStateSchema, type AccountEgress } from "./account-egress.js";
import {nativeProjectsSchema, nativeAccountsSchema, type NativeAccounts} from "./native-accounts.js";
import type {AgyOAuthLogin} from "./agy-oauth-login.js";
import { defineRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  accountPolicySchema,
  accountProjectsSchema,
  accountAddInputSchema,
  accountCapInputSchema,
  accountDrainInputSchema,
  accountRoleInputSchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountSchema,
  accountSummarySchema,
  bypassInputSchema,
  codexLoginCancelSchema,
  codexLoginPollInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  hubTokenSummarySchema,
  loginCompleteInputSchema,
  loginStartSchema,
  providerSchema,
  providerReadinessSchema,
  routedThreadStatusListSchema,
  statusSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import type { PoolOperations } from "./operations.js";
import type { ClaudeOAuthLogin } from "./oauth-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";
import type { GrokDeviceLogin } from "./grok-device-login.js";

export const threadAccountStatusSchema = z.object({
  state: z.enum(["observed", "unobserved", "bypassed", "unsupported"]),
  account: accountSummarySchema.nullable(),
  lastUsedAt: z.number().nullable(),
});
export type ThreadAccountStatus = z.infer<typeof threadAccountStatusSchema>;

const browserOpenInputSchema = z.object({
  accountId: z.string().uuid(),
  url: z.string().max(8192).url().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Use an HTTPS link without embedded credentials").optional(),
}).strict();
export type BrowserOpenInput = z.infer<typeof browserOpenInputSchema>;

export const accountPoolRpcContract = defineRpcContract({
  "maintenance.status": {input:z.null(), output:maintenanceStatusSchema},
  "update.status": {input:z.null(), output:updateStatusSchema},
  "update.start": {input:z.null(), output:updateStatusSchema},
  "native.setProjects": {input:z.object({accountId:z.string().min(1).max(80),projects:nativeProjectsSchema,expectedRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),output:z.null()},
  "native.accounts": {input: z.null(), output: nativeAccountsSchema},
  "native.prefer": {input:z.object({executorId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),expectedRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),output:z.null()},
  "egress.proxy":{input:accountProxyInputSchema,output:z.null()},
  "egress.status":{input:z.null(),output:egressStateSchema},
  "egress.bind":{input:z.object({accountId:z.string().uuid(),ref:z.object({id:z.string(),version:z.number().int().positive()}).strict().nullable()}).strict(),output:z.null()},
  "egress.configure":{input:egressProfileSchema,output:z.null()},
  "readiness.get": {input: z.object({projectId:z.string().min(1).max(200).nullable()}).strict(), output:z.array(providerReadinessSchema).length(providerSchema.options.length)},
  "browser.open": { input: browserOpenInputSchema, output: z.object({ opened: z.literal(true) }).strict() },
  "thread.account": { input: z.object({ threadId: z.string().min(1) }).strict(), output: threadAccountStatusSchema },
  "account.add": {
    input: accountAddInputSchema,
    output: accountSchema,
  },
  "account.list": {
    input: z.null(),
    output: z.array(accountSummarySchema),
  },
  "account.remove": {
    input: accountIdInputSchema,
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "account.enable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.disable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "projects.list": { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string() }).strict()) },
  "account.setProjects": {
    input: z.object({ accountId: z.string().uuid(), projects: accountProjectsSchema, expectedProjects: accountProjectsSchema.nullable().optional() }).strict(),
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setAutopilotAllowed": {
    input: z.object({accountId:z.string().uuid(),allowed:z.boolean(),expectedAllowed:z.boolean()}).strict(),
    output: z.object({account:accountSchema.nullable()}).strict(),
  },
  "account.setPolicy": {
    input: z.object({ accountId: z.string().uuid(), policy: accountPolicySchema }).strict(),
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setEmail": {
    input:z.object({accountId:z.string().uuid(),email:z.string().trim().email().max(254).nullable(),expectedEmail:z.string().email().nullable().optional()}).strict(),
    output:z.object({account:accountSchema.nullable()}).strict(),
  },
  "account.setPriority": {
    input: accountPriorityInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setRole": {
    input: accountRoleInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setDrainOnce": {
    input: accountDrainInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setCap": {
    input: accountCapInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.reorder": {
    input: accountReorderInputSchema,
    output: z.null(),
  },
  "account.refreshUsage": {
    input: z.object({ accountId: z.string().uuid() }).strict(),
    output: z.object({ account: accountSummarySchema.nullable() }).strict(),
  },
  "routing.set": {
    input: routingSetInputSchema,
    output: z
      .object({ provider: providerSchema, enabled: z.boolean() })
      .strict(),
  },
  "config.get": {
    input: z.null(),
    output: accountPoolConfigSchema,
  },
  "config.set": {
    input: accountPoolConfigSetInputSchema,
    output: accountPoolConfigSchema,
  },
  "login.start": {
    input: z.null(),
    output: loginStartSchema,
  },
  "login.reauthorize": {
    input: z.object({accountId:z.string().uuid()}).strict(),
    output: loginStartSchema,
  },
  "login.complete": {
    input: loginCompleteInputSchema,
    output: accountSchema,
  },
  "agyLogin.openBrowser": {input:z.object({sessionId:z.string().min(1).max(128)}).strict(),output:z.object({opened:z.literal(true)}).strict()},
  "agyLogin.start": {input:z.null(),output:z.object({sessionId:z.string().min(1).max(128),authorizeUrl:z.string().url(),expiresAt:z.number().int().positive()}).strict()},
  "agyLogin.complete": {input:z.object({sessionId:z.string().min(1).max(128),pasted:z.string().trim().min(1).max(16384)}).strict(),output:accountSchema},
  "agyLogin.cancel": {input:z.object({sessionId:z.string().min(1).max(128)}).strict(),output:z.object({cancelled:z.literal(true)}).strict()},
  "codexLogin.start": {
    input: z.null(),
    output: codexLoginStartSchema,
  },
  "codexLogin.poll": {
    input: codexLoginPollInputSchema,
    output: codexLoginPollSchema,
  },
  "codexLogin.cancel": {
    input: codexLoginPollInputSchema,
    output: codexLoginCancelSchema,
  },
  "grokLogin.start": {
    input: z.null(),
    output: codexLoginStartSchema,
  },
  "grokLogin.poll": {
    input: codexLoginPollInputSchema,
    output: codexLoginPollSchema,
  },
  "grokLogin.cancel": {
    input: codexLoginPollInputSchema,
    output: codexLoginCancelSchema,
  },
  "status.get": {
    input: z.null(),
    output: statusSchema,
  },
  "status.routedThreads": {
    input: z.null(),
    output: routedThreadStatusListSchema,
  },
  "token.rotate": {
    input: tokenRotateInputSchema,
    output: hubTokenSummarySchema,
  },
  "bypass.set": {
    input: bypassInputSchema,
    output: bypassInputSchema,
  },
});

export function createRpcHandlers(
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
  threadAccount: (threadId: string) => Promise<ThreadAccountStatus> = async () => ({ state: "unobserved", account: null, lastUsedAt: null }),
  projectsList: () => Promise<Array<{ id: string; name: string }>> = async () => [],
  openBrowser: (input: BrowserOpenInput) => Promise<{ opened: true }> = async () => { throw new Error("Account browser unavailable"); },
  agyLogin?: AgyOAuthLogin,
  openAgyBrowser:(url:string)=>Promise<{opened:true}>=async()=>{throw Error("Sign-in browser unavailable");},
  egress?:AccountEgress,
  grokLogin?: GrokDeviceLogin,
  nativeAccounts: () => Promise<NativeAccounts> = async () => ({managed: false, accounts: []}),
  nativeSetProjects: (accountId:string,projects:import('./contracts.js').AccountProjects,revision:string)=>Promise<null> = async()=>{throw Error('Native project settings unavailable');},
  nativePrefer:(executorId:string,revision:string)=>Promise<null> = async()=>{throw Error('Native account selection unavailable');},
  maintenance?: Pick<PoolMaintenance,'status'>,
  update?: Pick<PoolUpdate,'status'|'start'>,
): PluginRpcHandlers<typeof accountPoolRpcContract> {
  return {
    "maintenance.status":()=>{if(!maintenance)throw Error('Maintenance unavailable');return maintenance.status();},
    "update.status":()=>update?.status()??null,
    "update.start":()=>{if(!update)throw Error('Updater unavailable');return update.start();},
    "native.accounts": () => nativeAccounts(),
    "native.prefer": ({executorId,expectedRevision}) => nativePrefer(executorId,expectedRevision),
    "native.setProjects": ({accountId,projects,expectedRevision}) => nativeSetProjects(accountId,projects,expectedRevision),
    "egress.proxy":async input=>{if(!egress)throw Error("Egress unavailable");await egress.configureProxy(input);return null;},
    "egress.status":()=>{if(!egress)throw Error("Egress unavailable");return egress.snapshot();},
    "egress.configure":async input=>{if(!egress)throw Error("Egress unavailable");await egress.configure(input);return null;},
    "egress.bind":async({accountId,ref})=>{if(!egress)throw Error("Egress unavailable");await egress.bind(accountId,ref);return null;},
    "readiness.get": ({projectId}) => operations.readiness(projectId),
    "browser.open": input => openBrowser(input),
    "projects.list": () => projectsList(),
    "account.setProjects": async ({ accountId, projects, expectedProjects }) => ({ account: await operations.setProjects(accountId, projects, expectedProjects) }),
    "thread.account": ({ threadId }) => threadAccount(threadId),
    "account.add": (input) => operations.add(input),
    "account.list": () => operations.list(),
    "account.remove": async ({ id }) => ({
      removed: await operations.remove(id),
    }),
    "account.enable": async ({ id }) => ({
      account: await operations.enable(id),
    }),
    "account.disable": async ({ id }) => ({
      account: await operations.disable(id),
    }),
    "account.setAutopilotAllowed": async ({accountId,allowed,expectedAllowed}) => ({account:await operations.setAutopilotAllowed(accountId,allowed,expectedAllowed)}),
    "account.setPolicy": async ({ accountId, policy }) => ({
      account: await operations.setPolicy(accountId, policy),
    }),
    "account.setEmail":async({accountId,email,expectedEmail})=>({account:await operations.setEmail(accountId,email,expectedEmail)}),
    "account.setPriority": async ({ accountId, priority }) => ({
      account: await operations.setPriority(accountId, priority),
    }),
    "account.setRole": async ({ accountId, role }) => ({
      account: await operations.setRole(accountId, role),
    }),
    "account.setDrainOnce": async ({ accountId, enabled }) => ({
      account: await operations.setDrainOnce(accountId, enabled),
    }),
    "account.setCap": async ({ accountId, cap }) => ({
      account: await operations.setCap(accountId, cap),
    }),
    "account.refreshUsage": async ({ accountId }) => ({
      account: await operations.refreshUsage(accountId),
    }),
    "account.reorder": async ({ provider, accountIds }) => {
      await operations.reorder(provider, accountIds);
      return null;
    },
    "routing.set": async ({ provider, enabled }) => {
      await operations.setRouting(provider, enabled);
      return { provider, enabled };
    },
    "config.get": () => config.get(),
    "config.set": (input) => config.set(input),
    "login.start": () => login.start(),
    "login.reauthorize": async ({accountId}) => {
      await operations.validateClaudeReauthorization(accountId);
      return login.start(accountId);
    },
    "login.complete": (input) => login.complete(input),
    "agyLogin.openBrowser":({sessionId})=>{if(!agyLogin)throw Error("Antigravity login unavailable");return openAgyBrowser(agyLogin.authorizationUrl(sessionId));},
    "agyLogin.start":()=>{if(!agyLogin)throw Error('Antigravity login unavailable');return agyLogin.start();},
    "agyLogin.complete":async({sessionId,pasted})=>{if(!agyLogin)throw Error('Antigravity login unavailable');return operations.addAgyOAuth(await agyLogin.complete(sessionId,pasted));},
    "agyLogin.cancel":({sessionId})=>{if(!agyLogin)throw Error('Antigravity login unavailable');agyLogin.cancel(sessionId);return {cancelled:true};},
    "codexLogin.start": () => codexLogin.start(),
    "codexLogin.poll": (input) => codexLogin.poll(input),
    "codexLogin.cancel": (input) => ({
      cancelled: codexLogin.cancel(input),
    }),
    "grokLogin.start": () => {
      if (grokLogin === undefined) throw new Error("Grok sign-in is unavailable.");
      return grokLogin.start();
    },
    "grokLogin.poll": (input) => {
      if (grokLogin === undefined) throw new Error("Grok sign-in is unavailable.");
      return grokLogin.poll(input);
    },
    "grokLogin.cancel": (input) => ({
      cancelled: grokLogin === undefined ? false : grokLogin.cancel(input),
    }),
    "status.get": () => operations.status(),
    "status.routedThreads": () => operations.routedThreadsWithoutLocalLogin(),
    "token.rotate": ({ machine }) => operations.rotateToken(machine),
    "bypass.set": ({ threadId, bypassed }) =>
      operations.setBypass(threadId, bypassed),
  };
}
