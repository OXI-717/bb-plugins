import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAdapter } from "./codex-adapter.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("usage refresh", () => {
  it("clears a stale account error once the usage endpoint answers", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-usage-"),
    );
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const accounts = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "secrets"),
    );
    await accounts.initialize();
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const secret = {
      kind: "oauth" as const,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: null,
    };
    const account = await accounts.add(
      {
        provider: "codex",
        kind: "oauth",
        label: "codex",
        email: null,
        accountUuid: null,
        codexAccountId: "chatgpt-account",
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
      },
      secret,
    );
    quotas.put({ ...quotas.get(account.id), error: "upstream blocked" });
    const adapter = createCodexAdapter({
      refreshUrl: "https://auth.example/oauth/token",
      usageUrl: "https://usage.example/wham/usage",
    });
    const refresh = (status: number) =>
      adapter.refreshUsage({
        account,
        accounts,
        quotas,
        now: () => 1_800_000_000_000,
        freshSecret: async () => secret,
        fetch: async () =>
          Response.json(
            {
              plan_type: "pro",
              rate_limit: {
                primary_window: {
                  used_percent: 40,
                  reset_after_seconds: 3_600,
                },
              },
            },
            { status },
          ),
      });

    await expect(refresh(503)).rejects.toThrow("HTTP 503");
    expect(quotas.get(account.id).error).toBe("upstream blocked");
    await refresh(200);
    expect(quotas.get(account.id)).toMatchObject({
      error: null,
      limitWindows: [expect.objectContaining({ utilization: 0.4 })],
    });

    const requested: string[] = [];
    await adapter.refreshUsage({
      account, accounts, quotas, now: () => 1_800_000_000_500,
      freshSecret: async () => secret,
      fetch: async (url) => {
        requested.push(String(url));
        if (String(url).endsWith("/rate-limit-reset-credits")) return Response.json({
          credits: [
            { status: "available", title: "Full reset", expires_at: "2026-10-05T00:00:00Z" },
            { status: "redeemed", expires_at: "2026-10-01T00:00:00Z" },
          ],
        });
        return Response.json({
          rate_limit: { primary_window: { used_percent: 40 } },
          rate_limit_reset_credits: { available_count: 1 },
        });
      },
    });
    expect(requested).toEqual([
      "https://usage.example/wham/usage",
      "https://usage.example/wham/rate-limit-reset-credits",
    ]);
    expect(quotas.resetCredits(account.id)).toEqual({
      availableCount: 1,
      credits: [{ title: "Full reset", expiresAt: Date.parse("2026-10-05T00:00:00Z") }],
      observedAt: 1_800_000_000_500,
    });

    const observedAt = quotas.get(account.id).observedAt;
    const tokens: Array<string | undefined> = [];
    let requests = 0;
    await adapter.refreshUsage({
      account, accounts, quotas, now: () => 1_800_000_001_000,
      freshSecret: async (rejected) => {
        tokens.push(rejected);
        return { ...secret, accessToken: rejected === undefined ? "old" : "new" };
      },
      fetch: async (_url, init) => {
        requests++;
        const authorization = new Headers(init?.headers).get("authorization");
        if (requests === 1) { expect(authorization).toBe("Bearer old"); return new Response(null, { status: 401 }); }
        expect(authorization).toBe("Bearer new");
        return Response.json({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } });
      },
    });
    expect(tokens).toEqual([undefined, "old"]);
    expect(requests).toBe(2);
    expect(quotas.get(account.id).observedAt).toBeGreaterThan(observedAt!);
    const goodQuota = quotas.get(account.id);
    requests = 0;
    await expect(adapter.refreshUsage({
      account, accounts, quotas, now: () => 1_800_000_002_000,
      freshSecret: async () => secret,
      fetch: async () => { requests++; return new Response(null, { status: 401 }); },
    })).rejects.toThrow("повторный вход");
    expect(requests).toBe(2);
    expect(quotas.get(account.id)).toEqual(goodQuota);
    await expect(adapter.refreshUsage({
      account, accounts, quotas, now: () => 1_800_000_003_000,
      freshSecret: async () => secret,
      fetch: async () => Response.json({ unexpected: true }),
    })).rejects.toThrow("некорректные");
    expect(quotas.get(account.id)).toEqual(goodQuota);
  });
});
