import { describe, expect, it, vi } from "vitest";
import { usagePlanLabel, usageWindowLabel,
  USAGE_PROVIDER_IDS, registerUsageSource,
} from "./usage-source.js";

import { usageListMethod, usageFetchMethod, type UsageResourceList, type UsageMeasurement } from "./usage-contract.js";
describe("usage presentation labels", () => {
  it("names known windows consistently and retains other durations", () => {
    expect(usageWindowLabel(10_080, "primary")).toBe("Weekly limit");
    expect(usageWindowLabel(300, "secondary")).toBe("Five-hour limit");
    expect(usageWindowLabel(43_200, "secondary")).toBe("Monthly limit");
    expect(usageWindowLabel(1_440, "primary")).toBe("Daily limit");
    expect(usageWindowLabel(2_880, "primary")).toBe("2 day limit");
    expect(usageWindowLabel(null, "Custom limit")).toBe("Custom limit");
  });
  it("retains known Max multipliers without inventing a missing tier", () => {
    expect(
      usagePlanLabel({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    ).toBe("Max (20x)");
    expect(
      usagePlanLabel({ subscriptionType: "max", rateLimitTier: null }),
    ).toBe("Max");
    expect(
      usagePlanLabel({ subscriptionType: "pro", rateLimitTier: null }),
    ).toBe("Pro");
    expect(
      usagePlanLabel({ subscriptionType: null, rateLimitTier: null }),
    ).toBeNull();
  });
});

describe("pooled providers on the usage surface", () => {
  it("names a BB provider for every pooled subscription", () => {
    // The map is exhaustive by type, but the values are ours: a wrong id puts the
    // subscription's windows under someone else's card, or under none at all.
    expect(USAGE_PROVIDER_IDS).toEqual({
      claude: "claude-code",
      codex: "codex",
      agy: "acp-agy",
      kimi: "acp-opencode-kimi",
      zai: "acp-opencode-zai",
      "opencode-go": "acp-opencode-go",
      neuraldeep: "acp-opencode-neuraldeep",
      cursor: "acp-oxi-cursor",
      devin: "acp-devin",
      grok: "acp-grok",
    });
    expect(new Set(Object.values(USAGE_PROVIDER_IDS)).size).toBe(
      Object.keys(USAGE_PROVIDER_IDS).length,
    );
  });
});

describe("compact Account Pooler usage inventory", () => {
  function fixture() {
    const common = {
      provider: "claude",
      subscriptionType: "max",
      rateLimitTier: null,
      accountUuid: null,
      limitWindows: [],
      familyWeekly: {},
      fiveHourUtilization: 1,
      fiveHourResetAt: null,
      sevenDayUtilization: null,
      observedAt: 1,
    };
    const exhausted = { ...common, id: "quota", label: "quota@example.test", email: "quota@example.test", enabled: true, eligible: false, status: "exhausted", error: null };
    const failed = { ...common, id: "error", label: "error@example.test", email: "error@example.test", enabled: true, eligible: false, status: "error", error: "synthetic failure" };
    const disabled = { ...exhausted, id: "off", label: "off@example.test", email: "off@example.test", enabled: false, status: "disabled" };
    const hub = {
      status: vi.fn(async () => ({ accounts: [exhausted, failed, disabled] })),
      assertNetworkAllowed: vi.fn(async () => {}),
      refreshUsage: vi.fn(async () => {}),
    };
    const register = vi.fn();
    registerUsageSource(
      { rpc: { register } } as unknown as Parameters<typeof registerUsageSource>[0],
      hub as unknown as Parameters<typeof registerUsageSource>[1],
      false,
    );
    const handlers = register.mock.calls[0]![1] as {
      [usageListMethod]: () => Promise<UsageResourceList>;
      [usageFetchMethod]: (input: { resourceId: string; refresh: boolean }) => Promise<UsageMeasurement>;
    };
    return { exhausted, failed, disabled, hub, list: handlers[usageListMethod], fetch: handlers[usageFetchMethod] };
  }

  it("preserves exhausted and error labels, an empty group, and re-enabled rows", async () => {
    const { exhausted, failed, disabled, list, fetch } = fixture();
    const labels = async () => (await list()).resources.map(row => row.label);
    expect(await labels()).toEqual(["quota@example.test", "error@example.test"]);
    await expect(fetch({ resourceId: exhausted.id, refresh: false })).resolves.toMatchObject({
      usage: { status: "ok", windows: [{ usedPercent: 100 }] },
    });
    await expect(fetch({ resourceId: failed.id, refresh: false })).resolves.toMatchObject({
      usage: { status: "error", accountEmail: "error@example.test" },
    });

    exhausted.enabled = false;
    failed.enabled = false;
    await expect(list()).resolves.toEqual({ label: "Account Pooler", resources: [] });

    disabled.enabled = true;
    disabled.status = "exhausted";
    expect(await labels()).toEqual(["off@example.test"]);
    await expect(fetch({ resourceId: disabled.id, refresh: false })).resolves.toMatchObject({
      usage: { status: "ok", accountEmail: "off@example.test" },
    });
  });

  it.each([false, true])("rejects a stale ID without collecting quota (refresh=%s)", async (refresh) => {
    const { disabled, hub, fetch } = fixture();
    await expect(fetch({ resourceId: disabled.id, refresh })).rejects.toThrow("Usage resource no longer exists.");
    expect(hub.assertNetworkAllowed).not.toHaveBeenCalled();
    expect(hub.refreshUsage).not.toHaveBeenCalled();
  });

  it("drops a measurement if the account is disabled during collection", async () => {
    const { exhausted, hub, fetch } = fixture();
    hub.refreshUsage.mockImplementationOnce(async () => { exhausted.enabled = false; });
    await expect(fetch({ resourceId: exhausted.id, refresh: true })).rejects.toThrow("Usage resource no longer exists.");
    expect(hub.refreshUsage).toHaveBeenCalledWith(exhausted.id, true, true);
  });
});
