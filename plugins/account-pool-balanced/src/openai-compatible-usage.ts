import { z } from "zod";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota, type LimitWindow } from "./contracts.js";
import { parseReset } from "./quota.js";

const ZAI_FIVE_HOUR_UNIT = 3;
const ZAI_WEEKLY_UNIT = 6;

const zaiWindowSchema = z
  .object({
    type: z.string().nullish(),
    unit: z.number().nullish(),
    percentage: z.union([z.number(), z.string()]).nullish(),
    nextResetTime: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const zaiPayloadSchema = z
  .object({
    data: z
      .object({ limits: z.array(zaiWindowSchema).nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const percentWindowSchema = z
  .object({
    percent: z.union([z.number(), z.string()]).nullish(),
    resetsAt: z.union([z.number(), z.string()]).nullish(),
    status:z.string().nullish(),
  })
  .passthrough();

const opencodeGoPayloadSchema = z
  .object({
    usage: z
      .object({
        rolling: percentWindowSchema.nullish(),
        weekly: percentWindowSchema.nullish(),
        monthly: percentWindowSchema.nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

function fraction(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed / 100, 0), 1);
}

function quota(
  accountId: string,
  previous: AccountQuota,
  now: number,
  windows: {
    fiveHour: { utilization: number | null; resetAt: number | null;status?:string|null };
    weekly: { utilization: number | null; resetAt: number | null;status?:string|null };
  },
  additionalWindows:LimitWindow[] = [],
): AccountQuota | null {
  if (
    windows.fiveHour.utilization === null &&
    windows.weekly.utilization === null &&
    windows.fiveHour.status == null && windows.weekly.status == null &&
    additionalWindows.length === 0
  ) {
    return null;
  }
  return {
    accountId,
    fiveHourUtilization: windows.fiveHour.utilization,
    fiveHourResetAt: windows.fiveHour.resetAt,
    fiveHourStatus: windows.fiveHour.status ?? null,
    sevenDayUtilization: windows.weekly.utilization,
    sevenDayResetAt: windows.weekly.resetAt,
    sevenDayStatus: windows.weekly.status ?? null,
    representativeClaim: previous.representativeClaim,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: additionalWindows,
    observedAt: now,
    heldUntil: previous.heldUntil,
    error: null,
  };
}

export function zaiQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const parsed = zaiPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const windows = (parsed.data.data?.limits ?? []).filter(
    (row) => row.type === "TOKENS_LIMIT",
  );
  const byUnit = (unit: number) =>
    windows.find((row) => row.unit === unit) ?? null;
  const fiveHour = byUnit(ZAI_FIVE_HOUR_UNIT);
  const weekly = byUnit(ZAI_WEEKLY_UNIT);
  return quota(accountId, previous, now, {
    fiveHour: {
      utilization: fraction(fiveHour?.percentage),
      resetAt: parseReset(fiveHour?.nextResetTime ?? null),
    },
    weekly: {
      utilization: fraction(weekly?.percentage),
      resetAt: parseReset(weekly?.nextResetTime ?? null),
    },
  });
}

export function opencodeGoQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const parsed = opencodeGoPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const rolling = parsed.data.usage?.rolling ?? null;
  const weekly = parsed.data.usage?.weekly ?? null;
  const monthly=parsed.data.usage?.monthly ?? null;
  const status=(value:string|null|undefined)=>value==='rate-limited'?'rejected':value==='ok'?'allowed':null;
  const monthlyUtilization=fraction(monthly?.percent);
  const monthlyStatus=status(monthly?.status);
  const rollingObserved=fraction(rolling?.percent)!==null||status(rolling?.status)!==null;
  const weeklyObserved=fraction(weekly?.percent)!==null||status(weekly?.status)!==null;
  if(fraction(rolling?.percent)===null&&fraction(weekly?.percent)===null&&monthlyUtilization===null&&status(rolling?.status)===null&&status(weekly?.status)===null&&monthlyStatus===null)return null;
  const additionalWindows:LimitWindow[]=monthlyUtilization!==null||monthlyStatus!==null
    ? [{slot:'secondary',windowMinutes:43200,utilization:monthlyUtilization,status:monthlyStatus,resetAt:parseReset(monthly?.resetsAt??null),observedAt:now,source:'usage'}]
    : previous.limitWindows.filter(window=>window.windowMinutes===43200&&window.source==='usage');
  return quota(accountId, previous, now, {
    fiveHour: {
      utilization: rollingObserved ? fraction(rolling?.percent) : previous.fiveHourUtilization,
      resetAt: rollingObserved ? parseReset(rolling?.resetsAt ?? null) : previous.fiveHourResetAt,
      status:rollingObserved ? status(rolling?.status) : previous.fiveHourStatus,
    },
    weekly: {
      utilization: weeklyObserved ? fraction(weekly?.percent) : previous.sevenDayUtilization,
      resetAt: weeklyObserved ? parseReset(weekly?.resetsAt ?? null) : previous.sevenDayResetAt,
      status:weeklyObserved ? status(weekly?.status) : previous.sevenDayStatus,
    },
  },additionalWindows);
}
