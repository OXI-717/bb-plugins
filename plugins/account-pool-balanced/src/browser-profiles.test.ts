import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountSummary } from "./contracts.js";
import {
  browserExecutableCandidates,
  ensureProfile,
  fetchExitGeo,
  heliumDataRoot,
  listBrowserProfiles,
  nextProfileDirectory,
  openAccountBrowser,
  profileNameFor,
  resolveAccount,
  syncLocalStateProfiles,
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
  pid: number | undefined;
  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
  unref(): void {}
}

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

function fakeSpawn(pid?: number): { spawnImpl: never; captured: CapturedSpawn[] } {
  const captured: CapturedSpawn[] = [];
  const impl = (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    captured.push({ command, args, env: options.env });
    return new FakeChild(pid);
  };
  return { spawnImpl: impl as never, captured };
}

const geoFetcher = () => Promise.resolve({ timezone: "Europe/Amsterdam", city: "Amsterdam", country: "NL" });
const verifiedVpn = () => Promise.resolve(VERIFIED);
const noRunning = () => Promise.resolve([]);

function sandbox(): { dataDir: string; heliumRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pool-browser-test-"));
  return { dataDir: path.join(root, "data"), heliumRoot: path.join(root, "helium") };
}

function baseOptions(box: { dataDir: string; heliumRoot: string }) {
  return {
    accounts: ACCOUNTS,
    dataDir: box.dataDir,
    pluginId: "account-pool-balanced",
    heliumRoot: box.heliumRoot,
    settleMs: 1,
    exists: () => true,
    listRunning: noRunning,
    env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
  };
}

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

describe("profile naming and allocation", () => {
  it("names profiles '<Provider> · <email>'", () => {
    expect(profileNameFor(ACCOUNTS[0]!)).toBe("Claude · a@example.test");
    expect(profileNameFor(ACCOUNTS[2]!)).toBe("Kimi · Kimi");
  });
  it("allocates the next free Profile N", () => {
    expect(nextProfileDirectory([])).toBe("Profile 1");
    expect(nextProfileDirectory(["Default"])).toBe("Profile 1");
    expect(nextProfileDirectory(["Default", "Profile 1", "Profile 3"])).toBe("Profile 4");
  });
  it("creates Preferences on first use; picker sync is a separate step", async () => {
    const box = sandbox();
    const registryFile = path.join(box.dataDir, "plugins", "account-pool-balanced", "browser-profiles", "registry.json");
    const entry = await ensureProfile(ACCOUNTS[0]!, {
      heliumRoot: box.heliumRoot,
      registryFile,
    });
    expect(entry.profileDirectory).toBe("Profile 1");
    expect(entry.profileName).toBe("Claude · a@example.test");
    const prefs = JSON.parse(readFileSync(path.join(box.heliumRoot, "Profile 1", "Preferences"), "utf8"));
    expect(prefs.profile.name).toBe("Claude · a@example.test");
    // picker-регистрация — только через sync (Helium должен быть закрыт)
    expect(existsSync(path.join(box.heliumRoot, "Local State"))).toBe(false);
    const second = await ensureProfile(ACCOUNTS[1]!, {
      heliumRoot: box.heliumRoot,
      registryFile,
    });
    await syncLocalStateProfiles(box.heliumRoot, [entry, second]);
    const localState = JSON.parse(readFileSync(path.join(box.heliumRoot, "Local State"), "utf8"));
    expect(localState.profile.info_cache["Profile 1"].name).toBe("Claude · a@example.test");
    expect(localState.profile.info_cache["Profile 2"].name).toBe("Claude · b@example.test");
    // повторный вызов идемпотентен
    const again = await ensureProfile(ACCOUNTS[0]!, {
      heliumRoot: box.heliumRoot,
      registryFile,
    });
    expect(again.profileDirectory).toBe("Profile 1");
  });
});

describe("browserExecutableCandidates", () => {
  it("puts the POOL_BROWSER_EXECUTABLE override first", () => {
    const candidates = browserExecutableCandidates("darwin", "/nonexistent/fake-home", {
      POOL_BROWSER_EXECUTABLE: "/opt/helium/Helium",
    });
    expect(candidates[0]).toBe("/opt/helium/Helium");
  });
  it("uses the bundle-id data dir on macOS", () => {
    expect(heliumDataRoot("darwin", "/Users/test")).toBe(
      "/Users/test/Library/Application Support/net.imput.helium",
    );
  });
});

describe("openAccountBrowser", () => {
  it("refuses guarded providers without verified VPN evidence", async () => {
    const box = sandbox();
    await expect(
      openAccountBrowser({
        ...baseOptions(box),
        query: "a@example.test",
        readVpn: () => Promise.resolve(UNVERIFIED),
        fetcher: geoFetcher,
        spawnImpl: fakeSpawn().spawnImpl,
      }),
    ).rejects.toThrow(/verified_ipv4/);
  });
  it("fails closed when the exit timezone is unknown for a guarded account", async () => {
    const box = sandbox();
    await expect(
      openAccountBrowser({
        ...baseOptions(box),
        query: "a@example.test",
        readVpn: verifiedVpn,
        fetcher: () => Promise.resolve(null),
        spawnImpl: fakeSpawn().spawnImpl,
      }),
    ).rejects.toThrow(/timezone/);
  });
  it("refuses to join a Helium instance running with an unverified timezone", async () => {
    const box = sandbox();
    await expect(
      openAccountBrowser({
        ...baseOptions(box),
        query: "a@example.test",
        readVpn: verifiedVpn,
        fetcher: geoFetcher,
        listRunning: () => Promise.resolve([42]),
        spawnImpl: fakeSpawn().spawnImpl,
      }),
    ).rejects.toThrow(/unverified timezone/);
  });
  it("joins a running instance we launched ourselves with the same timezone", async () => {
    const box = sandbox();
    const { spawnImpl } = fakeSpawn(4242);
    await openAccountBrowser({
      ...baseOptions(box),
      query: "a@example.test",
      readVpn: verifiedVpn,
      fetcher: geoFetcher,
      spawnImpl,
    });
    const second = fakeSpawn(9999); // транзиентный handoff-процесс, не main
    const impl2 = (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      second.captured.push({ command, args, env: options.env });
      const child = new FakeChild(9999);
      queueMicrotask(() => child.emit("exit", 0)); // process-singleton handoff: clean fast exit
      return child;
    };
    const result = await openAccountBrowser({
      ...baseOptions(box),
      query: "b@example.test",
      readVpn: verifiedVpn,
      fetcher: geoFetcher,
      listRunning: () => Promise.resolve([4242]),
      spawnImpl: impl2 as never,
    });
    expect(result.profileDirectory).toBe("Profile 2");
    expect(second.captured).toHaveLength(1);
    // маркер по-прежнему указывает на живой main (4242), не на транзиентный handoff
    const marker = JSON.parse(readFileSync(
      path.join(box.dataDir, "plugins", "account-pool-balanced", "browser-profiles", "last-launch.json"),
      "utf8",
    ));
    expect(marker.pid).toBe(4242);
    // picker-синк пропущен при живом Helium: Profile 2 пока не в Local State
    const lsPath = path.join(box.heliumRoot, "Local State");
    let cache = JSON.parse(readFileSync(lsPath, "utf8")).profile.info_cache;
    expect(Object.keys(cache)).toEqual(["Profile 1"]);
    // self-heal: следующий open при закрытом Helium догоняет picker
    const third = fakeSpawn(4343);
    await openAccountBrowser({
      ...baseOptions(box),
      query: "b@example.test",
      readVpn: verifiedVpn,
      fetcher: geoFetcher,
      listRunning: () => Promise.resolve([]),
      spawnImpl: third.spawnImpl,
    });
    cache = JSON.parse(readFileSync(lsPath, "utf8")).profile.info_cache;
    expect(cache["Profile 2"].name).toBe("Claude · b@example.test");
  });
  it("launches Helium with the native profile and the exit timezone", async () => {
    const box = sandbox();
    const { spawnImpl, captured } = fakeSpawn();
    const result = await openAccountBrowser({
      ...baseOptions(box),
      query: "a@example.test",
      readVpn: verifiedVpn,
      fetcher: geoFetcher,
      spawnImpl,
    });
    expect(result.timezone).toBe("Europe/Amsterdam");
    expect(result.url).toBe("https://claude.ai/");
    expect(result.profileName).toBe("Claude · a@example.test");
    expect(result.profileDirectory).toBe("Profile 1");
    expect(captured).toHaveLength(1);
    const launch = captured[0]!;
    expect(launch.env?.TZ).toBe("Europe/Amsterdam");
    expect(launch.args.join(" ")).toContain("--profile-directory=Profile 1");
    expect(launch.args).toContain("--disable-ipv6");
  });
  it("does not read VPN state for unguarded providers", async () => {
    const box = sandbox();
    const { spawnImpl, captured } = fakeSpawn();
    const result = await openAccountBrowser({
      ...baseOptions(box),
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
    const box = sandbox();
    const { spawnImpl, captured } = fakeSpawn();
    await openAccountBrowser({
      ...baseOptions(box),
      query: "kimi",
      url: "https://example.test/settings",
      fetcher: geoFetcher,
      spawnImpl,
    });
    expect(captured[0]?.args.at(-1)).toBe("https://example.test/settings");
  });
  it("throws when no Helium executable exists", async () => {
    const box = sandbox();
    await expect(
      openAccountBrowser({
        ...baseOptions(box),
        query: "kimi",
        exists: () => false,
        fetcher: geoFetcher,
        spawnImpl: fakeSpawn().spawnImpl,
      }),
    ).rejects.toThrow(/Helium executable not found/);
  });
  it("throws when the browser exits during launch", async () => {
    const box = sandbox();
    const impl = () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    };
    await expect(
      openAccountBrowser({
        ...baseOptions(box),
        query: "kimi",
        fetcher: geoFetcher,
        spawnImpl: impl as never,
      }),
    ).rejects.toThrow(/exited during launch/);
  });
});

describe("listBrowserProfiles", () => {
  it("joins accounts with the registry", async () => {
    const box = sandbox();
    const { spawnImpl } = fakeSpawn();
    await openAccountBrowser({
      ...baseOptions(box),
      query: "kimi",
      fetcher: geoFetcher,
      spawnImpl,
    });
    const rows = await listBrowserProfiles({
      accounts: ACCOUNTS,
      dataDir: box.dataDir,
      pluginId: "account-pool-balanced",
      heliumRoot: box.heliumRoot,
    });
    const kimi = rows.find((row) => row.provider === "kimi")!;
    expect(kimi.profileName).toBe("Kimi · Kimi");
    expect(kimi.exists).toBe(true);
    expect(kimi.updatedAt).not.toBeNull();
    const primary = rows.find((row) => row.label === "Primary")!;
    expect(primary.exists).toBe(false);
    expect(primary.profileDirectory).toBe("");
  });
});
