import type { AccountQuota } from './contracts.js';

export const CODEX_BUDGET_MAX_AGE_MS = 5 * 60_000;
type State = 'present' | 'absent' | 'unknown';
interface BudgetWindow {
  state: State; remainingPercent: number | null; resetAt: number | null;
  observedAt: number | null; source: 'usage' | 'header' | null;
}
const unknown = (): BudgetWindow => ({ state: 'unknown', remainingPercent: null, resetAt: null, observedAt: null, source: null });

/** Partial headers can describe a window, but cannot prove another window absent. */
export function codexBudgetQuota(quota: AccountQuota, now: number) {
  const fresh = (at: number | null) => at !== null && at <= now && now - at <= CODEX_BUDGET_MAX_AGE_MS;
  const evidence = quota.codexUsageEvidence;
  const usageFresh = evidence !== undefined && fresh(evidence.observedAt);
  const usageComplete = usageFresh && evidence.primary !== 'unknown' && evidence.secondary !== 'unknown';
  const slots = (['primary', 'secondary'] as const).map(slot => {
    const window = quota.limitWindows.find(w => w.slot === slot);
    const absence = usageFresh && evidence[slot] === 'absent' && !window;
    return { slot, state: (window ? 'present' : absence ? 'absent' : 'unknown') as State, window };
  });
  const complete = slots.every(s => s.state === 'absent' || (s.state === 'present' && s.window?.windowMinutes !== null && s.window !== undefined && fresh(s.window.observedAt) && s.window.utilization !== null && s.window.utilization >= 0 && s.window.utilization <= 1 && s.window.resetAt !== null && s.window.resetAt > now));
  const resolve = (minutes: number): BudgetWindow => {
    const matches = slots.filter(s => s.window?.windowMinutes === minutes);
    if (matches.length > 1) return unknown();
    if (matches.length === 1) {
      const w = matches[0]!.window!;
      if (!fresh(w.observedAt) || w.utilization === null || w.utilization < 0 || w.utilization > 1 || w.resetAt === null || w.resetAt <= now) return unknown();
      return { state: 'present', remainingPercent: (1 - w.utilization) * 100, resetAt: w.resetAt, observedAt: w.observedAt, source: w.source };
    }
    if (usageComplete && complete) return { state: 'absent', remainingPercent: null, resetAt: null, observedAt: evidence.observedAt, source: 'usage' };
    return unknown();
  };
  const fiveHour = resolve(300), weekly = resolve(10080);
  return {
    // Consumers must check every account that this route can select. This is not a reservation.
    budgetReady: complete && usageComplete && evidence.allowed === true && evidence.limitReached === false && quota.error === null && [fiveHour, weekly].every(w => w.state !== 'unknown') && slots.every(s => s.state === 'absent' || [300, 10080].includes(s.window?.windowMinutes ?? 0)),
    windows: { fiveHour, weekly },
    usage: evidence ?? null,
    slots: slots.map(({ slot, state, window }) => ({ slot, state, window: window ?? null })),
  };
}
