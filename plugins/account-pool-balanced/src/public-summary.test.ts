import { expect, it } from 'vitest';
import { accountSchema, EMPTY_FAMILY_WEEKLY, type AccountQuota } from './contracts.js';
import { publicPoolSummary } from './public-summary.js';

const now = Date.parse('2026-11-23T12:00:00.000Z');
const resetAt = now + 60_000;

function account(index: number, provider = 'zai', enabled = true) {
  return accountSchema.parse({
    id: `00000000-0000-4000-8000-00000000000${index}`, provider, enabled,
    kind: 'api-key', label: 'synthetic private label', email: 'sentinel@example.test',
    subscriptionType: null, rateLimitTier: null, priority: 100, createdAt: now,
  });
}

function quota(fiveHour: number, weekly: number, observedAt = now): AccountQuota {
  return {
    accountId: 'synthetic-private-id', fiveHourUtilization: null, fiveHourResetAt: null,
    fiveHourStatus: null, sevenDayUtilization: null, sevenDayResetAt: null,
    sevenDayStatus: null, representativeClaim: null, familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [], observedAt, heldUntil: null, error: null,
    zaiUsageEvidence: { source: 'usage', observedAt,
      fiveHour: { usedPercent: fiveHour, resetAt }, weekly: { usedPercent: weekly, resetAt } },
  };
}

it('returns the minimum of the account maxima and only the public fields', () => {
  const a = account(1);
  const b = account(2);
  const ignored = account(3, 'zai', false);
  const other = account(4, 'cursor');
  const summary = publicPoolSummary([b, ignored, a, other], id => {
    if (id === a.id) return quota(80, 0);
    if (id === b.id) return quota(20, 55);
    throw Error('Out-of-scope quota lookup');
  }, 0.95, now);
  expect(summary.providers.zai).toEqual({ readyCount: 2, totalEnabled: 2, minUsedPercent: 55, exhausted: false });
  expect(JSON.stringify(summary)).not.toMatch(/synthetic|sentinel|cursor/);
});

it('hides exact usage for one ready account and preserves unknown evidence', () => {
  const a = account(1);
  const b = account(2);
  const gemini = account(3, 'gemini');
  expect(publicPoolSummary([a], () => quota(0, 0), 0.95, now).providers.zai?.minUsedPercent).toBeNull();
  const summary = publicPoolSummary([a, b, gemini], id => id === b.id
    ? quota(20, 20, now - 360_000)
    : quota(0, 0), 0.95, now);
  expect(summary.providers.zai).toEqual({ readyCount: 2, totalEnabled: 2, minUsedPercent: null, exhausted: false });
  expect(summary.providers.gemini).toEqual({ readyCount: 1, totalEnabled: 1, minUsedPercent: null, exhausted: false });
});

it('distinguishes held and errored accounts from exhaustion', () => {
  const a = account(1);
  const b = account(2);
  const exhausted = { ...quota(100, 100), fiveHourUtilization: 1, fiveHourResetAt: resetAt };
  expect(publicPoolSummary([a, b], () => exhausted, 0.95, now).providers.zai?.exhausted).toBe(true);
  const summary = publicPoolSummary([a, b], id => id === a.id
    ? { ...exhausted, error: 'synthetic private error' }
    : { ...exhausted, heldUntil: resetAt }, 0.95, now);
  expect(summary.providers.zai).toEqual({ readyCount: 0, totalEnabled: 2, minUsedPercent: null, exhausted: false });
  expect(JSON.stringify(summary)).not.toContain('synthetic private error');
});
