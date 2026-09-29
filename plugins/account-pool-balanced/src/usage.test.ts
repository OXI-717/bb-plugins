import { expect, it } from "vitest";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import { quotaFromUsage } from "./usage.js";

it("clears an old five-hour reset when fresh Claude usage omits its date", () => {
  const previous: AccountQuota = {
    accountId: "11111111-1111-4111-8111-111111111111",
    fiveHourUtilization: 0.8,
    fiveHourResetAt: 1_000,
    fiveHourStatus: "allowed",
    sevenDayUtilization: 0.5,
    sevenDayResetAt: 5_000,
    sevenDayStatus: "allowed",
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: 900,
    heldUntil: null,
    error: null,
  };
  const refreshed = quotaFromUsage(previous.accountId, {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 50, resets_at: 10 },
  }, previous, 2_000);
  expect(refreshed).toMatchObject({
    fiveHourUtilization: 0,
    fiveHourResetAt: null,
    sevenDayResetAt: 10_000,
  });
});
