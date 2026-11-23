import type { Account, AccountQuota, WeeklyBudgetChange } from "./contracts.js";

const HOUR_MS = 3_600_000;
// Some quota headers report seconds remaining and the estimate moves between reads.
const RESET_ESTIMATE_TOLERANCE_MS = 5_000;
type Quota = Pick<AccountQuota, "sevenDayUtilization" | "sevenDayResetAt" | "sevenDayStatus" | "limitWindows">;
type Budget = Pick<Account, "weeklyBudget" | "drainOnce">;

export function observedWeek(quota: Quota, now: number) {
  const windows = [
    { utilization: quota.sevenDayUtilization, resetAt: quota.sevenDayResetAt, status: quota.sevenDayStatus },
    ...quota.limitWindows.filter(window => window.windowMinutes === 10_080),
  ];
  const active = windows.filter(window =>
    (window.utilization !== null || window.status !== null || window.resetAt !== null) &&
    (window.resetAt === null || window.resetAt > now),
  );
  return active.reduce<(typeof windows)[number] | null>((busiest, window) => {
    if (busiest === null) return window;
    if ((window.utilization ?? -1) > (busiest.utilization ?? -1)) return window;
    if (window.utilization === busiest.utilization && busiest.resetAt === null && window.resetAt !== null) return window;
    return busiest;
  }, null);
}

export function currentWeeklyBudget(account: Budget, quota: Quota, now: number) {
  const budget = account.weeklyBudget;
  if (!budget || account.drainOnce) return null;
  const resetAt = observedWeek(quota, now)?.resetAt ?? null;
  let ceiling = budget.rule.ceiling;
  let nextChangeAt = resetAt;
  if (resetAt !== null && budget.rule.mode === "scheduled") {
    for (const step of budget.rule.steps) {
      const startsAt = resetAt - step.hoursBeforeReset * HOUR_MS;
      if (startsAt > now) {
        nextChangeAt = startsAt;
        break;
      }
      ceiling = step.ceiling;
    }
  }
  const override = budget.override;
  if (override && resetAt !== null &&
      Math.abs(override.resetAt - resetAt) <= RESET_ESTIMATE_TOLERANCE_MS && override.until > now) {
    return { mode: "override" as const, ceiling: override.ceiling / 100, nextChangeAt: override.until };
  }
  return { mode: budget.rule.mode, ceiling: ceiling / 100, nextChangeAt };
}

export function changeWeeklyBudget(account: Account, quota: Quota, input: WeeklyBudgetChange, now: number): Account["weeklyBudget"] {
  const current = account.weeklyBudget;
  if (JSON.stringify(current ?? null) !== JSON.stringify(input.expected)) {
    throw new Error("The weekly rule changed. Refresh and try again.");
  }
  if (input.change.kind === "rule") return input.change.rule ? { rule: input.change.rule, override: null } : undefined;
  if (!current) throw new Error("Save the weekly rule first.");
  if (input.change.kind === "clear-override") return { rule: current.rule, override: null };
  const resetAt = observedWeek(quota, now)?.resetAt ?? null;
  if (account.drainOnce || resetAt === null) throw new Error("A temporary cap needs a valid weekly reset and Until exhausted disabled.");
  const scheduled = currentWeeklyBudget({ weeklyBudget: { rule: current.rule, override: null } }, quota, now);
  const until = input.change.until === "next-step" ? scheduled?.nextChangeAt ?? resetAt : resetAt;
  return { rule: current.rule, override: { ceiling: input.change.ceiling, until, resetAt } };
}
