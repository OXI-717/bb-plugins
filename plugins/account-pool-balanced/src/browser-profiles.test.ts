import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountSummary } from "./contracts.js";
import {
  browserExecutableCandidates,
  fetchExitGeo,
  listBrowserProfiles,
  openAccountBrowser,
  resolveAccount,
} from "./browser-profiles.js";
import type { VpnEvidence } from "./vpn-evidence.js";

const account = (
  overrides: Partial<AccountSummary> & { id: string; provider: string; label: string },
): AccountSummary =>
  ({ email: null, ...overrides }) as AccountSummary;

const ACCOUNTS: AccountSummary[] = [
  account({ id: "11111111-1111-4111-8111-111111111111", provider: "claude", label: "Primary", email: "a@example.test" }),
  account({ id: "22222222-2222-4222-8222-222222222222", provider: "claude", label: "Reserve", email: "b@example.test" }),
  account({ id: "33333333-3333-4333-8333-333333333333", provider: "kimi", label: "Kimi" }),
  account({ id: "44444444-4444-4444-8444-444444444444", provider: "claude", label: "Dup", email: "dup@example.test" }),
  account({ id: "55555555-5555-4555-8555-555555555555", provider: "claude", label: "Dup", email: "dup2@example.test" }),
];

const VERIFIED: VpnEvidence = {
  state: "connected",
  assurance: "verified_ipv4",
  reason: "ok",
  updatedAt: 1,
  probeAt: 1,
};
const UNVERIFIED: VpnEvidence = {
  state: "connected",
  assurance: "unverified",
  reason: "probe_stale",
  updatedAt: 1,
  probeAt: null,
};

class FakeChild extends EventEmitter {
  unref(): void {}
}

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

function fakeSpawn(): { spawnImpl: never; captured: CapturedSpawn[] } {
  const captured: CapturedSpawn[] = [];
  const impl = (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    captured.push({ command, args, env: options.env });
    return new FakeChild();
  };
  return { spawnImpl: impl as never, captured };
}

const geoFetcher = () => Promise.resolve({ timezone: "Europe/Amsterdam", city: "Amsterdam", country: "NL" });
const verifiedVpn = () => Promise.resolve(VERIFIED);
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "pool-browser-test-"));
const PROFILE_ROOT = path.join(DATA_DIR, "plugins", "account-pool-balanced", "browser-profiles");
const baseOptions = {
  accounts: ACCOUNTS,
  dataDir: DATA_DIR,
  pluginId: "account-pool-balanced",
  settleMs: 1,
  exists: () => true,
  platformName: "darwin" as const,
  env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
};

describe("resolveAccount", () => {
  it("matches by exact id", () => {
    expect(resolveAccount(ACCOUNTS, "22222222-2222-4222-8222-222222222222").label).toBe("Reserve");
  });
  it("matches by email case-insensitively", () => {
    expect(resolveAccount(ACCOUNTS, "A@EXAMPLE.test").id).toBe("11111111-1111-4111-8111-111111111111");
  });
  it("matches by label", () => {
    expect(resolveAccount(ACCOUNTS, "kimi").provider).toBe("kimi");
  });
  it("rejects ambiguous label matches", () => {
    expect(() => resolveAccount(ACCOUNTS, "dup")).toThrow(/ambiguous/);
  });
  it("rejects unknown queries", () => {
    expect(() => resolveAccount(ACCOUNTS, "nobody")).toThrow(/not found/);
  });
});

describe("browserExecutableCandidates", () => {
  it("puts the POOL_BROWSER_CHROMIUM override first", () => {
    const candidates = browserExecutableCandidates("darwin", "/home/x", {
      POOL_BROWSER_CHROMIUM: "/opt/chromium/Chromium",
    });
    expect(candidates[0]).toBe("/opt/chromium/Chromium");
  });
});

describe("listBrowserProfiles", () => {
  it("reports existing and missing profiles per account", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pool-browser-list-"));
    const existing = path.join(root, "plugins", "account-pool-balanced", "browser-profiles", ACCOUNTS[0]!.id);
    mkdirSync(existing, { recursive: true });
    const rows = await listBrowserProfiles({
      accounts: ACCOUNTS,
      dataDir: root,
      pluginId: "account-pool-balanced",
    });
    expect(rows).toHaveLength(ACCOUNTS.length);
    expect(rows[0]).toMatchObject({ accountId: ACCOUNTS[0]!.id, exists: true });
    expect(rows[0]!.updatedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ accountId: ACCOUNTS[1]!.id, exists: false, updatedAt: null });
  });
});

describe("fetchExitGeo", () => {
  it("parses a valid payload", async () => {
    const geo = await fetchExitGeo(geoFetcher, "https://example.test/geo");
    expect(geo).toEqual({ timezone: "Europe/Amsterdam", city: "Amsterdam", country: "NL" });
  });
  it("returns null for payloads without a timezone", async () => {
    expect(await fetchExitGeo(() => Promise.resolve({ city: "X" }))).toBeNull();
    expect(await fetchExitGeo(() => Promise.resolve(null))).toBeNull();
  });
  it("returns null when the fetcher throws", async () => {
    expect(await fetchExitGeo(() => Promise.reject(new Error("offline")))).toBeNull();
  });
});

describe("openAccountBrowser", () => {
  it("refuses guarded providers without verified VPN evidence", async () => {
    await expect(
      openAccountBrowser({
        ...baseOptions,
        query: "a@example.test",
        readVpn: () => Promise.resolve(UNVERIFIED),
        fetcher: geoFetcher,
        spawnImpl: fakeSpawn().spawnImpl,
      }),
    ).rejects.toThrow(/verified_ipv4/);
  });
  it("fails closed when the exit timezone is unknown for a guarded account", async () => {
    await expect(
      openAccountBrowser({
        ...baseOptions,
        query: "a@example.test",
        readVpn: verifiedVpn,
        fetcher: () => Promise.resolve(null),
        spawnImpl: fakeSpawn().spawnImpl,
      }),
    ).rejects.toThrow(/timezone/);
  });
  it("launches Chrome with a per-account profile and the exit timezone", async () => {
    const { spawnImpl, captured } = fakeSpawn();
    const result = await openAccountBrowser({
      ...baseOptions,
      query: "a@example.test",
      readVpn: verifiedVpn,
      fetcher: geoFetcher,
      spawnImpl,
    });
    expect(result.timezone).toBe("Europe/Amsterdam");
    expect(result.url).toBe("https://claude.ai/");
    expect(result.profileDir).toBe(
      path.join(PROFILE_ROOT, "11111111-1111-4111-8111-111111111111"),
    );
    expect(captured).toHaveLength(1);
    const launch = captured[0]!;
    expect(launch.env?.TZ).toBe("Europe/Amsterdam");
    expect(launch.args.join(" ")).toContain(`--user-data-dir=${path.join(PROFILE_ROOT, "11111111-1111-4111-8111-111111111111")}`);
  });
  it("does not read VPN state for unguarded providers", async () => {
    const { spawnImpl, captured } = fakeSpawn();
    const result = await openAccountBrowser({
      ...baseOptions,
      query: "kimi",
      readVpn: () => Promise.reject(new Error("must not be called")),
      fetcher: geoFetcher,
      spawnImpl,
    });
    expect(result.guarded).toBe(false);
    expect(captured[0]?.env?.TZ).toBe("Europe/Amsterdam");
    expect(result.url).toBe("about:blank");
  });
  it("honours an explicit --url", async () => {
    const { spawnImpl, captured } = fakeSpawn();
    await openAccountBrowser({
      ...baseOptions,
      query: "kimi",
      url: "https://example.test/settings",
      fetcher: geoFetcher,
      spawnImpl,
    });
    expect(captured[0]?.args.at(-1)).toBe("https://example.test/settings");
  });
  it("throws when no Chrome executable exists", async () => {
    await expect(
      openAccountBrowser({
        ...baseOptions,
        query: "kimi",
        exists: () => false,
        fetcher: geoFetcher,
        spawnImpl: fakeSpawn().spawnImpl,
      }),
    ).rejects.toThrow(/executable not found/);
  });
  it("throws when the browser exits during launch", async () => {
    const impl = () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    };
    await expect(
      openAccountBrowser({
        ...baseOptions,
        query: "kimi",
        fetcher: geoFetcher,
        spawnImpl: impl as never,
      }),
    ).rejects.toThrow(/exited during launch/);
  });
});
