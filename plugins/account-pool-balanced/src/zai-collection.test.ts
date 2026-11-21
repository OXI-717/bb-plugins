import { describe, expect, it, vi } from "vitest";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import type { AdapterUsageContext } from "./provider-adapter.js";
import { createOpenAiCompatibleAdapter } from "./openai-compatible-adapter.js";
import { zaiQuotaFromUsages, zaiUsageShape } from "./openai-compatible-usage.js";
import { isSharedQuotaExhausted } from "./quota.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AccountPoolHub } from "./hub.js";
import { registerUsageSource } from "./usage-source.js";
import { usageFetchMethod, usageListMethod, usageMeasurementSchema } from "./usage-contract.js";
import { registerPoolCli } from "./cli.js";

const NOW = Date.parse("2026-10-28T00:00:00Z");
const blank = (): AccountQuota => ({
  accountId: "synthetic-account", fiveHourUtilization: null, fiveHourResetAt: null,
  fiveHourStatus: null, sevenDayUtilization: null, sevenDayResetAt: null,
  sevenDayStatus: null, representativeClaim: null, familyWeekly: EMPTY_FAMILY_WEEKLY,
  limitWindows: [], observedAt: null, heldUntil: null, error: null,
});
const payload = (percentage: unknown) => ({ code: 200, success: true,
  data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage }] } });

function setup(response: Response | Error, provider: "zai" | "opencode-go" = "zai") {
  let stored = blank();
  const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  const put = vi.fn((quota: AccountQuota) => { stored = quota; });
  const context = {
    account: { id: stored.accountId }, accounts: { setZaiSubscriptionType: vi.fn(async () => null) },
    freshSecret: async () => ({ kind: "api-key", apiKey: "synthetic-secret" }),
    quotas: { get: () => stored, put }, fetch: fetcher, now: () => NOW,
  } as unknown as AdapterUsageContext;
  const adapter = createOpenAiCompatibleAdapter({ provider, upstreamName: "Synthetic",
    mountPrefix: `${provider}/`, upstreamBaseUrl: () => "https://example.test/v1",
    usagesUrl: "https://example.test/quota", parseUsages: zaiQuotaFromUsages });
  return { context, adapter, fetcher, put, stored: () => stored };
}

describe("Z.AI collection failure visibility", () => {
  it.each([401, 403, 429, 500])("reports HTTP %i without upstream content", async status => {
    const state = setup(new Response("synthetic-private-value", { status }));
    await expect(state.adapter.refreshUsage(state.context)).rejects.toThrow(`HTTP ${status}`);
    expect(state.stored()).toMatchObject({ observedAt: null });
    expect(state.stored().error).not.toContain("synthetic-private-value");
    expect(state.stored().error).not.toContain("synthetic-secret");
  });
  it.each([
    ["invalid JSON", () => new Response("synthetic-private-value")],
    ["application rejected", () => Response.json({ code: 401, msg: "synthetic-private-value" })],
    ["application rejected", () => Response.json({ success: false, data: payload(0).data })],
    ["no supported quota", () => Response.json({ code: 200, data: { limits: [] } })],
    ["no supported quota", () => Response.json({ code: 200, data: { limits: [{ type: "UNKNOWN_CREDIT", unit: 3, percentage: 20 }] } })],
  ] as const)("reports %s on HTTP 200", async (message, response) => {
    const state = setup(response());
    await expect(state.adapter.refreshUsage(state.context)).rejects.toThrow(message);
    expect(state.stored().observedAt).toBeNull();
    expect(state.stored().error).not.toContain("synthetic-private-value");
  });
  it("redacts network errors and preserves a previous observation", async () => {
    const state = setup(new Error("synthetic-secret"));
    state.context.quotas.put({ ...blank(), fiveHourUtilization: 1, observedAt: NOW - 1000 });
    await expect(state.adapter.refreshUsage(state.context)).rejects.toThrow("Network request did not complete");
    expect(state.stored()).toMatchObject({ fiveHourUtilization: 1, observedAt: NOW - 1000 });
    expect(state.stored().error).not.toContain("synthetic-secret");
  });
  it("clears the error only on a measured response and retains existing authorization", async () => {
    const state = setup(Response.json(payload(0)));
    state.context.quotas.put({ ...blank(), error: "previous error" });
    await state.adapter.refreshUsage(state.context);
    expect(state.stored()).toMatchObject({ fiveHourUtilization: 0, observedAt: NOW, error: null });
    const init = state.fetcher.mock.calls[0]![1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-secret");
    const inferenceHeaders = state.adapter.requestHeaders(new Headers(), state.context.account,
      { kind: "api-key", apiKey: "synthetic-secret" });
    expect(inferenceHeaders.get("authorization")).toBe("Bearer synthetic-secret");
  });
  it("leaves the other compatible provider's HTTP handling unchanged", async () => {
    const state = setup(new Response("", { status: 500 }), "opencode-go");
    await expect(state.adapter.refreshUsage(state.context)).resolves.toBeUndefined();
    expect(state.put).not.toHaveBeenCalled();
  });
  it("emits only fixed structural fields and types, with bounded rows", () => {
    const shape = zaiUsageShape({ "synthetic-private-key": "secret", code: "secret",
      data: { limits: Array.from({ length: 20 }, () => ({ type: "secret", percentage: "secret" })) } });
    expect(shape).toContain("code=string");
    expect(shape).toContain("percentage=string");
    expect(shape).not.toContain("secret");
    expect(shape).not.toContain("synthetic-private-key");
    expect(shape.match(/row\(/g)).toHaveLength(4);
  });
  it("makes the native CLI fail instead of printing Refreshed without a measurement", async () => {
    const state = setup(new Response("synthetic-private-value", { status: 401 }));
    let command: Parameters<BbPluginApi["cli"]["register"]>[0];
    const args = [{ cli: { register: (definition: typeof command) => { command = definition; } } },
      { refreshUsage: async () => { await state.adapter.refreshUsage(state.context); return {}; } },
      {}, {}, {}] as unknown as Parameters<typeof registerPoolCli>;
    registerPoolCli(...args);
    const result = await command!.run!(["account", "refresh", "3f2c0b74-91aa-4c2e-8a1e-7b6d5c4e3a22"],
      {} as Parameters<NonNullable<typeof command.run>>[1]);
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("HTTP 401") });
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).not.toContain("synthetic-private-value");
  });
});

describe("Z.AI native Provider usage consumer", () => {
  function usage(state: ReturnType<typeof setup>) {
    let handlers: Record<string, (input: { resourceId: string; refresh: boolean }) => Promise<unknown>>;
    const bb = { rpc: { register: (_contract: unknown, methods: typeof handlers) => { handlers = methods; } } };
    const refreshUsage = vi.fn(async () => state.adapter.refreshUsage(state.context));
    const hub = {
      status: async () => ({ accounts: [{ ...state.stored(), id: "synthetic-account", provider: "zai",
        label: "Synthetic", email: null, subscriptionType: null, rateLimitTier: null,
        accountUuid: null }] }),
      assertNetworkAllowed: async () => {}, refreshUsage,
    };
    registerUsageSource(bb as unknown as BbPluginApi, hub as unknown as AccountPoolHub);
    return { call: (method: string) => handlers[method]!({ resourceId: "synthetic-account", refresh: true }), refreshUsage };
  }
  it("lists cheaply, then exposes consumed percent, observation and unknown plan/reset", async () => {
    const source = usage(setup(Response.json(payload(100))));
    expect(await source.call(usageListMethod)).toMatchObject({ resources: [{ providerId: "acp-opencode-zai" }] });
    expect(source.refreshUsage).not.toHaveBeenCalled();
    const result = usageMeasurementSchema.parse(await source.call(usageFetchMethod));
    expect(result).toMatchObject({ observedAt: NOW, usage: { status: "ok", planLabel: null,
      windows: [{ usedPercent: 100, resetsAt: null }] } });
  });
  it("propagates safe collection failure instead of returning successful empty windows", async () => {
    const source = usage(setup(new Response("synthetic-private-value", { status: 403 })));
    await expect(source.call(usageFetchMethod)).rejects.toThrow("HTTP 403");
  });
});

describe("Z.AI known quota semantics", () => {
  it.each([0, 100, "0", "100"])("observes %s consumed without inventing a reset", percent => {
    const result = zaiQuotaFromUsages("synthetic-account", payload(percent), blank(), NOW)!;
    expect(result.fiveHourUtilization).toBe(Number(percent) / 100);
    expect(result.fiveHourResetAt).toBeNull();
    expect(result.observedAt).toBe(NOW);
    expect(isSharedQuotaExhausted(result, 1, NOW)).toBe(Number(percent) === 100);
  });
  it.each([null, undefined, "", "  ", "invalid", true, {}, -1, 101, Infinity, NaN])(
    "does not turn invalid percentage %s into a measurement", percent => {
      expect(zaiQuotaFromUsages("synthetic-account", payload(percent), blank(), NOW)).toBeNull();
    });
  it("keeps an omitted weekly rejection in a partial observation", () => {
    const prior = { ...blank(), sevenDayUtilization: 1, sevenDayStatus: "rejected" as const,
      sevenDayResetAt: NOW + 10000, observedAt: NOW - 1000 };
    const result = zaiQuotaFromUsages("synthetic-account", payload(0), prior, NOW)!;
    expect(isSharedQuotaExhausted(result, 1, NOW)).toBe(true);
    expect(result.sevenDayResetAt).toBe(prior.sevenDayResetAt);
    expect(zaiQuotaFromUsages("synthetic-account", { data: { limits: [] } }, prior, NOW)).toBeNull();
  });
  it("rejects application failures even if they carry plausible windows", () => {
    expect(zaiQuotaFromUsages("synthetic-account", { ...payload(0), code: 403 }, blank(), NOW)).toBeNull();
  });
});

describe("Z.AI sanitized diagnostic phases", () => {
  it.each([
    ["ENOTFOUND", "dns"], ["ECONNREFUSED", "connect"],
    ["CERT_HAS_EXPIRED", "tls"], ["UND_ERR_HEADERS_TIMEOUT", "headers"],
  ])("reports %s at the fixed %s phase", async (code, phase) => {
    const state = setup(Object.assign(new Error("synthetic-private-value"), { code }));
    await expect(state.adapter.refreshUsage(state.context)).rejects.toThrow(`code=${code}; category=${phase}; phase=${phase}; elapsedMs=`);
    expect(state.stored().observedAt).toBeNull();
  });
  it("reports a body transport failure without calling it invalid JSON", async () => {
    const body = new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error("synthetic-private-value"), { code: "UND_ERR_BODY_TIMEOUT" }));
    } });
    const state = setup(new Response(body));
    await expect(state.adapter.refreshUsage(state.context)).rejects.toThrow("phase=body; elapsedMs=");
    expect(state.stored().error).toContain("code=UND_ERR_BODY_TIMEOUT");
    expect(state.stored().error).not.toContain("invalid JSON");
  });
  it("reports malformed JSON at parse, without the upstream text", async () => {
    const state = setup(new Response("synthetic-private-value"));
    await expect(state.adapter.refreshUsage(state.context)).rejects.toThrow("invalid JSON; code=unknown; category=unknown; phase=parse;");
    expect(state.stored().error).not.toContain("synthetic-private-value");
  });
  it("never leaks arbitrary codes, messages, credentials or cause fields", async () => {
    const state = setup(Object.assign(new Error("synthetic-secret synthetic-private-value"), {
      code: "synthetic-private-value", headers: { authorization: "synthetic-secret" },
      cause: new Error("synthetic-secret"),
    }));
    await expect(state.adapter.refreshUsage(state.context)).rejects.toThrow(/code=unknown; category=unknown; phase=headers; elapsedMs=\d+/);
    expect(state.stored().error).not.toMatch(/synthetic-secret|synthetic-private-value|authorization/);
  });
});
