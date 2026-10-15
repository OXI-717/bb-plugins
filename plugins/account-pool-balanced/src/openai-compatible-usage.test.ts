import { describe, expect, it } from "vitest";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import {isSharedQuotaExhausted,blockingResetAt} from './quota.js';
import {
  opencodeGoQuotaFromUsages,
  zaiQuotaFromUsages,
} from "./openai-compatible-usage.js";

const ACCOUNT_ID = "3f2c0b74-91aa-4c2e-8a1e-7b6d5c4e3a22";
const NOW = Date.parse("2026-09-17T09:00:00.000Z");

function previous(): AccountQuota {
  return {
    accountId: ACCOUNT_ID,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: "stale failure",
  };
}

describe("z.ai quota parsing", () => {
  it("classifies the token windows by unit, not by reset order", () => {
    const quota = zaiQuotaFromUsages(
      ACCOUNT_ID,
      {
        code: 200,
        data: {
          level: "lite",
          limits: [
            { type: "TIME_LIMIT", unit: 5, percentage: 90 },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              percentage: 63,
              nextResetTime: 1789648864022,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              percentage: 12,
              nextResetTime: 1789869700999,
            },
          ],
        },
      },
      previous(),
      NOW,
    );
    expect(quota).toMatchObject({
      fiveHourUtilization: 0.12,
      fiveHourResetAt: 1789869700999,
      sevenDayUtilization: 0.63,
      sevenDayResetAt: 1789648864022,
      observedAt: NOW,
      error: null,
    });
  });

  it("ignores non-token windows and reports nothing without them", () => {
    expect(
      zaiQuotaFromUsages(
        ACCOUNT_ID,
        { data: { limits: [{ type: "TIME_LIMIT", unit: 5, percentage: 40 }] } },
        previous(),
        NOW,
      ),
    ).toBe(null);
  });
});

describe("OpenCode Go quota parsing", () => {
  it.each(['fiveHour','weekly'] as const)('retains a missing %s rejection during a monthly-only refresh',kind=>{
    const reset=NOW+86400000;
    const prior={...previous(),fiveHourUtilization:kind==='fiveHour'?1:0,fiveHourResetAt:reset,fiveHourStatus:kind==='fiveHour'?'rejected':null,sevenDayUtilization:kind==='weekly'?1:0,sevenDayResetAt:reset,sevenDayStatus:kind==='weekly'?'rejected':null};
    const result=opencodeGoQuotaFromUsages(ACCOUNT_ID,{usage:{monthly:{percent:25,status:'ok'}}},prior,NOW)!;
    expect(isSharedQuotaExhausted(result,1,NOW)).toBe(true);
    expect(result.fiveHourUtilization).toBe(prior.fiveHourUtilization);
    expect(result.fiveHourResetAt).toBe(prior.fiveHourResetAt);
    expect(result.fiveHourStatus).toBe(prior.fiveHourStatus);
    expect(result.sevenDayUtilization).toBe(prior.sevenDayUtilization);
    expect(result.sevenDayResetAt).toBe(prior.sevenDayResetAt);
    expect(result.sevenDayStatus).toBe(prior.sevenDayStatus);
  });
  it('blocks exhausted monthly usage even when rolling and weekly counters are zero',()=>{
    const resetAt='2026-10-01T09:00:00.000Z';
    const result=opencodeGoQuotaFromUsages(ACCOUNT_ID,{usage:{rolling:{percent:0},weekly:{percent:0},monthly:{status:'rate-limited',percent:100,resetsAt:resetAt}}},previous(),NOW)!;
    expect(result.limitWindows).toEqual([{slot:'secondary',windowMinutes:43200,utilization:1,status:'rejected',resetAt:Date.parse(resetAt),observedAt:NOW,source:'usage'}]);
    expect(isSharedQuotaExhausted(result,1,NOW)).toBe(true);
    expect(blockingResetAt(result,null,1,NOW)).toBe(Date.parse(resetAt));
  });
  it('recognises a monthly-only response and explicit rejection with a rounded zero counter',()=>{
    const result=opencodeGoQuotaFromUsages(ACCOUNT_ID,{usage:{monthly:{status:'rate-limited',percent:0,resetsAt:'2026-10-01T09:00:00.000Z'}}},previous(),NOW);
    expect(result).not.toBeNull();
    expect(isSharedQuotaExhausted(result!,1,NOW)).toBe(true);
  });
  it('does not erase an observed monthly rejection when a partial refresh omits that window',()=>{
    const existing=opencodeGoQuotaFromUsages(ACCOUNT_ID,{usage:{monthly:{percent:100,status:'rate-limited',resetsAt:'2026-10-01T09:00:00Z'}}},previous(),NOW)!;
    const partial=opencodeGoQuotaFromUsages(ACCOUNT_ID,{usage:{rolling:{percent:0},weekly:{percent:0}}},existing,NOW+1000)!;
    expect(partial.limitWindows).toEqual(existing.limitWindows);
    expect(isSharedQuotaExhausted(partial,1,NOW+1000)).toBe(true);
    expect(opencodeGoQuotaFromUsages(ACCOUNT_ID,{usage:{}},existing,NOW+1000)).toBeNull();
  });
  it("reads the rolling and weekly windows from a live payload", () => {
    const quota = opencodeGoQuotaFromUsages(
      ACCOUNT_ID,
      {
        usage: {
          rolling: {
            status: "ok",
            percent: 4,
            resetsAt: "2026-09-17T14:53:00.430Z",
          },
          weekly: {
            status: "ok",
            percent: 72,
            resetsAt: "2026-09-21T00:00:00.430Z",
          },
          monthly: { status: "ok", percent: 37 },
        },
      },
      previous(),
      NOW,
    );
    expect(quota).toMatchObject({
      fiveHourUtilization: 0.04,
      fiveHourResetAt: Date.parse("2026-09-17T14:53:00.430Z"),
      sevenDayUtilization: 0.72,
      sevenDayResetAt: Date.parse("2026-09-21T00:00:00.430Z"),
      error: null,
    });
  });

  it("reports nothing when the payload carries no windows", () => {
    expect(
      opencodeGoQuotaFromUsages(ACCOUNT_ID, { usage: {} }, previous(), NOW),
    ).toBe(null);
    expect(
      opencodeGoQuotaFromUsages(ACCOUNT_ID, "not json", previous(), NOW),
    ).toBe(null);
  });
});
