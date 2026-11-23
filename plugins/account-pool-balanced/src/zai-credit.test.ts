import { afterEach, describe, expect, it, vi } from "vitest";
import { accountPoolConfigSchema, EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import { createOpenAiCompatibleAdapter } from "./openai-compatible-adapter.js";
import { zaiQuotaFromUsages, zaiSubscriptionType } from "./openai-compatible-usage.js";

import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AccountStore, PoolAffinityStore, QuotaStore, QUOTA_MIGRATIONS } from "./store.js";
import { createHub } from "./hub.js";
import { registerUsageSource } from "./usage-source.js";
import { usageFetchMethod, usageMeasurementSchema } from "./usage-contract.js";
import { isSharedQuotaExhausted } from "./quota.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const RESET = NOW + 86400000;
// Synthetic counters and time; only the allowlisted response shape is retained.
const creditPayload = () => ({ code: 200, success: true, data: { level: "lite", limits: [
  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 0, currentValue: 0, usage: 200, remaining: 200 },
  { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100, currentValue: 1004, usage: 1000, remaining: 0, nextResetTime: RESET },
] } });
const blank = (): AccountQuota => ({ accountId: "synthetic", fiveHourUtilization: null,
  fiveHourResetAt: null, fiveHourStatus: null, sevenDayUtilization: null,
  sevenDayResetAt: null, sevenDayStatus: null, representativeClaim: null,
  familyWeekly: EMPTY_FAMILY_WEEKLY, limitWindows: [], observedAt: null, heldUntil: null, error: null });

describe("observed credit shape", () => {
  it("reads both credit windows using percentages rather than counter ratios", () => {
    expect(zaiQuotaFromUsages("synthetic", creditPayload(), blank(), NOW)).toMatchObject({
      fiveHourUtilization: 0, fiveHourResetAt: null,
      sevenDayUtilization: 1, sevenDayResetAt: RESET, observedAt: NOW,
    });
  });
});


describe("credit mapping and partial observations", () => {
  it.each([[3, 1], [6, 5], [4, 1], [3, undefined], [3, "5"]])(
    "rejects an unmeasured credit duration %s/%s", (unit, number) => {
      const payload = { data: { limits: [{ type: "CREDIT_LIMIT", unit, number, percentage: 0 }] } };
      expect(zaiQuotaFromUsages("synthetic", payload, blank(), NOW)).toBeNull();
    });
  it.each(["CREDIT_LIMIT", "TOKENS_LIMIT"])("rejects conflicting %s rows", type => {
    const payload = creditPayload();
    payload.data.limits.push({ ...payload.data.limits[0]!, type });
    expect(zaiQuotaFromUsages("synthetic", payload, blank(), NOW)).toBeNull();
  });
  it.each(["TIME_LIMIT", "credit_limit", "OTHER"])("does not treat %s as quota", type => {
    const payload = creditPayload();
    payload.data.limits.forEach(row => { row.type = type; });
    expect(zaiQuotaFromUsages("synthetic", payload, blank(), NOW)).toBeNull();
  });
  it("preserves a missing cached rejection but clears an absent reset on a present row", () => {
    const prior = { ...blank(), sevenDayUtilization: 1, sevenDayResetAt: RESET,
      sevenDayStatus: "rejected" as const, fiveHourResetAt: RESET };
    const payload = creditPayload();
    payload.data.limits.pop();
    expect(zaiQuotaFromUsages("synthetic", payload, prior, NOW)).toMatchObject({
      fiveHourUtilization: 0, fiveHourResetAt: null, sevenDayUtilization: 1,
      sevenDayResetAt: RESET, sevenDayStatus: "rejected",
    });
  });
  it.each([null, undefined, "", "bad", -1, 101])("rejects invalid percentage %s", percentage => {
    const payload = creditPayload();
    const malformed = { ...payload, data: { ...payload.data, limits: [{ ...payload.data.limits[0], percentage }] } };
    expect(zaiQuotaFromUsages("synthetic", malformed, blank(), NOW)).toBeNull();
  });
});


describe("finite provider-reported plan", () => {
  it.each(["lite", "PRO", "Max"])("normalizes %s", level => {
    expect(zaiSubscriptionType({ data: { level } })).toBe(level.toLowerCase());
  });
  it.each([undefined, null, "enterprise", "lite private", 3, {}, ""])("leaves unknown %s unlabelled", level => {
    expect(zaiSubscriptionType({ data: { level } })).toBeNull();
  });
});


// Real production stores and hub, backed exclusively by isolated fake-host storage.


const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function vertical(provider: "zai" | "opencode-go" = "zai") {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "synthetic-zai-credit-"));
  const host = createFakePluginHost({ pluginId: "account-pool-balanced", dataDir });
  cleanups.push(async () => { await host.harness.lifecycle.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const kv = host.bb.storage.kv;
  const writes = vi.spyOn(kv, "set");
  const accounts = new AccountStore(kv, path.join(dataDir, "secrets"));
  await accounts.initialize();
  const account = await accounts.add({ provider, kind: "api-key", label: "Synthetic",
    email: null, accountUuid: null, subscriptionType: null,
    rateLimitTier: "default_claude_max_20x", enabled: true, priority: 100 }, { kind: "api-key", apiKey: "synthetic-only" });
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
  const quotas = new QuotaStore(db);
  let response = () => Response.json(creditPayload());
  const fetcher = vi.fn(async () => response());
  const hub = createHub({ route: "/synthetic", accounts, quotas, affinity: new PoolAffinityStore(db),
    hubTokens: { authenticate: async () => null, list: async () => [] },
    getSettings: () => accountPoolConfigSchema.parse({ vpnGuardEnabled: false, requireVerifiedVpn: false }),
    fetch: fetcher, now: () => NOW });
  let handlers: Record<string, (input: { resourceId: string; refresh: boolean }) => Promise<unknown>>;
  registerUsageSource({ rpc: { register: (_contract: unknown, methods: typeof handlers) => { handlers = methods; } } } as unknown as BbPluginApi, hub, false);
  writes.mockClear();
  return { account, accounts, quotas, writes, fetcher,
    respond: (next: () => Response) => { response = next; },
    status: () => hub.status(),
    refresh: async () => usageMeasurementSchema.parse(await handlers[usageFetchMethod]!({ resourceId: account.id, refresh: true })) };
}

describe("Z.AI refresh through stored state and native Provider usage", () => {
  it("exposes Lite and 0/100 without counter multiplication or extra account mutations", async () => {
    const state = await vertical();
    const before = await state.accounts.get(state.account.id);
    const result = await state.refresh();
    expect(result).toMatchObject({ observedAt: NOW, usage: { status: "ok", plan: { id: "lite", multiplier: null }, planLabel: "Lite",
      windows: [ { usedPercent: 0, resetsAt: null, cost: null }, { usedPercent: 100, resetsAt: new Date(RESET).toISOString(), cost: null } ] } });
    expect(await state.accounts.get(state.account.id)).toEqual({ ...before, subscriptionType: "lite" });
    expect(state.writes).toHaveBeenCalledTimes(1);
    expect(isSharedQuotaExhausted(state.quotas.get(state.account.id), 1, NOW)).toBe(true);
    await state.refresh();
    expect(state.writes).toHaveBeenCalledTimes(1);
    expect(state.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, "unknown", null])("clears a stale label only on valid quota with level %s", async level => {
    const state = await vertical();
    await state.refresh();
    const payload = creditPayload();
    state.respond(() => Response.json({ ...payload, data: { ...payload.data, level } }));
    expect(await state.refresh()).toMatchObject({ usage: { status: "ok", plan: null, planLabel: null } });
    expect((await state.accounts.get(state.account.id))?.subscriptionType).toBeNull();
    expect(state.writes).toHaveBeenCalledTimes(2);
  });
  it.each([
    () => new Response("synthetic-private", { status: 403 }),
    () => new Response("not json"),
    () => Response.json({ code: 401, data: creditPayload().data }),
    () => Response.json({ data: { level: "max", limits: [] } }),
    () => Response.json({ data: { level: "max", limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 1, percentage: 0 }] } }),
  ])("preserves measured plan/quota on a failed refresh", async response => {
    const state = await vertical();
    await state.refresh();
    const prior = state.quotas.get(state.account.id);
    state.respond(response);
    await expect(state.refresh()).rejects.toThrow("Z.AI quota collection failed");
    expect((await state.accounts.get(state.account.id))?.subscriptionType).toBe("lite");
    expect(state.writes).toHaveBeenCalledTimes(1);
    expect(state.quotas.get(state.account.id)).toMatchObject({ ...prior, error: expect.any(String) });
  });
  it("keeps legacy support and writes no plan for an unknown level", async () => {
    const state = await vertical();
    state.respond(() => Response.json({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 0 }] } }));
    expect(await state.refresh()).toMatchObject({ usage: { status: "ok", plan: null, planLabel: null, windows: [{ usedPercent: 0, resetsAt: null }] } });
    expect(state.writes).not.toHaveBeenCalled();
  });
  it("serializes metadata alongside another account update and ignores other providers", async () => {
    const state = await vertical();
    await Promise.all([state.accounts.setZaiSubscriptionType(state.account.id, "max"), state.accounts.setAccountUuid(state.account.id, "11111111-1111-4111-8111-111111111111")]);
    expect(await state.accounts.get(state.account.id)).toMatchObject({ subscriptionType: "max", accountUuid: "11111111-1111-4111-8111-111111111111" });
    const other = await state.accounts.add({ ...state.account, provider: "codex" }, { kind: "api-key", apiKey: "synthetic-other" });
    state.writes.mockClear();
    await state.accounts.setZaiSubscriptionType(other.id, "lite");
    expect((await state.accounts.get(other.id))?.subscriptionType).toBeNull();
    expect(state.writes).not.toHaveBeenCalled();
  });
});

describe("Z.AI persisted network quota retry", () => {
  it("makes a fresh request after a persisted quota network failure", async () => {
    const state = await vertical();
    state.respond(() => { throw new Error("synthetic network failure"); });
    await expect(state.refresh()).rejects.toThrow("Network request did not complete");
    expect(state.quotas.get(state.account.id).error).toContain("Network request did not complete");
    expect((await state.status()).accounts.find(a => a.id === state.account.id)).toMatchObject({ status: "error", eligible: false });
    state.fetcher.mockClear();
    state.respond(() => {
      const payload = creditPayload();
      payload.data.limits[1]!.percentage = 0;
      return Response.json(payload);
    });
    let result: unknown;
    try { result = await state.refresh(); } catch { /* The HTTP count identifies the pre-fetch guard regression. */ }
    expect(state.fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ usage: { status: "ok", planLabel: "Lite" } });
    expect((await state.status()).accounts.find(a => a.id === state.account.id)).toMatchObject({ status: "ready", eligible: true, error: null });
  });
});

describe("Z.AI quota retry boundaries", () => {
  it("recovers the exact legacy network error only after a valid measurement", async () => {
    const state = await vertical();
    state.quotas.put({ ...state.quotas.get(state.account.id), error: "Z.AI quota collection failed: Network request did not complete." });
    state.respond(() => Response.json({ data: { limits: [] } }));
    await expect(state.refresh()).rejects.toThrow("no supported quota");
    expect(state.fetcher).toHaveBeenCalledTimes(1);
    expect((await state.status()).accounts.find(a => a.id === state.account.id)).toMatchObject({ status: "error", eligible: false });
  });
  it.each([
    "Z.AI quota collection failed: HTTP 200; application rejected the request; code=number; success=boolean; error=undefined; data=undefined; limits=undefined.",
    "Z.AI quota collection failed: HTTP 200; no supported quota measurement; code=number; success=boolean; error=undefined; data=object; limits=array; rows=0.",
    "Z.AI quota collection failed: HTTP 429.",
    "Z.AI quota collection failed: HTTP 500.",
    "Z.AI quota collection failed: HTTP 503.",
  ])("retries quota collection after persisted transient/application error %s while keeping routing ineligible until recovery", async error => {
    const state = await vertical();
    state.quotas.put({ ...state.quotas.get(state.account.id), error });
    expect((await state.status()).accounts.find(a => a.id === state.account.id)).toMatchObject({ status: "error", eligible: false });
    state.respond(() => {
      const payload = creditPayload();
      payload.data.limits[1]!.percentage = 0;
      return Response.json(payload);
    });
    await expect(state.refresh()).resolves.toMatchObject({ usage: { status: "ok", planLabel: "Lite" } });
    expect(state.fetcher).toHaveBeenCalledTimes(1);
    expect((await state.status()).accounts.find(a => a.id === state.account.id)).toMatchObject({ status: "ready", eligible: true, error: null });
  });
  it("disables refreshesApiKeyUsage when collectUsage is false", () => {
    const nvidia = createOpenAiCompatibleAdapter({
      provider: "nvidia",
      upstreamName: "NVIDIA NIM",
      mountPrefix: "nvidia/",
      upstreamBaseUrl: () => "https://integrate.api.nvidia.com/v1",
      usagesUrl: "https://integrate.api.nvidia.com/v1/models",
      collectUsage: false,
      parseUsages: () => null,
    });
    expect(nvidia.refreshesApiKeyUsage).toBe(false);
  });
  it.each([
    "Z.AI quota collection failed: HTTP 401.",
    "Z.AI quota collection failed: HTTP 403.",
    "Authorization required",
    "Z.AI quota collection failed: HTTP 200; invalid JSON.",
    "Z.AI quota collection failed: Network request did not complete. extra",
  ])("continues blocking the stored non-transient error %s", async error => {
    const state = await vertical();
    state.quotas.put({ ...state.quotas.get(state.account.id), error });
    await expect(state.refresh()).rejects.toThrow(error);
    expect(state.fetcher).not.toHaveBeenCalled();
    expect(state.quotas.get(state.account.id).error).toBe(error);
    expect((await state.status()).accounts.find(a => a.id === state.account.id)).toMatchObject({ status: "error", eligible: false });
  });
});

it("recovers an exact persisted legacy Z.AI network failure", async () => {
  const state = await vertical();
  state.quotas.put({ ...state.quotas.get(state.account.id), error: "Z.AI quota collection failed: Network request did not complete." });
  await expect(state.refresh()).resolves.toMatchObject({ usage: { status: "ok" } });
  expect(state.fetcher).toHaveBeenCalledTimes(1);
  expect(state.quotas.get(state.account.id).error).toBeNull();
});
it("does not reinterpret another provider's stored errors as retryable Z.AI quota failures", async () => {
  const state = await vertical("opencode-go");
  const error = "Z.AI quota collection failed: Network request did not complete.";
  state.quotas.put({ ...state.quotas.get(state.account.id), error });
  await expect(state.refresh()).rejects.toThrow(error);
  expect(state.fetcher).not.toHaveBeenCalled();
  expect((await state.status()).accounts.find(a => a.id === state.account.id)).toMatchObject({ status: "error", eligible: false });
});
