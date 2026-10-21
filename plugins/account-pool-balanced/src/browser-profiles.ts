/** Per-account browser profiles for the Account Pooler, on a dedicated Helium.
 *
 * One Helium installation serves isolated user-data roots per pool account.
 * Original native profiles are retained during migration. Profiles are named
 * "<Provider> · <email>" so the window always shows which account it serves.
 * `open` launches Helium with the profile and a process timezone aligned to
 * the current exit IP. All IO is dependency-injected so tests stay hermetic.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { constants } from "node:fs";
import { handoffBrowser, startBrowserTransport, removeStaleBrowserSocket, type TransportLaunch } from "./browser-transport.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, stat, writeFile, open, rm, cp, copyFile, realpath, lstat } from "node:fs/promises";
import { homedir, platform as currentPlatform, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Agent, request as httpRequest } from "undici";
import type { AccountSummary } from "./contracts.js";
import { readVpnEvidence } from "./vpn-policy.js";
import type { VpnEvidence } from "./vpn-evidence.js";

/** Providers whose accounts must only be reached through a verified VPN exit. */
export const GUARDED_BROWSER_PROVIDERS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor",
  "devin",
]);

/** Provider consoles used when no explicit --url is given. */
const PROVIDER_HOME: Readonly<Record<string, string>> = {
  claude: "https://claude.ai/",
  codex: "https://chatgpt.com/",
  kimi: "https://www.kimi.com/code",
  zai: "https://z.ai/manage-apikey/apikey-list",
  "opencode-go": "https://opencode.ai/go",
  cursor: "https://cursor.com/dashboard",
  devin: "https://app.devin.ai/",
};

const PROVIDER_TITLE: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "Z.ai",
  "opencode-go": "OpenCode Go",
  cursor: "Cursor",
  devin: "Devin",
};

const DEFAULT_GEO_URL = "https://ipinfo.io/json";
const GEO_URL_ENV = "POOL_BROWSER_GEO_URL";
const GEO_MAX_BYTES = 65536;

/** Optional override for the Helium executable. */
const BROWSER_PATH_ENV = "POOL_BROWSER_EXECUTABLE";
const HELIUM_APP_BINARY = "Helium.app/Contents/MacOS/Helium";
// Chromium на macOS хранит профили по bundle id, не по имени приложения.
const HELIUM_MAC_DATA_DIR = path.join("Application Support", "net.imput.helium");

export interface ExitGeo {
  timezone: string;
  city: string | null;
  country: string | null;
}

export type GeoFetcher = (url: string) => Promise<unknown>;
export type VpnReader = (file: string) => Promise<VpnEvidence>;

const defaultVpnReader: VpnReader = (file) => readVpnEvidence(file, Date.now());

const defaultGeoFetcher: GeoFetcher = async (url) => {
  const target = new URL(url);
  if (target.hostname.startsWith("[") || target.username || target.password || !["http:", "https:"].includes(target.protocol)) return null;
  const dispatcher = new Agent({ connect: { family: 4, timeout: 4000 } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await httpRequest(url, {
      method: "GET", dispatcher, signal: controller.signal,
      headersTimeout: 4000, bodyTimeout: 4000,
    });
    if (res.statusCode !== 200) { res.body.destroy(); return null; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > GEO_MAX_BYTES) { res.body.destroy(); return null; }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    clearTimeout(timer);
    await dispatcher.destroy();
  }
};

const storeTails = new Map<string, Promise<void>>();
async function withProfileStore<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = await realpath(root);
  const result = (storeTails.get(key) ?? Promise.resolve()).then(async () => {
    // Kernel-owned loopback lease: released even if a CLI/RPC process crashes.
    // Hash collisions or an occupied port only cause a bounded, closed failure.
    const port = 40000 + createHash("sha256").update(key).digest().readUInt32BE(0) % 20000;
    const deadline = Date.now() + 10000;
    const lock = createServer(socket => socket.destroy());
    while (true) {
      try {
        await new Promise<void>((resolve, reject) => {
          lock.once("error", reject);
          lock.listen({ port, host: "127.0.0.1", exclusive: true }, () => { lock.removeAllListeners("error"); resolve(); });
        });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() >= deadline) throw new Error("Browser profile store is busy; retry shortly.");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return await action(); }
    finally { await new Promise<void>(resolve => lock.close(() => resolve())); }
  });
  const tail = result.then(() => {}, () => {});
  storeTails.set(key, tail);
  return result.finally(() => { if (storeTails.get(key) === tail) storeTails.delete(key); });
}

/** Match one account by exact id, then email, then label (case-insensitive). */
export function resolveAccount(
  accounts: readonly AccountSummary[],
  query: string,
): AccountSummary {
  const needle = query.trim();
  if (needle === "") throw new Error("Account query must not be empty.");
  const byId = accounts.filter((account) => account.id === needle);
  if (byId.length === 1) return byId[0]!;
  const lower = needle.toLowerCase();
  const byEmail = accounts.filter(
    (account) => account.email !== null && account.email.toLowerCase() === lower,
  );
  const matches = byEmail.length > 0
    ? byEmail
    : accounts.filter((account) => account.label.toLowerCase() === lower);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Account query "${needle}" is ambiguous (${matches.length} matches); use the account id.`,
    );
  }
  throw new Error(`Account not found: ${needle}`);
}

/** Fetch the current exit IP geo record; null on any failure (never throws). */
export async function fetchExitGeo(
  fetcher: GeoFetcher = defaultGeoFetcher,
  url: string = process.env[GEO_URL_ENV] ?? DEFAULT_GEO_URL,
): Promise<ExitGeo | null> {
  try {
    const payload = await fetcher(url);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const timezone = record.timezone;
    if (typeof timezone !== "string" || timezone.length > 128 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) return null;
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { return null; }
    return {
      timezone,
      city: typeof record.city === "string" ? record.city : null,
      country: typeof record.country === "string" ? record.country : null,
    };
  } catch {
    return null;
  }
}

/** Helium executable candidates: env override, then platform defaults. */
export function browserExecutableCandidates(
  platformName: NodeJS.Platform = currentPlatform(),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env[BROWSER_PATH_ENV];
  const out: string[] = override ? [override] : [];
  if (platformName === "darwin") {
    out.push(
      path.join("/Applications", HELIUM_APP_BINARY),
      path.join(home, "Applications", HELIUM_APP_BINARY),
    );
  } else if (platformName === "win32") {
    const bases = [process.env["LOCALAPPDATA"], process.env["ProgramFiles"]]
      .filter((value): value is string => typeof value === "string" && value !== "");
    for (const base of bases) out.push(path.join(base, "Helium", "Application", "Helium.exe"));
  } else {
    out.push("/usr/bin/helium", "/usr/local/bin/helium");
  }
  return out;
}

/** Helium user-data root (native profile store). */
export function heliumDataRoot(
  platformName: NodeJS.Platform = currentPlatform(),
  home: string = homedir(),
): string {
  if (platformName === "darwin") return path.join(home, "Library", HELIUM_MAC_DATA_DIR);
  if (platformName === "win32") {
    return path.join(process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "Helium");
  }
  return path.join(home, ".config", "helium");
}

/** Human-readable native profile name: "<Provider> · <email-or-label>". */
export function profileNameFor(account: AccountSummary): string {
  const title = PROVIDER_TITLE[account.provider] ?? account.provider;
  return `${title} · ${account.email ?? account.label}`;
}

interface RegistryEntry {
  profileDirectory: string;
  profileName: string;
  createdAt: number;
  isolated?: boolean;
}

type Registry = Record<string, RegistryEntry>;

async function readObject(file: string, maxBytes = 4 * 1024 * 1024): Promise<Record<string, unknown>> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid browser state file.");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) throw new Error("Browser state file exceeds size limit.");
    const parsed: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid browser state object.");
    return parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read browser state safely; existing bindings were preserved.");
  } finally { await handle?.close(); }
}

async function readRegistry(file: string): Promise<Registry> {
  const parsed = await readObject(file, 1024 * 1024);
  const seen = new Set<string>();
  for (const entry of Object.values(parsed)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid browser registry entry.");
    const e = entry as RegistryEntry;
    if (!/^Profile [1-9]\d{0,6}$/.test(e.profileDirectory) || typeof e.profileName !== "string" || e.profileName.length > 1024 || !Number.isFinite(e.createdAt) || (e.isolated !== undefined && e.isolated !== true)) throw new Error("Invalid browser registry binding.");
    if (seen.has(e.profileDirectory)) throw new Error("Duplicate browser profile binding; refusing account mixing.");
    seen.add(e.profileDirectory);
  }
  return parsed as Registry;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}

/** Next free "Profile N" directory name (Default counts as taken). */
export function nextProfileDirectory(existingDirs: readonly string[]): string {
  let max = 0;
  for (const dir of existingDirs) {
    const match = /^Profile (\d+)$/.exec(dir);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Profile ${max + 1}`;
}

async function listHeliumProfileDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
      .map((entry) => entry.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

const execFileAsync = promisify(execFile);

/** Match an exact executable followed by its optional command-line arguments. */
export function browserProcessPattern(executable: string): string {
  return executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([[:space:]]|$)";
}

export async function listRunningHelium(executable = path.join("/Applications", HELIUM_APP_BINARY)): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "--", browserProcessPattern(executable)], {
      timeout: 2000,
      maxBuffer: 65536,
    });
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return [];
    throw new Error("Cannot inspect running browser processes; refusing an unverified timezone handoff.");
  }
}

async function listRunningNativeHelium(executable: string, nativeRoot: string): Promise<number[]> {
  const result: number[] = [];
  for (const pid of await listRunningHelium(executable)) {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="], { timeout: 2000, maxBuffer: 65536 });
      // Only our canonical isolated roots are a positive reason to ignore a
      // live browser. Arbitrary native-root spellings/aliases remain blockers.
      const isolatedPrefix = path.join(nativeRoot, "Pool Accounts", "Profile ");
      const escaped = isolatedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const knownIsolated = new RegExp(`--user-data-dir=${escaped}[1-9]\\d{0,6}(?:\\s|$)`).test(stdout);
      if (!knownIsolated) result.push(pid);
    } catch { throw new Error("Cannot verify original Helium is closed for migration."); }
  }
  return result;
}

export interface EnsureProfileOptions {
  heliumRoot: string;
  registryFile: string;
}

/** Sync every registry entry into Helium's Local State info_cache.
 *  Helium rewrites Local State live, so call this only while it is closed;
 *  this also self-heals profiles that were created while it was running. */
export async function syncLocalStateProfiles(
  heliumRoot: string,
  entries: readonly RegistryEntry[],
): Promise<void> {
  const localStateFile = path.join(heliumRoot, "Local State");
  const localState = await readObject(localStateFile);
  const profile =
    localState["profile"] !== null &&
    typeof localState["profile"] === "object" &&
    !Array.isArray(localState["profile"])
      ? { ...(localState["profile"] as Record<string, unknown>) }
      : {};
  const cache =
    profile["info_cache"] !== null &&
    typeof profile["info_cache"] === "object" &&
    !Array.isArray(profile["info_cache"])
      ? { ...(profile["info_cache"] as Record<string, unknown>) }
      : {};
  for (const entry of entries) {
    const existing = cache[entry.profileDirectory];
    cache[entry.profileDirectory] = {
      ...(existing !== null && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}),
      name: entry.profileName,
      is_using_default_name: false,
    };
  }
  profile["info_cache"] = cache;
  localState["profile"] = profile;
  await writeJsonAtomic(localStateFile, localState);
}

/** Create the account's native Helium profile on first use; idempotent. */
export async function ensureProfile(
  account: AccountSummary,
  options: EnsureProfileOptions,
): Promise<RegistryEntry> {
  return withProfileStore(options.heliumRoot, () => ensureProfileLocked(account, options));
}

async function ensureProfileLocked(
  account: AccountSummary,
  options: EnsureProfileOptions,
): Promise<RegistryEntry> {
  const registry = await readRegistry(options.registryFile);
  const existing = registry[account.id];
  if (existing !== undefined) return { ...existing, profileName: profileNameFor(account) };
  const name = profileNameFor(account);
  const profileDirectory = nextProfileDirectory([
    ...await listHeliumProfileDirs(options.heliumRoot),
    ...await listHeliumProfileDirs(path.join(options.heliumRoot, "Pool Accounts")),
    ...Object.values(registry).map(e => e.profileDirectory),
  ]);
  const root = isolatedRoot(options.heliumRoot, profileDirectory);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  // Exclusive reservation, including unknown/orphaned roots from earlier runs.
  try { await mkdir(root, { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return ensureProfileLocked(account, options);
    throw e;
  }
  const entry: RegistryEntry = { profileDirectory, profileName: name, createdAt: Date.now(), isolated: true };
  await mkdir(path.join(root, profileDirectory), { mode: 0o700 });
  await writeJsonAtomic(path.join(root, profileDirectory, "Preferences"), { profile: { name } });
  await syncLocalStateProfiles(root, [entry]);
  registry[account.id] = entry;
  await writeJsonAtomic(options.registryFile, registry);
  return entry;
}

export interface OpenAccountBrowserOptions {
  accounts: readonly AccountSummary[];
  query: string;
  url?: string | undefined;
  dataDir: string;
  pluginId: string;
  vpnStatusFile?: string | null;
  heliumRoot?: string | undefined;
  fetcher?: GeoFetcher | undefined;
  readVpn?: VpnReader | undefined;
  listRunning?: (() => Promise<number[]>) | undefined;
  spawnImpl?: typeof spawn | undefined;
  exists?: ((file: string) => boolean) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platformName?: NodeJS.Platform | undefined;
  settleMs?: number | undefined;
  transportImpl?: ((options: TransportLaunch) => Promise<void>) | undefined;
}

export interface OpenAccountBrowserResult {
  accountId: string;
  provider: string;
  label: string;
  profileName: string;
  profileDirectory: string;
  profileDir: string;
  timezone: string | null;
  url: string;
  guarded: boolean;
}

export async function openAccountBrowser(
  options: OpenAccountBrowserOptions,
): Promise<OpenAccountBrowserResult> {
  const root = options.heliumRoot ?? heliumDataRoot(options.platformName ?? currentPlatform());
  return withProfileStore(root, async () => openAccountBrowserLocked({ ...options, heliumRoot: await realpath(root) }));
}

async function openAccountBrowserLocked(
  options: OpenAccountBrowserOptions,
): Promise<OpenAccountBrowserResult> {
  if ((options.platformName ?? currentPlatform()) === "win32") throw new Error("Account browser transport currently requires macOS or Linux.");
  const account = resolveAccount(options.accounts, options.query);
  const guarded = GUARDED_BROWSER_PROVIDERS.has(account.provider);
  if (guarded) {
    const file = options.vpnStatusFile ??
      path.join(homedir(), ".local", "state", "vpnks", "vpn-state.json");
    const evidence = await (options.readVpn ?? defaultVpnReader)(file);
    if (evidence.state !== "connected" || evidence.assurance !== "verified_ipv4") {
      throw new Error(
        `Refusing to open a browser for ${account.provider}: VPN evidence is "${evidence.assurance}" (${evidence.reason}). ` +
          "Bring the VPN guard to verified_ipv4 first.",
      );
    }
  }
  const geo = await fetchExitGeo(options.fetcher ?? defaultGeoFetcher);
  if (geo === null && guarded) {
    throw new Error(
      "Cannot determine the exit IP timezone; refusing to open a guarded account with a mismatched browser timezone.",
    );
  }
  const exists = options.exists ?? existsSync;
  const executable = browserExecutableCandidates(
    options.platformName ?? currentPlatform(),
    undefined,
    options.env ?? process.env,
  ).find((candidate) => exists(candidate));
  if (executable === undefined) {
    throw new Error(
      "Helium executable not found. Install it once (`brew install --cask helium-browser`) " +
        `or set ${BROWSER_PATH_ENV} to a Chromium-family binary.`,
    );
  }
  const heliumRoot = options.heliumRoot ?? heliumDataRoot(options.platformName ?? currentPlatform());
  const profileStore = path.join(options.dataDir, "plugins", options.pluginId, "browser-profiles");
  const registryFile = path.join(profileStore, "registry.json");
  const timezone = geo?.timezone ?? null;
  const url = safeBrowserUrl(options.url ?? PROVIDER_HOME[account.provider] ?? "about:blank");
  const entry = await ensureProfileLocked(account, { heliumRoot, registryFile });
  const root = isolatedRoot(heliumRoot, entry.profileDirectory);
  const socketPath = path.join(tmpdir(), `bb-pool-${createHash("sha256").update(root).digest("hex").slice(0, 24)}.sock`);
  const launch: TransportLaunch = {
    root, socketPath, executable, profileDirectory: entry.profileDirectory, timezone, url,
    settleMs: options.settleMs ?? 800, env: options.env ?? process.env,
  };
  if (!options.transportImpl && !options.spawnImpl) {
    try {
      if (await handoffBrowser(launch)) return browserResult(account, entry, root, timezone, url, guarded);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw e;
    }
  }
  // No supervisor proof: never trust a stale PID marker. Check this isolated root.
  const running = await (options.listRunning ?? (() => listRunningHelium(`--user-data-dir=${root}`)))();
  if (running.length) throw new Error("Account browser is running without a live transport supervisor; close only that account window and retry.");
  if (!entry.isolated) {
    const nativeRunning = await (options.listRunning ?? (() => listRunningNativeHelium(executable, heliumRoot)))();
    if (nativeRunning.length) throw new Error("One-time profile migration requires closing the original Helium; existing profiles remain untouched.");
    await migrateProfile(heliumRoot, root, entry);
    const registry = await readRegistry(registryFile);
    entry.isolated = true; registry[account.id] = entry;
    await writeJsonAtomic(registryFile, registry);
  }
  const profileInfo = await lstat(path.join(root, entry.profileDirectory));
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) throw new Error("Isolated browser profile is missing or unsafe; original bindings preserved.");
  await removeStaleBrowserSocket(socketPath);
  if (options.transportImpl) await options.transportImpl(launch);
  else if (options.spawnImpl) {
    // Hermetic launch adapter used by profile/CLI tests. Production always uses the supervisor.
    const child = options.spawnImpl(executable, [`--user-data-dir=${root}`, `--profile-directory=${entry.profileDirectory}`, url], {
      detached: true, stdio: "ignore", env: { ...launch.env, ...(timezone ? { TZ: timezone } : {}) },
    });
    await waitForLaunch(child, launch.settleMs, false);
  } else await startBrowserTransport(launch);
  return browserResult(account, entry, root, timezone, url, guarded);
}

export function safeBrowserUrl(value: string): string {
  if (value === "about:blank") return value;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || value.length > 8192) throw new Error("Browser URL must use HTTPS without embedded credentials.");
  return parsed.href;
}

function isolatedRoot(heliumRoot: string, directory: string): string {
  return path.join(heliumRoot, "Pool Accounts", directory);
}

async function migrateProfile(nativeRoot: string, root: string, entry: RegistryEntry): Promise<void> {
  const stage = `${root}.migrate-${randomUUID()}`;
  // A complete prior copy can be reused after a registry-write failure. Never
  // overwrite it: it may already contain newer user settings/authentication.
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe migrated profile root.");
    const completed = await readObject(path.join(root, "pool-migration.json"));
    if (completed.profileDirectory !== entry.profileDirectory || completed.createdAt !== entry.createdAt) throw new Error("Unverified existing migration; original profile preserved.");
    return;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    // Opaque filesystem copies, no inspection or logging of authentication data.
    await cp(path.join(nativeRoot, entry.profileDirectory), path.join(stage, entry.profileDirectory), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    try { await copyFile(path.join(nativeRoot, "Local State"), path.join(stage, "Local State"), constants.COPYFILE_EXCL); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await syncLocalStateProfiles(stage, [entry]);
    await writeJsonAtomic(path.join(stage, "pool-migration.json"), { profileDirectory: entry.profileDirectory, createdAt: entry.createdAt });
    await rename(stage, root);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function browserResult(account: AccountSummary, entry: RegistryEntry, root: string, timezone: string | null, url: string, guarded: boolean): OpenAccountBrowserResult {
  return {
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    profileName: entry.profileName,
    profileDirectory: entry.profileDirectory,
    profileDir: path.join(root, entry.profileDirectory),
    timezone,
    url,
    guarded,
  };
}

export interface BrowserProfileInfo {
  accountId: string;
  provider: string;
  label: string;
  email: string | null;
  profileName: string;
  profileDirectory: string;
  profileDir: string;
  exists: boolean;
  updatedAt: number | null;
}

/** Registry view: every pool account and the state of its Helium profile. */
export async function listBrowserProfiles(options: {
  accounts: readonly AccountSummary[];
  dataDir: string;
  pluginId: string;
  heliumRoot?: string | undefined;
}): Promise<BrowserProfileInfo[]> {
  const heliumRoot = options.heliumRoot ?? heliumDataRoot();
  const registry = await readRegistry(
    path.join(options.dataDir, "plugins", options.pluginId, "browser-profiles", "registry.json"),
  );
  const rows: BrowserProfileInfo[] = [];
  for (const account of options.accounts) {
    const entry = registry[account.id];
    const profileDirectory = entry?.profileDirectory ?? "";
    const profileDir = entry === undefined ? "" : path.join(entry.isolated ? isolatedRoot(heliumRoot, profileDirectory) : heliumRoot, profileDirectory);
    let updatedAt: number | null = null;
    if (entry !== undefined) {
      try {
        updatedAt = Math.round((await stat(profileDir)).mtimeMs);
      } catch {
        updatedAt = null;
      }
    }
    rows.push({
      accountId: account.id,
      provider: account.provider,
      label: account.label,
      email: account.email,
      profileName: entry === undefined ? "" : profileNameFor(account),
      profileDirectory,
      profileDir,
      exists: updatedAt !== null,
      updatedAt,
    });
  }
  return rows;
}

/** Fail fast when a fresh browser dies during the settle window. A quick clean
 * exit while an instance is already running is the normal process-singleton
 * handoff (the existing window navigates; the new TZ was verified to match). */
function waitForLaunch(
  child: ReturnType<typeof spawn>,
  settleMs: number,
  expectHandoff: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => {
      if (expectHandoff && code === 0) return finish();
      finish(new Error(`Browser exited during launch (code ${String(code)}).`));
    };
    const timer = setTimeout(() => {
      child.unref();
      finish();
    }, settleMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
