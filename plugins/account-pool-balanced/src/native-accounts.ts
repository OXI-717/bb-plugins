import { z } from "zod";

export const nativeAccountsSchema = z.object({
  managed: z.boolean(),
  accounts: z.array(z.object({
    accountId: z.string(),
    executors: z.array(z.object({
      id: z.string(), enabled: z.boolean(), autopilotAllowed: z.boolean(),
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
  executors: Array<{id: string; accountId: string; enabled: boolean; autopilotAllowed: boolean}>;
  leases: Array<{executor: {accountId: string}; state: "active" | "queued" | "uncertain"}>;
}): NativeAccounts {
  const accounts: NativeAccounts["accounts"] = [];
  for (const executor of state.executors) {
    let account = accounts.find(item => item.accountId === executor.accountId);
    if (!account) {
      account = {accountId: executor.accountId, executors: [], active: 0, queued: 0, uncertain: 0};
      accounts.push(account);
    }
    account.executors.push({id: executor.id, enabled: executor.enabled, autopilotAllowed: executor.autopilotAllowed});
  }
  for (const lease of state.leases) {
    const account = accounts.find(item => item.accountId === lease.executor.accountId);
    if (account) account[lease.state]++;
  }
  return {managed: state.managed, accounts};
}
