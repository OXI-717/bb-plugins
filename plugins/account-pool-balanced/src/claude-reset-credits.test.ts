import { describe, expect, it } from "vitest";
import { claudeResetCredits } from "./claude-reset-credits.js";

const NOW = Date.parse("2030-04-01T12:00:00Z");
const grant = {
  id: "synthetic-redemption-handle", label: "Launch reset", resets_left: 2,
  starts_at: "2030-03-01T00:00:00Z", ends_at: "2030-04-22T09:17:35Z",
  clears: ["five_hour", "seven_day"], paused: false,
  usable_now: false, use_requires_limit: true,
};

describe("Claude saved limit resets", () => {
  it("counts uses rather than offers, keeps exact expiry and drops redemption metadata", () => {
    const result = claudeResetCredits({ cedar_ember: { eligible: true, grants: [grant] } }, NOW);
    expect(result).toEqual({
      availableCount: 2, observedAt: NOW,
      credits: [{ title: "Launch reset", remaining: 2,
        expiresAt: Date.parse("2030-04-22T09:17:35Z"),
        limitTypes: ["five_hour", "seven_day"], usableNow: false, requiresLimit: true }],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-redemption-handle");
  });

  it("excludes exhausted, paused, expired and not-yet-started offers", () => {
    const grants = [
      { ...grant, resets_left: 0 }, { ...grant, paused: true },
      { ...grant, ends_at: new Date(NOW).toISOString() },
      { ...grant, starts_at: "2030-04-02T00:00:00Z" },
    ];
    expect(claudeResetCredits({ cedar_ember: { eligible: true, grants } }, NOW))
      .toEqual({ availableCount: 0, credits: [], observedAt: NOW });
  });

  it.each([
    {}, { cedar_ember: null },
    { cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] } },
    { cedar_ember: { eligible: true } },
    { cedar_ember: { eligible: true, grants: [{ ...grant, ends_at: "invalid" }] } },
    { cedar_ember: { eligible: true, grants: [{ ...grant, resets_left: -1 }] } },
  ])("reports unknown for unavailable or invalid metadata without inventing zero", (payload) => {
    expect(claudeResetCredits(payload, NOW)).toBeNull();
  });

  it("allows an explicit empty grant list and unspecified expiry", () => {
    expect(claudeResetCredits({ cedar_ember: { eligible: true, grants: [] } }, NOW)?.availableCount).toBe(0);
    expect(claudeResetCredits({ cedar_ember: { eligible: true, grants: [{ ...grant, ends_at: null }] } }, NOW)?.credits?.[0]?.expiresAt).toBeNull();
  });
});
