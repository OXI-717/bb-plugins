import type { Account, AccountQuota, AccountPolicy, AccountPoolConfig, PoolProvider } from './contracts.js';
import { currentWeeklyBudget } from './weekly-budget.js';

export interface QuotaThresholds { other: number; fiveHour: number; weekly: number; familyWeekly?: number }
export type PoolThresholdConfig = Pick<AccountPoolConfig,
  "switchThreshold" | "fiveHourSwitchThreshold" | "weeklySwitchThreshold">;

export function poolThresholds(config: PoolThresholdConfig, provider: PoolProvider): QuotaThresholds {
  return {
    other: config.switchThreshold,
    fiveHour: config.fiveHourSwitchThreshold ?? config.switchThreshold,
    // Cursor stores its billing cycle in the long-window slot.
    weekly: (provider === "cursor" ? null : config.weeklySwitchThreshold) ?? config.switchThreshold,
  };
}

export function policyThresholds(
  account: Pick<Account, "provider" | "policy" | "drainOnce" | "weeklyBudget">,
  config: PoolThresholdConfig,
  quota?: Pick<AccountQuota, "sevenDayUtilization" | "sevenDayResetAt" | "sevenDayStatus" | "limitWindows">,
  now = Date.now(),
): QuotaThresholds {
  if (account.drainOnce) return { other: 1, fiveHour: 1, weekly: 1 };
  const fallback = poolThresholds(config, account.provider);
  const p = account.policy?.enabled ? account.policy : undefined;
  const weekly = p?.weeklyKeep == null ? fallback.weekly : (100 - p.weeklyKeep) / 100;
  const budget = quota && currentWeeklyBudget(account, quota, now);
  return {
    other: fallback.other,
    fiveHour: p?.fiveHourKeep == null ? fallback.fiveHour : (100 - p.fiveHourKeep) / 100,
    weekly: budget?.ceiling ?? weekly,
    ...(budget ? { familyWeekly: weekly } : {}),
  };
}
export function scheduleAllows(policy: AccountPolicy | undefined, now: number): boolean {
  if (!policy?.enabled || !policy.schedule) return true;
  const { timeZone, intervals } = policy.schedule;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = (type: string) => parts.find(p => p.type === type)!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
  const time = `${value('hour')}:${value('minute')}`;
  return intervals.some(({ days, start, end }) => start < end
    ? days.includes(day) && time >= start && time < end
    : (days.includes(day) && time >= start) || (days.includes((day + 6) % 7) && time < end));
}
export function reserveHours(account: { policy?: AccountPolicy }, fallback: number): number {
  return account.policy?.enabled ? account.policy.reserveDrainHours ?? fallback : fallback;
}
export function policySummary(policy?: AccountPolicy, modelReserveOnly = false, provider?: PoolProvider): string {
  if (!policy?.enabled) return '';
  return [
    policy.fiveHourKeep == null ? null : `5 ч: оставить ${policy.fiveHourKeep}%`,
    policy.weeklyKeep == null ? null : `${provider === 'cursor' ? 'Расчётный цикл' : modelReserveOnly ? 'Модели' : 'Неделя'}: оставить ${policy.weeklyKeep}%`,
    policy.reserveDrainHours == null ? null : `Резерв: за ${policy.reserveDrainHours} ч`,
    policy.schedule ? `${policy.schedule.intervals.map(i => `${i.days.map(d => ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"][d]).join(",")} ${i.start}–${i.end}`).join("; ") || "Нет разрешённых интервалов"} · ${policy.schedule.timeZone}` : null,
  ].filter(Boolean).join(' · ') || 'Наследуются общие значения';
}
