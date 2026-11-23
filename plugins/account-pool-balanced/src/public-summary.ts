import { policyThresholds } from './account-policy.js';
import { codexBudgetQuota } from './codex-budget.js';
import type { Account, AccountQuota } from './contracts.js';
import { providerBudgetQuota } from './provider-budget.js';
import { accountStatus } from './quota.js';
import { zaiBudgetQuota } from './zai-budget.js';

const providers = ['claude', 'codex', 'gemini', 'grok', 'zai', 'ifm'] as const;
type Provider = typeof providers[number];

function usedPercent(provider: Provider, quota: AccountQuota, now: number): number | null {
  if (provider === 'claude') {
    const evidence = providerBudgetQuota(provider, quota, now);
    if (!evidence.budgetReady || !evidence.windows.length) return null;
    return Math.max(...evidence.windows.map(window => 100 - window.remainingPercent));
  }
  if (provider !== 'codex' && provider !== 'zai') return null;
  const evidence = provider === 'codex' ? codexBudgetQuota(quota, now) : zaiBudgetQuota(quota, now);
  if (!evidence.budgetReady) return null;
  const windows = Object.values(evidence.windows).flatMap(window =>
    window.state === 'present' && window.remainingPercent !== null ? [100 - window.remainingPercent] : []);
  return windows.length ? Math.max(...windows) : null;
}

export function publicPoolSummary(
  accounts: readonly Account[],
  quotaFor: (id: string) => AccountQuota,
  threshold: number,
  now: number,
) {
  return {
    generatedAt: new Date(now).toISOString(),
    providers: Object.fromEntries(providers.map(provider => {
      const enabled = accounts.filter(account => account.enabled && account.provider === provider);
      let exhaustedCount = 0;
      const usage: Array<number | null> = [];
      for (const account of enabled) {
        const quota = quotaFor(account.id);
        const status = accountStatus(account, quota, policyThresholds(account, threshold, quota, now), now);
        if (status === 'exhausted') exhaustedCount++;
        if (status === 'ready') usage.push(usedPercent(provider, quota, now));
      }
      const known = usage.filter((percent): percent is number => percent !== null && Number.isFinite(percent) && percent >= 0 && percent <= 100);
      return [provider, {
        readyCount: usage.length,
        totalEnabled: enabled.length,
        minUsedPercent: known.length >= 2 && known.length === usage.length ? Math.min(...known) : null,
        exhausted: enabled.length > 0 && exhaustedCount === enabled.length,
      }];
    })),
  };
}
