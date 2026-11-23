import { providerEvidenceFromUsage } from './provider-budget.js';
import { z } from "zod";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota, type LimitWindow } from "./contracts.js";
import { parseReset } from "./quota.js";
import { zaiEvidenceFromUsages } from './zai-budget.js';

const ZAI_FIVE_HOUR_UNIT = 3;
const ZAI_WEEKLY_UNIT = 6;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function zaiUsageRejected(payload: unknown): boolean {
  const root = record(payload);
  return root !== null && (
    root.success === false || root.error != null ||
    (root.code != null && root.code !== 200 && root.code !== "200")
  );
}

// Only fixed field names and type categories leave the backend. Do not include
// arbitrary object keys, values, upstream messages, or validation error text.
export function zaiUsageShape(payload: unknown): string {
  const kind = (value: unknown): string => value === null ? "null"
    : Array.isArray(value) ? "array" : typeof value;
  const root = record(payload);
  if (root === null) return `root=${kind(payload)}`;
  const data = record(root.data);
  const limits = data?.limits;
  const shape = [`code=${kind(root.code)}`, `success=${kind(root.success)}`,
    `error=${kind(root.error)}`, `data=${kind(root.data)}`, `limits=${kind(limits)}`];
  if (Array.isArray(limits)) {
    // Bound the output even if a response carries an unexpectedly large list.
    shape.push(`rows=${Math.min(limits.length, 1000)}`);
    for (const value of limits.slice(0, 4)) {
      const row = record(value);
      shape.push(row === null ? `row=${kind(value)}` : `row(${[
        "type", "unit", "number", "percentage", "currentValue", "usage", "nextResetTime",
      ].map(key => `${key}=${kind(row[key])}`).join(",")})`);
    }
  }
  return shape.join("; ");
}

function zaiFraction(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? percent / 100 : null;
}

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

export function zaiSubscriptionType(payload: unknown): "lite" | "pro" | "max" | null {
  const level = record(record(payload)?.data)?.level;
  if (typeof level !== "string") return null;
  const normalized = level.toLowerCase();
  return normalized === "lite" || normalized === "pro" || normalized === "max"
    ? normalized : null;
}

export function zaiQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  if (zaiUsageRejected(payload)) return null;
  const parsed = zaiPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const rows = parsed.data.data?.limits ?? [];
  const credits = rows.filter((row) => row.type === "CREDIT_LIMIT");
  const tokens = rows.filter((row) => row.type === "TOKENS_LIMIT");
  // Support only observed credit unit/number pairs, interpreted using documented
  // plan windows and legacy units; their duration was not independently measured.
  // Mixed/duplicate windows are ambiguous; preserve the previous observation.
  if (credits.length > 0 && (tokens.length > 0 || credits.some((row) =>
    !((row.unit === ZAI_FIVE_HOUR_UNIT && row.number === 5) ||
      (row.unit === ZAI_WEEKLY_UNIT && row.number === 1))) ||
    new Set(credits.map((row) => row.unit)).size !== credits.length)) return null;
  const windows = credits.length > 0 ? credits : tokens;
  const byUnit = (unit: number) =>
    windows.find((row) => row.unit === unit) ?? null;
  const fiveHour = byUnit(ZAI_FIVE_HOUR_UNIT);
  const weekly = byUnit(ZAI_WEEKLY_UNIT);
  if (fiveHour === null && weekly === null) return null;
  if ((fiveHour !== null && zaiFraction(fiveHour.percentage) === null) ||
      (weekly !== null && zaiFraction(weekly.percentage) === null)) return null;
  const normalized = quota(accountId, previous, now, {
    fiveHour: {
      utilization: fiveHour === null ? previous.fiveHourUtilization : zaiFraction(fiveHour.percentage),
      resetAt: fiveHour === null ? previous.fiveHourResetAt : parseReset(fiveHour.nextResetTime ?? null),
      status: fiveHour === null ? previous.fiveHourStatus : null,
    },
    weekly: {
      utilization: weekly === null ? previous.sevenDayUtilization : zaiFraction(weekly.percentage),
      resetAt: weekly === null ? previous.sevenDayResetAt : parseReset(weekly.nextResetTime ?? null),
      status: weekly === null ? previous.sevenDayStatus : null,
    },
  });
  return normalized === null ? null : {...normalized,zaiUsageEvidence:zaiEvidenceFromUsages(payload,now)};
}

export function grokQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const config = record(record(payload)?.config);
  if (config === null) return null;
  const product = Array.isArray(config.productUsage) ? record(config.productUsage[0]) : null;
  const raw = config.creditUsagePercent ?? product?.usagePercent;
  const expiredReset =
    previous.sevenDayResetAt !== null && previous.sevenDayResetAt <= now;
  const percent =
    raw === undefined || raw === null
      ? expiredReset
        ? 0
        : NaN
      : Number(raw);
  if (!Number.isFinite(percent)) return null;
  const period = record(config.currentPeriod);
  const reset = period?.end ?? config.billingPeriodEnd ?? null;
  return quota(accountId, previous, now, {
    fiveHour: {
      utilization: previous.fiveHourUtilization,
      resetAt: previous.fiveHourResetAt,
      status: previous.fiveHourStatus,
    },
    weekly: {
      utilization: Math.min(Math.max(percent / 100, 0), 1),
      resetAt: parseReset(typeof reset === "number" || typeof reset === "string" ? reset : null),
      status: null,
    },
  });
}

export function geminiQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const buckets = record(payload)?.buckets;
  if (!Array.isArray(buckets)) return null;
  const valid = buckets
    .map(record)
    .filter((bucket): bucket is Record<string, unknown> =>
      bucket !== null &&
      typeof bucket.remainingFraction === "number" &&
      Number.isFinite(bucket.remainingFraction));
  const gemini = valid.filter((bucket) =>
    typeof bucket.modelId === "string" && bucket.modelId.startsWith("gemini-"));
  const pool = gemini.length > 0 ? gemini : valid;
  const bucket = pool.reduce<Record<string, unknown> | null>((best, item) => {
    if (best === null) return item;
    return (item.remainingFraction as number) < (best.remainingFraction as number) ? item : best;
  }, null);
  if (bucket === null) return null;
  const reset = bucket.resetTime;
  return quota(accountId, previous, now, {
    fiveHour: {
      utilization: Math.min(Math.max(1 - (bucket.remainingFraction as number), 0), 1),
      resetAt: parseReset(typeof reset === "number" || typeof reset === "string" ? reset : null),
      status: null,
    },
    weekly: {
      utilization: previous.sevenDayUtilization,
      resetAt: previous.sevenDayResetAt,
      status: previous.sevenDayStatus,
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
  const normalized=quota(accountId, previous, now, {
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
  return normalized===null?null:{...normalized,providerBudgetEvidence:providerEvidenceFromUsage('opencode-go',payload,now)};
}
