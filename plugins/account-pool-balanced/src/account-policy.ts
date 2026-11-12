import type { AccountPolicy } from './contracts.js';
export interface QuotaThresholds { other: number; fiveHour: number; weekly: number }
export function policyThresholds(account: { policy?: AccountPolicy; drainOnce?: boolean }, fallback: number): QuotaThresholds {
  if (account.drainOnce) return { other: 1, fiveHour: 1, weekly: 1 };
  const p = account.policy?.enabled ? account.policy : undefined;
  return {
    other: fallback,
    fiveHour: p?.fiveHourKeep == null ? fallback : 1 - p.fiveHourKeep / 100,
    weekly: p?.weeklyKeep == null ? fallback : 1 - p.weeklyKeep / 100,
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
export function policySummary(policy?: AccountPolicy): string {
  if (!policy?.enabled) return '';
  return [
    policy.fiveHourKeep == null ? null : `5 ч: оставить ${policy.fiveHourKeep}%`,
    policy.weeklyKeep == null ? null : `Неделя: оставить ${policy.weeklyKeep}%`,
    policy.reserveDrainHours == null ? null : `Резерв: за ${policy.reserveDrainHours} ч`,
    policy.schedule ? `${policy.schedule.intervals.map(i => `${i.days.map(d => ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"][d]).join(",")} ${i.start}–${i.end}`).join("; ") || "Нет разрешённых интервалов"} · ${policy.schedule.timeZone}` : null,
  ].filter(Boolean).join(' · ') || 'Наследуются общие значения';
}
