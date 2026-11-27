import { describe, expect, it } from 'vitest';
import { accountPolicySchema, accountPoolConfigSchema } from './contracts.js';
import { policyThresholds, scheduleAllows } from './account-policy.js';

describe('account policies', () => {
  const legacy = accountPoolConfigSchema.parse({ switchThreshold: .98 });
  const policy = accountPolicySchema.parse({ enabled: true, weeklyKeep: 50, fiveHourKeep: 20 });
  it('inherits when disabled and overrides independently', () => {
    expect(policyThresholds({ policy: { ...policy, enabled: false } }, legacy)).toEqual({ other: .98, fiveHour: .98, weekly: .98 });
    expect(policyThresholds({ policy }, legacy)).toEqual({ other: .98, fiveHour: .8, weekly: .5 });
    expect(policyThresholds({ policy: { ...policy, fiveHourKeep: null } }, accountPoolConfigSchema.parse({ switchThreshold: .9 })).fiveHour).toBe(.9);
  });
  it('keeps the legacy threshold for other windows and inherits each fixed ceiling separately', () => {
    const config = { ...legacy, fiveHourSwitchThreshold: .45, weeklySwitchThreshold: .75 };
    expect(policyThresholds({}, config)).toEqual({ other: .98, fiveHour: .45, weekly: .75 });
    expect(policyThresholds({ policy: { ...policy, fiveHourKeep: null } }, config)).toEqual({ other: .98, fiveHour: .45, weekly: .5 });
    expect(policyThresholds({ policy: { ...policy, weeklyKeep: null } }, config)).toEqual({ other: .98, fiveHour: .8, weekly: .75 });
  });
  it('drain once bypasses protection', () => {
    expect(policyThresholds({ policy, drainOnce: true }, legacy)).toEqual({ other: 1, fiveHour: 1, weekly: 1 });
  });
  it('respects timezone, overnight start weekday and exclusive end', () => {
    const p = { ...policy, schedule: { timeZone: 'Europe/Paris', intervals: [{ days: [1], start: '22:00', end: '08:00' }] } };
    expect(scheduleAllows(p, Date.parse('2026-10-05T21:00:00Z'))).toBe(true);
    expect(scheduleAllows(p, Date.parse('2026-10-06T05:59:00Z'))).toBe(true);
    expect(scheduleAllows(p, Date.parse('2026-10-06T06:00:00Z'))).toBe(false);
    expect(scheduleAllows(p, Date.parse('2026-10-06T21:00:00Z'))).toBe(false);
  });
  it('empty intervals disable availability; disabled override inherits', () => {
    const p = { ...policy, schedule: { timeZone: 'UTC', intervals: [] } };
    expect(scheduleAllows(p, Date.now())).toBe(false);
    expect(scheduleAllows({ ...p, enabled: false }, Date.now())).toBe(true);
  });
  it('rejects invalid times, zones and ambiguous empty intervals', () => {
    for (const schedule of [
      { timeZone: 'wrong', intervals: [] },
      { timeZone: 'UTC', intervals: [{ days: [1], start: '25:00', end: '08:00' }] },
      { timeZone: 'UTC', intervals: [{ days: [1], start: '08:00', end: '08:00' }] },
    ]) expect(accountPolicySchema.safeParse({ enabled: true, schedule }).success).toBe(false);
  });
});

import { isQuotaExhausted, blockingResetAt } from './quota.js';
import type { AccountQuota } from './contracts.js';
const quota: AccountQuota = {
  accountId: '00000000-0000-4000-8000-000000000000',
  fiveHourUtilization: .6, fiveHourResetAt: 2000, fiveHourStatus: 'allowed',
  sevenDayUtilization: .4, sevenDayResetAt: 8000, sevenDayStatus: 'allowed',
  representativeClaim: null, familyWeekly: { fable:null, sonnet:null, opus:null, haiku:null, other:null },
  limitWindows: [], observedAt: 1000, heldUntil:null, error:null,
};
it('applies separate thresholds to rejection and reset hints', () => {
  const limits = { other: .98, fiveHour: .5, weekly: .8 };
  expect(isQuotaExhausted(quota, 'opus', limits, 1000)).toBe(true);
  expect(blockingResetAt(quota, 'opus', limits, 1000)).toBe(2000);
  expect(isQuotaExhausted(quota, 'opus', limits, 2001)).toBe(false);
  const week = { other: .98, fiveHour: .8, weekly: .3 };
  expect(blockingResetAt(quota, 'opus', week, 1000)).toBe(8000);
});
it('uses the weekly rule and temporary ceiling for shared quota while family quota keeps the fixed limit', () => {
  const config = accountPoolConfigSchema.parse({ switchThreshold: .85, fiveHourSwitchThreshold: .6, weeklySwitchThreshold: .8 });
  const weeklyBudget = {
    rule: { mode: 'scheduled' as const, ceiling: 30, steps: [{ hoursBeforeReset: 1, ceiling: 50 }] },
    override: { ceiling: 70, until: 1500, resetAt: 8000 },
  };
  const account = { weeklyBudget };
  expect(policyThresholds(account, config, quota, 1000)).toEqual({ other: .85, fiveHour: .6, weekly: .7, familyWeekly: .8 });
  expect(policyThresholds(account, config, quota, 1500)).toEqual({ other: .85, fiveHour: .6, weekly: .5, familyWeekly: .8 });
  const policy = accountPolicySchema.parse({ enabled: true, weeklyKeep: 10 });
  expect(policyThresholds({ ...account, policy }, config, quota, 1000)).toMatchObject({ weekly: .7, familyWeekly: .9 });
  expect(policyThresholds({ ...account, policy, drainOnce: true }, config, quota, 1000)).toEqual({ other: 1, fiveHour: 1, weekly: 1 });
});
it('uses Codex window durations rather than primary/secondary position', () => {
  const q = { ...quota, fiveHourUtilization:null, sevenDayUtilization:null, limitWindows: [
    { slot: 'primary' as const, windowMinutes:10080, utilization:.6, resetAt:8000, status:'allowed', observedAt:1000, source:'usage' as const },
  ] };
  expect(isQuotaExhausted(q, 'other', { other:.98, fiveHour:.9, weekly:.5 }, 1000)).toBe(true);
  expect(blockingResetAt(q, 'other', { other:.98, fiveHour:.9, weekly:.5 }, 1000)).toBe(8000);
});
