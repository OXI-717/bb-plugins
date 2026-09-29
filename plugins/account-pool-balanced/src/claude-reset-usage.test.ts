import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createClaudeAdapter } from "./claude-adapter.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-claude-reset-test-"));
  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  cleanups.push(async () => { await host.harness.lifecycle.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const accounts = new AccountStore(host.bb.storage.kv, path.join(dataDir, "secrets"));
  await accounts.initialize();
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
  const quotas = new QuotaStore(db);
  const secret = { kind: "oauth" as const, accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: null };
  const account = await accounts.add({ provider: "claude", kind: "oauth", label: "Test account", email: null,
    accountUuid: "11111111-1111-4111-8111-111111111111", subscriptionType: null, rateLimitTier: null,
    enabled: true, priority: 100 }, secret);
  const adapter = createClaudeAdapter({ refreshUrl: "https://auth.example/token", usageUrl: "https://usage.example/api/oauth/usage",
    profileUrl: "https://usage.example/profile" });
  return { quotas, account, refresh: (fetch: typeof globalThis.fetch) => adapter.refreshUsage({
    accounts, quotas, account, freshSecret: async () => secret, now: () => Date.parse("2030-04-01T12:00:00Z"), fetch,
  }) };
}

it("reads reset offers with quota windows in one GET and persists only display fields", async () => {
  const f = await fixture();
  let requests = 0;
  await f.refresh(async (input, init) => {
    requests++;
    expect(init?.method ?? "GET").toBe("GET");
    expect(String(input)).toBe("https://usage.example/api/oauth/usage?cedar_ember=1&skip_spend=1");
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/^claude-cli\//);
    return Response.json({ five_hour: { utilization: 25 }, cedar_ember: { eligible: true, grants: [{
      id: "private-redemption-handle", label: "Weekly reset", resets_left: 2,
      ends_at: "2030-04-22T09:17:35Z", clears: ["seven_day"], usable_now: true,
    }] } });
  });
  expect(requests).toBe(1);
  expect(f.quotas.get(f.account.id).fiveHourUtilization).toBe(0.25);
  const saved = f.quotas.resetCredits(f.account.id);
  expect(saved?.availableCount).toBe(2);
  expect(saved?.credits?.[0]?.expiresAt).toBe(Date.parse("2030-04-22T09:17:35Z"));
  expect(JSON.stringify(saved)).not.toContain("private-redemption-handle");
  await f.refresh(async () => Response.json({ five_hour: { utilization: 30 }, cedar_ember: { grants: "invalid" } }));
  expect(f.quotas.get(f.account.id).fiveHourUtilization).toBe(0.3);
  expect(f.quotas.resetCredits(f.account.id)).toBeNull();
});

it.each([400, 404, 422])("falls back once on unsupported usage query (HTTP %s)", async (status) => {
  const f = await fixture();
  const urls: string[] = [];
  await f.refresh(async (input) => {
    urls.push(String(input));
    return urls.length === 1 ? new Response(null, { status }) : Response.json({ five_hour: { utilization: 10 } });
  });
  expect(urls).toHaveLength(2);
  expect(urls[1]).toBe("https://usage.example/api/oauth/usage");
  expect(f.quotas.get(f.account.id).fiveHourUtilization).toBe(0.1);
  expect(f.quotas.resetCredits(f.account.id)).toBeNull();
});

it.each([401, 403, 429, 503])("does not retry HTTP %s as a query compatibility failure", async (status) => {
  const f = await fixture();
  let requests = 0;
  await f.refresh(async () => { requests++; return new Response(null, { status }); });
  expect(requests).toBe(1);
});
