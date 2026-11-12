import { createHash } from "node:crypto";
import { accountProjectsSchema, type AccountProjects } from "./contracts.js";
import { z } from "zod";

export const nativeProjectsSchema = accountProjectsSchema.refine(value => value.rules.length <= 32 && value.rules.every(rule => /^[A-Za-z0-9_-]{1,80}$/.test(rule.projectId) && rule.role === 'inherit'), 'Native project lists allow at most 32 project IDs and inherited roles');

export const nativeAccountsSchema = z.object({
  managed: z.boolean(),
  selectionRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  accounts: z.array(z.object({
    accountId: z.string(),
    label:z.string().optional(),
    projects: accountProjectsSchema,
    projectsRevision: z.string(),
    mixedProjects: z.boolean(),
    executors: z.array(z.object({
      id: z.string(), enabled: z.boolean(), autopilotAllowed: z.boolean(),
      preferred:z.boolean().optional(),
    }).strict()),
    active: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export type NativeAccounts = z.infer<typeof nativeAccountsSchema>;

/** UI metadata only: never expose caller authority, execution bindings or credentials. */
export function summarizeNativeAccounts(state: {
  managed: boolean;
  preferredExecutors?:Record<string,string>;
  executors: Array<{id: string; accountId: string; hostId?:string; label?:string; enabled: boolean; autopilotAllowed: boolean; projectIds: string[]; projects?: AccountProjects}>;
  leases: Array<{executor: {accountId: string}; state: "active" | "queued" | "uncertain"}>;
}): NativeAccounts {
  const accounts: NativeAccounts["accounts"] = [];
  for (const executor of state.executors) {
    let account = accounts.find(item => item.accountId === executor.accountId);
    if (!account) {
      const group = state.executors.filter(e => e.accountId === executor.accountId);
      const policies = group.map(e => e.projects ?? {onlySelected: true, rules: e.projectIds.map(projectId => ({projectId, role: 'inherit' as const}))});
      const projects=policies[0];
      account = {accountId: executor.accountId, projects:structuredClone(projects), mixedProjects:policies.some(p=>JSON.stringify(p)!==JSON.stringify(projects)), projectsRevision: createHash('sha256').update(JSON.stringify(group.map(e => [e.id,e.projectIds,e.projects]))).digest('hex'), executors: [], active: 0, queued: 0, uncertain: 0};
      accounts.push(account);
    }
    if(executor.label&&!account.label)account.label=executor.label;
    account.executors.push({id: executor.id, enabled: executor.enabled, autopilotAllowed: executor.autopilotAllowed,
      ...(executor.hostId&&state.preferredExecutors?.[executor.hostId]===executor.id?{preferred:true}:{})});
  }
  for (const lease of state.leases) {
    const account = accounts.find(item => item.accountId === lease.executor.accountId);
    if (account) account[lease.state]++;
  }
  return {managed: state.managed, accounts};
}
