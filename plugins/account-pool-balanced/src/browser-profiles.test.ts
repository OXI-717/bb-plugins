import { execFile, spawn as spawnProcess } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import dns from "node:dns";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "./contracts.js";
import {
  browserExecutableCandidates,
  browserProcessPattern,
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
  it("configures IPv4 on the real default fetcher connector", async () => {
    const server = createServer((_req, res) => {
      res.end(JSON.stringify({ timezone: "UTC" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const original = dns.lookup;
    const families: unknown[] = [];
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((host: string, options: any, callback: any) => {
      if (host !== "geo.fixture.test") return original(host, options, callback);
      families.push(options.family);
      const family = options.family === 4 ? 4 : 6;
      const address = family === 4 ? "127.0.0.1" : "::1";
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }) as typeof dns.lookup);
    try {
      expect(await fetchExitGeo(undefined, `http://geo.fixture.test:${port}/`)).toEqual({
        timezone: "UTC", city: null, country: null,
      });
      expect(families).toEqual([4]);
    } finally {
      lookup.mockRestore();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("parses a valid payload", async () => {
    const geo = await fetchExitGeo(geoFetcher, "https://example.test/geo");
    expect(geo).toEqual({ timezone: "Europe/Amsterdam", city: "Amsterdam", country: "NL" });
  });
  it("returns null for payloads without a timezone", async () => {
    expect(await fetchExitGeo(() => Promise.resolve({ city: "X" }))).toBeNull();
    expect(await fetchExitGeo(() => Promise.resolve(null))).toBeNull();
  });
  it("rejects invalid timezone values", async () => {
    expect(await fetchExitGeo(async () => ({ timezone: "../../etc/localtime" }))).toBeNull();
  });
  it("bounds streamed geo bodies and the total request deadline", async () => {
    const timers = new Set<ReturnType<typeof setInterval>>();
    const server = createServer((req, res) => {
      if (req.url === "/large") { res.end("x".repeat(65537)); return; }
      const timer = setInterval(() => res.write(" "), 50); timers.add(timer);
      res.on("close", () => { clearInterval(timer); timers.delete(timer); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await fetchExitGeo(undefined, `http://127.0.0.1:${port}/large`)).toBeNull();
      const start = Date.now();
      expect(await fetchExitGeo(undefined, `http://127.0.0.1:${port}/dribble`)).toBeNull();
      expect(Date.now() - start).toBeLessThan(5500);
    } finally {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 8000);
  it("returns null when the fetcher throws", async () => {
    expect(await fetchExitGeo(() => Promise.reject(new Error("offline")))).toBeNull();
  });
});

describe("profile naming and allocation", () => {
  it("allocates distinct profiles and retains both accounts on concurrent first use", async () => {
    const box = sandbox();
    const registryFile = path.join(box.dataDir, "registry.json");
    const entries = await Promise.all(ACCOUNTS.slice(0, 2).map(account =>
      ensureProfile(account, { heliumRoot: box.heliumRoot, registryFile })));
    expect(new Set(entries.map(entry => entry.profileDirectory)).size).toBe(2);
    const registry = JSON.parse(readFileSync(registryFile, "utf8"));
    expect(Object.keys(registry).sort()).toEqual(ACCOUNTS.slice(0, 2).map(a => a.id).sort());
    for (const entry of entries) {
      const prefs = JSON.parse(readFileSync(path.join(box.heliumRoot, "Pool Accounts", entry.profileDirectory, entry.profileDirectory, "Preferences"), "utf8"));
      expect(prefs.profile.name).toBe(entry.profileName);
    }
  });
  it("refuses malformed registry without overwriting it", async () => {
    const box = sandbox();
    const registryFile = path.join(box.dataDir, "registry.json");
    mkdirSync(box.dataDir, { recursive: true });
    writeFileSync(registryFile, "broken");
    await expect(ensureProfile(ACCOUNTS[0]!, { heliumRoot: box.heliumRoot, registryFile })).rejects.toThrow();
    expect(readFileSync(registryFile, "utf8")).toBe("broken");
  });
  it("serializes independent CLI processes and repeated allocation without lost bindings", async () => {
    const box = sandbox(); const registryFile = path.join(box.dataDir, "registry.json");
    const script = `import { ensureProfile } from './src/browser-profiles.ts';
      await ensureProfile(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]));`;
    const run = promisify(execFile);
    await Promise.all([ACCOUNTS[0]!, ACCOUNTS[1]!, ACCOUNTS[0]!].map(a => run(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(a), JSON.stringify({ heliumRoot: box.heliumRoot, registryFile })], { timeout: 15000 })));
    const registry = JSON.parse(readFileSync(registryFile, "utf8"));
    expect(Object.keys(registry).length).toBe(2);
    expect(new Set(Object.values(registry).map((e: any) => e.profileDirectory)).size).toBe(2);
  }, 20000);
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
    const prefs = JSON.parse(readFileSync(path.join(box.heliumRoot, "Pool Accounts", "Profile 1", "Profile 1", "Preferences"), "utf8"));
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
  it("matches the browser main process with arguments and escapes the executable", () => {
    const executable = "/fixture/Helium.app/Contents/MacOS/Helium";
    const pattern = new RegExp(browserProcessPattern(executable).replace("[[:space:]]", "\\s"));
    expect(pattern.test(executable + " --profile-directory=Profile 1")).toBe(true);
    expect(pattern.test(executable)).toBe(true);
    expect(pattern.test(executable.replace("Helium.app", "HeliumXapp"))).toBe(false);
    expect(pattern.test("/fixture/Helium Helper.app/Contents/MacOS/Helium Helper --type=renderer")).toBe(false);
  });
  it("puts the POOL_BROWSER_EXECUTABLE override first", () => {
    const candidates = browserExecutableCandidates("darwin", "/nonexistent/fake-home", {
      POOL_BROWSER_EXECUTABLE: "/opt/helium/Helium",
    });
    expect(candidates[0]).toBe("/opt/helium/Helium");
  });
  it("uses the bundle-id data dir on macOS", () => {
    expect(heliumDataRoot("darwin", "/tmp/pool-fake-home")).toBe(
      "/tmp/pool-fake-home/Library/Application Support/net.imput.helium",
    );
  });
});

describe("openAccountBrowser", () => {
  it.each([
    ["kimi", "https://www.kimi.com/code"],
    ["zai", "https://z.ai/manage-apikey/apikey-list"],
    ["opencode-go", "https://opencode.ai/go"],
    ["cursor", "https://cursor.com/dashboard"],
    ["devin", "https://app.devin.ai/"],
  ] as const)("opens the %s console and reuses its profile", async (provider, url) => {
    const box = sandbox();
    const selected = account({ id: ACCOUNTS[0]!.id, provider, label: "Synthetic", email: "person@example.test" });
    const options = { ...baseOptions(box), accounts: [selected], query: selected.id, readVpn: verifiedVpn, fetcher: geoFetcher, spawnImpl: fakeSpawn().spawnImpl };
    const first = await openAccountBrowser(options);
    expect(first.url).toBe(url);
    const second = await openAccountBrowser(options);
    expect(second.profileDir).toBe(first.profileDir);
  });
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
  it("refuses an isolated browser without a live supervisor", async () => {
    const box = sandbox();
    await expect(openAccountBrowser({
      ...baseOptions(box), query: "a@example.test", readVpn: verifiedVpn,
      fetcher: geoFetcher, listRunning: async () => [42], spawnImpl: fakeSpawn().spawnImpl,
    })).rejects.toThrow(/without a live transport supervisor/);
  });
  it("preserves opaque profile data and original settings during migration and retry", async () => {
    const box = sandbox();
    const registryFile = path.join(box.dataDir, "plugins", "account-pool-balanced", "browser-profiles", "registry.json");
    const entry = { profileDirectory: "Profile 1", profileName: "Claude · a@example.test", createdAt: 1 };
    const source = path.join(box.heliumRoot, entry.profileDirectory);
    mkdirSync(source, { recursive: true }); mkdirSync(path.dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({ [ACCOUNTS[0]!.id]: entry }));
    writeFileSync(path.join(source, "fixture-state"), "synthetic opaque state");
    writeFileSync(path.join(source, "Preferences"), JSON.stringify({ profile: { name: "saved email" }, custom: true }));
    const opts = { ...baseOptions(box), query: "a@example.test", readVpn: verifiedVpn, fetcher: geoFetcher, spawnImpl: fakeSpawn().spawnImpl };
    const result = await openAccountBrowser(opts);
    expect(result.profileDir).not.toBe(source);
    expect(readFileSync(path.join(result.profileDir, "fixture-state"), "utf8")).toBe("synthetic opaque state");
    expect(JSON.parse(readFileSync(path.join(result.profileDir, "Preferences"), "utf8")).custom).toBe(true);
    writeFileSync(path.join(result.profileDir, "fixture-state"), "new settings");
    await openAccountBrowser(opts);
    expect(readFileSync(path.join(result.profileDir, "fixture-state"), "utf8")).toBe("new settings");
    expect(readFileSync(path.join(source, "fixture-state"), "utf8")).toBe("synthetic opaque state");
  });
  it.each(["final", "alias", "isolated"])("checks real native processes before migration (%s)", async mode => {
    const box = sandbox(); const registryFile = path.join(box.dataDir, "plugins", "account-pool-balanced", "browser-profiles", "registry.json");
    mkdirSync(path.join(box.heliumRoot, "Profile 1"), { recursive: true });
    mkdirSync(path.dirname(registryFile), { recursive: true });
    writeFileSync(path.join(box.heliumRoot, "Profile 1", "Preferences"), JSON.stringify({ custom: true }));
    writeFileSync(registryFile, JSON.stringify({ [ACCOUNTS[0]!.id]: { profileDirectory: "Profile 1", profileName: "saved", createdAt: 1 } }));
    const executable = path.join(box.dataDir, "synthetic-native-browser");
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000);`, { mode: 0o700 });
    const dataRootArg = mode === "isolated" ? path.join(realpathSync(box.heliumRoot), "Pool Accounts", "Profile 99")
      : mode === "final" ? realpathSync(box.heliumRoot) : box.heliumRoot + "/.";
    const native = spawnProcess(executable, [`--user-data-dir=${dataRootArg}`, ...(mode === "alias" ? ["about:blank"] : [])], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { native.once("spawn", resolve); native.once("error", reject); });
    let launched = false;
    try {
      const opening = openAccountBrowser({ accounts: ACCOUNTS, dataDir: box.dataDir, heliumRoot: box.heliumRoot,
        pluginId: "account-pool-balanced", query: "a@example.test", readVpn: verifiedVpn, fetcher: geoFetcher,
        env: { PATH: process.env.PATH, POOL_BROWSER_EXECUTABLE: executable },
        transportImpl: async () => { launched = true; },
      });
      if (mode === "isolated") { await expect(opening).resolves.toMatchObject({ guarded: true }); expect(launched).toBe(true); return; }
      await expect(opening).rejects.toThrow(/migration requires closing/);
      expect(launched).toBe(false);
      expect(JSON.parse(readFileSync(registryFile, "utf8"))[ACCOUNTS[0]!.id].isolated).toBeUndefined();
    } finally { native.kill(); await new Promise(resolve => native.once("exit", resolve)); }
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
    expect(launch.args.some(arg => arg.startsWith("--user-data-dir=") && arg.includes("Pool Accounts"))).toBe(true);
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
    expect(result.url).toBe("https://www.kimi.com/code");
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
