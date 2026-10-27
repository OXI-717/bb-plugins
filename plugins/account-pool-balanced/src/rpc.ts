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
  routedThreadStatusListSchema,
  statusSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import type { PoolOperations } from "./operations.js";
import type { ClaudeOAuthLogin } from "./oauth-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";

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
): PluginRpcHandlers<typeof accountPoolRpcContract> {
  return {
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
    "agyLogin.start":()=>{if(!agyLogin)throw Error('Antigravity login unavailable');return agyLogin.start();},
    "agyLogin.complete":async({sessionId,pasted})=>{if(!agyLogin)throw Error('Antigravity login unavailable');return operations.addAgyOAuth(await agyLogin.complete(sessionId,pasted));},
    "agyLogin.cancel":({sessionId})=>{if(!agyLogin)throw Error('Antigravity login unavailable');agyLogin.cancel(sessionId);return {cancelled:true};},
    "codexLogin.start": () => codexLogin.start(),
    "codexLogin.poll": (input) => codexLogin.poll(input),
    "codexLogin.cancel": (input) => ({
      cancelled: codexLogin.cancel(input),
    }),
    "status.get": () => operations.status(),
    "status.routedThreads": () => operations.routedThreadsWithoutLocalLogin(),
    "token.rotate": ({ machine }) => operations.rotateToken(machine),
    "bypass.set": ({ threadId, bypassed }) =>
      operations.setBypass(threadId, bypassed),
  };
}
