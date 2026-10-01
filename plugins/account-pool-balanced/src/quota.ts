import type { QuotaThresholds } from "./account-policy.js";
import type {
  Account,
  AccountQuota,
  AccountSummary,
  FamilyQuota,
  LimitWindow,
  ModelFamily,
} from "./contracts.js";

const PREFIX = "anthropic-ratelimit-unified-";
const SCOPED_HEADER =
  /^anthropic-ratelimit-unified-7d_(.+)-(utilization|reset|status)$/u;

interface ScopedHeaderValues {
  utilization: number | null;
  resetAt: number | null;
  status: string | null;
}

function parseNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function epochMilliseconds(value: number): number {
  return Math.round(value < 1_000_000_000_000 ? value * 1_000 : value);
}

export function parseReset(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return epochMilliseconds(value);
  }
  if (value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return epochMilliseconds(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function modelFamily(model: string | null): ModelFamily {
  if (model === null) return "other";
  const normalized = model.toLowerCase();
  if (normalized.includes("fable")) return "fable";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  return "other";
}

function scopedHeaderValues(headers: Headers): ScopedHeaderValues | null {
  const buckets = new Map<string, ScopedHeaderValues>();
  for (const [name, value] of headers) {
    const match = SCOPED_HEADER.exec(name.toLowerCase());
    const bucket = match?.[1];
    const field = match?.[2];
    if (bucket === undefined || field === undefined) continue;
    const current = buckets.get(bucket) ?? {
      utilization: null,
      resetAt: null,
      status: null,
    };
    if (field === "utilization") current.utilization = parseNumber(value);
    if (field === "reset") current.resetAt = parseReset(value);
    if (field === "status") current.status = value;
    buckets.set(bucket, current);
  }
  return [...buckets.values()][0] ?? null;
}

export function quotaFromHeaders(
  accountId: string,
  headers: Headers,
  previous: AccountQuota,
  family: ModelFamily,
  now: number,
): AccountQuota {
  const fiveHourUtilization = parseNumber(
    headers.get(`${PREFIX}5h-utilization`),
  );
  const fiveHourResetAt = parseReset(headers.get(`${PREFIX}5h-reset`));
  const fiveHourStatus = headers.get(`${PREFIX}5h-status`);
  const sevenDayUtilization = parseNumber(
    headers.get(`${PREFIX}7d-utilization`),
  );
  const sevenDayResetAt = parseReset(headers.get(`${PREFIX}7d-reset`));
  const sevenDayStatus = headers.get(`${PREFIX}7d-status`);
  const representativeClaim = headers.get(`${PREFIX}representative-claim`);
  const scoped = scopedHeaderValues(headers);
  const priorFamily = previous.familyWeekly[family];
  const familyWeekly: AccountQuota["familyWeekly"] =
    scoped === null
      ? previous.familyWeekly
      : {
          ...previous.familyWeekly,
          [family]: {
            utilization: scoped.utilization ?? priorFamily?.utilization ?? null,
            resetAt: scoped.resetAt ?? priorFamily?.resetAt ?? null,
            status: scoped.status ?? priorFamily?.status ?? null,
            observedAt: now,
            source: "header",
          },
        };
  const observed =
    fiveHourUtilization !== null ||
    fiveHourResetAt !== null ||
    fiveHourStatus !== null ||
    sevenDayUtilization !== null ||
    sevenDayResetAt !== null ||
    sevenDayStatus !== null ||
    representativeClaim !== null ||
    scoped !== null;
  return {
    accountId,
    fiveHourUtilization: fiveHourUtilization ?? previous.fiveHourUtilization,
    fiveHourResetAt: fiveHourResetAt ?? previous.fiveHourResetAt,
    fiveHourStatus: fiveHourStatus ?? previous.fiveHourStatus,
    sevenDayUtilization: sevenDayUtilization ?? previous.sevenDayUtilization,
    sevenDayResetAt: sevenDayResetAt ?? previous.sevenDayResetAt,
    sevenDayStatus: sevenDayStatus ?? previous.sevenDayStatus,
    representativeClaim: representativeClaim ?? previous.representativeClaim,
    familyWeekly,
    limitWindows: previous.limitWindows,
    observedAt: observed ? now : previous.observedAt,
    heldUntil: previous.heldUntil,
    error: previous.error,
  };
}

function activeWindow(
  utilization: number | null,
  status: string | null,
  resetAt: number | null,
  threshold: number,
  now: number,
): boolean {
  if (resetAt !== null && resetAt <= now) return false;
  return (
    status?.toLowerCase() === "rejected" ||
    (utilization !== null && utilization >= threshold)
  );
}

function activeFamilyWindow(
  quota: FamilyQuota | null,
  threshold: number,
  now: number,
): boolean {
  return (
    quota !== null &&
    activeWindow(quota.utilization, quota.status, quota.resetAt, threshold, now)
  );
}

function thresholdFor(threshold: number | QuotaThresholds, minutes?: number | null): number {
  if (typeof threshold === 'number') return threshold;
  return minutes === 300 ? threshold.fiveHour : minutes === 10080 ? threshold.weekly : threshold.other;
}

export function blockingResetAt(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
  threshold: number | QuotaThresholds,
  now: number,
): number | null {
  let latest: number | null = null;
  let unknown = false;
  const include = (
    utilization: number | null,
    status: string | null,
    resetAt: number | null,
    minutes?: number | null,
  ) => {
    if (!activeWindow(utilization, status, resetAt, thresholdFor(threshold, minutes), now)) return;
    if (resetAt === null) unknown = true;
    else latest = Math.max(latest ?? resetAt, resetAt);
  };
  include(
    quota.fiveHourUtilization,
    quota.fiveHourStatus,
    quota.fiveHourResetAt,
    300,
  );
  include(
    quota.sevenDayUtilization,
    quota.sevenDayStatus,
    quota.sevenDayResetAt,
    10080,
  );
  for (const window of quota.limitWindows)
    include(window.utilization, window.status, window.resetAt, window.windowMinutes);
  if (family !== null) {
    const familyQuota = quota.familyWeekly[family];
    if (familyQuota !== null)
      include(familyQuota.utilization, familyQuota.status, familyQuota.resetAt, 10080);
  }
  return unknown ? null : latest;
}

export function isSharedQuotaExhausted(
  quota: AccountQuota,
  threshold: number | QuotaThresholds,
  now: number,
): boolean {
  return (
    activeWindow(
      quota.fiveHourUtilization,
      quota.fiveHourStatus,
      quota.fiveHourResetAt,
      thresholdFor(threshold, 300),
      now,
    ) ||
    activeWindow(
      quota.sevenDayUtilization,
      quota.sevenDayStatus,
      quota.sevenDayResetAt,
      thresholdFor(threshold, 10080),
      now,
    ) ||
    quota.limitWindows.some((window) =>
      activeWindow(
        window.utilization,
        window.status,
        window.resetAt,
        thresholdFor(threshold, window.windowMinutes),
        now,
      ),
    )
  );
}

export function longestLimitWindow(
  windows: readonly LimitWindow[],
): LimitWindow | null {
  let longest: LimitWindow | null = null;
  for (const window of windows) {
    if (
      longest === null ||
      (window.windowMinutes ?? 0) > (longest.windowMinutes ?? 0)
    )
      longest = window;
  }
  return longest;
}

export function isQuotaExhausted(
  quota: AccountQuota,
  family: ModelFamily,
  threshold: number | QuotaThresholds,
  now: number,
): boolean {
  return (
    isSharedQuotaExhausted(quota, threshold, now) ||
    activeFamilyWindow(quota.familyWeekly[family], thresholdFor(threshold, 10080), now)
  );
}

export function isQuotaRejection(headers: Headers): boolean {
  for (const [name, value] of headers) {
    if (value.toLowerCase() !== "rejected") continue;
    const normalized = name.toLowerCase();
    if (
      normalized === `${PREFIX}5h-status` ||
      normalized === `${PREFIX}7d-status` ||
      SCOPED_HEADER.test(normalized)
    )
      return true;
  }
  return false;
}

export function governingWeeklyResetAt(
  quota: AccountQuota,
  family: ModelFamily,
): number | null {
  return (
    quota.familyWeekly[family]?.resetAt ??
    quota.sevenDayResetAt ??
    longestLimitWindow(quota.limitWindows)?.resetAt ??
    null
  );
}

export function accountStatus(
  account: Account,
  quota: AccountQuota,
  threshold: number | QuotaThresholds,
  now: number,
): AccountSummary["status"] {
  if (!account.enabled) return "disabled";
  if (quota.error !== null) return "error";
  if (quota.heldUntil !== null && quota.heldUntil > now) return "held";
  if (isSharedQuotaExhausted(quota, threshold, now)) return "exhausted";
  return "ready";
}

export function retryAfterMilliseconds(
  value: string | null,
  now: number,
): number {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1_000 : Math.max(0, date - now);
}
