/** Per-account browser profiles for the Account Pooler, on a dedicated Helium.
 *
 * One Helium process serves native profiles in a shared user-data root.
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
import { promisify, isDeepStrictEqual } from "node:util";
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
  sessionRestoreConfigured?: true;
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
    if (!/^Profile [1-9]\d{0,6}$/.test(e.profileDirectory) || typeof e.profileName !== "string" || e.profileName.length > 1024 || !Number.isFinite(e.createdAt) || (e.isolated !== undefined && e.isolated !== true) || (e.sessionRestoreConfigured !== undefined && e.sessionRestoreConfigured !== true)) throw new Error("Invalid browser registry binding.");
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

/** Chromium's restore switch only applies at process startup. Configure each
 * managed profile once while closed, including profiles selected later in its picker. */
async function prepareSessionRestore(options: EnsureProfileOptions, assertClosed: () => Promise<void>): Promise<void> {
  const registry = await readRegistry(options.registryFile);
  for (const entry of Object.values(registry)) {
    if (entry.isolated || entry.sessionRestoreConfigured) continue;
    const directory = path.join(options.heliumRoot, entry.profileDirectory);
    await requireDirectory(directory);
    const file = path.join(directory, "Preferences");
    const prefs = await readObject(file);
    const session = prefs.session === undefined ? {} : prefs.session;
    if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error("Invalid browser session preferences; originals preserved.");
    await assertClosed();
    await writeJsonAtomic(file, { ...prefs, session: { ...session, restore_on_startup: 1 } });
    // Publish only after the preference write succeeds; interrupted setup retries.
    // Later user changes to startup behavior must not be overwritten.
    entry.sessionRestoreConfigured = true;
    await writeJsonAtomic(options.registryFile, registry);
  }
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
  if (existing !== undefined) {
    if (existing.isolated) throw new Error("Close Helium once to migrate the account profiles together.");
    await requireDirectory(path.join(options.heliumRoot, existing.profileDirectory));
    const updated = { ...existing, profileName: profileNameFor(account) };
    if (existing.profileName !== updated.profileName) {
      registry[account.id] = updated;
      await syncLocalStateProfiles(options.heliumRoot, [updated]);
      await writeJsonAtomic(options.registryFile, registry);
    }
    return updated;
  }
  const state = await readObject(path.join(options.heliumRoot, "Local State"));
  const cache = nativeProfileCache(state);
  const profileDirectory = nextProfileDirectory([
    ...await listHeliumProfileDirs(options.heliumRoot), ...Object.keys(cache),
    ...Object.values(registry).map(e => e.profileDirectory),
  ]);
  const name = profileNameFor(account);
  const entry: RegistryEntry = { profileDirectory, profileName: name, createdAt: Date.now() };
  const directory = path.join(options.heliumRoot, profileDirectory);
  // Exclusive allocation: even an orphan from a failed write is never reused.
  await mkdir(directory, { mode: 0o700 });
  await writeJsonAtomic(path.join(directory, "Preferences"), { profile: { name } });
  await syncLocalStateProfiles(options.heliumRoot, [entry]);
  registry[account.id] = entry;
  await writeJsonAtomic(options.registryFile, registry);
  return entry;
}

function nativeProfileCache(state: Record<string, unknown>): Record<string, unknown> {
  const profile = state.profile;
  if (profile === undefined) return {};
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Invalid native profile state.");
  const cache = (profile as Record<string, unknown>).info_cache;
  if (cache === undefined) return {};
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) throw new Error("Invalid native profile cache.");
  return cache as Record<string, unknown>;
}

async function requireDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Missing or unsafe browser profile directory; originals preserved.");
}

/** Called only while all native and legacy account browsers are closed.
 * A durable destination plan plus an opaque completed copy permits retry after
 * any write failure. No source profile is removed or overwritten.
 */
async function migrateToNative(options: EnsureProfileOptions, assertClosed: () => Promise<void>): Promise<void> {
  const { heliumRoot, registryFile } = options;
  const registry = await readRegistry(registryFile);
  if (!Object.values(registry).some(e => e.isolated)) return;
  const stateFile = path.join(heliumRoot, "Local State");
  const state = await readObject(stateFile), cache = { ...nativeProfileCache(state) };
  const planFile = path.join(path.dirname(registryFile), "native-migration-plan.json");
  const plan = await readRegistry(planFile) as Record<string, RegistryEntry & { sourceDirectory?: string }>;
  for (const [id, item] of Object.entries(plan)) {
    const original = registry[id];
    if (!original || !/^Profile [1-9]\d{0,6}$/.test(item.sourceDirectory ?? "") || original.createdAt !== item.createdAt ||
        original.profileDirectory !== (original.isolated ? item.sourceDirectory : item.profileDirectory)) {
      throw new Error("Native migration plan does not match the profile registry; originals preserved.");
    }
  }
  // Exact pre-migration metadata snapshots stay private alongside the registry.
  for (const [source, backup] of [[registryFile, "registry.before-native.json"], [stateFile, "local-state.before-native.json"]]) {
    try { await copyFile(source!, path.join(path.dirname(registryFile), backup!), constants.COPYFILE_EXCL); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !(source === stateFile && (e as NodeJS.ErrnoException).code === "ENOENT")) throw e; }
  }
  const replacements = new Map<string, string>();
  for (const [id, entry] of Object.entries(registry)) {
    if (!entry.isolated) continue;
    const sourceRoot = isolatedRoot(heliumRoot, entry.profileDirectory);
    await requireDirectory(path.join(heliumRoot, "Pool Accounts"));
    await requireDirectory(sourceRoot);
    const source = path.join(sourceRoot, entry.profileDirectory);
    await requireDirectory(source);
    const sourceState = await readObject(path.join(sourceRoot, "Local State"));
    if (!isDeepStrictEqual(state.os_crypt, sourceState.os_crypt)) {
      throw new Error("Browser encryption settings differ; profile migration was not attempted.");
    }
    let item = plan[id];
    if (!item) {
      const directory = nextProfileDirectory([
        ...await listHeliumProfileDirs(heliumRoot), ...Object.keys(cache),
        ...Object.values(registry).map(e => e.profileDirectory), ...Object.values(plan).map(e => e.profileDirectory),
      ]);
      item = { profileDirectory: directory, profileName: entry.profileName, createdAt: entry.createdAt, sourceDirectory: entry.profileDirectory };
      plan[id] = item;
      await writeJsonAtomic(planFile, plan);
    }
    const destination = path.join(heliumRoot, item.profileDirectory);
    const receipt = { accountId: id, createdAt: entry.createdAt, sourceDirectory: entry.profileDirectory };
    let complete = false;
    try {
      await requireDirectory(destination);
      if (!isDeepStrictEqual(await readObject(path.join(destination, ".pool-native-origin.json")), receipt)) {
        throw new Error("Native migration destination is already occupied; original profiles preserved.");
      }
      complete = true;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (!complete) {
      await assertClosed();
      const stage = path.join(heliumRoot, `.pool-native-${randomUUID()}`);
      try {
        await cp(source, stage, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        await assertClosed();
        await writeJsonAtomic(path.join(stage, ".pool-native-origin.json"), receipt);
        // The store lease and closed-browser prerequisite exclude cooperating writers.
        // Refuse a newly occupied destination rather than replacing it.
        try { await lstat(destination); throw new Error("Native migration destination became occupied."); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        await rename(stage, destination);
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    const sourceInfo = nativeProfileCache(sourceState)[entry.profileDirectory];
    cache[item.profileDirectory] = {
      ...(sourceInfo && typeof sourceInfo === "object" && !Array.isArray(sourceInfo) ? sourceInfo : {}),
      name: entry.profileName, is_using_default_name: false,
    };
    const oldInfo = cache[entry.profileDirectory];
    if (oldInfo && typeof oldInfo === "object" && (oldInfo as Record<string, unknown>).name === entry.profileName) {
      delete cache[entry.profileDirectory]; replacements.set(entry.profileDirectory, item.profileDirectory);
    }
    registry[id] = { profileDirectory: item.profileDirectory, profileName: entry.profileName, createdAt: entry.createdAt };
  }
  const profile: Record<string, unknown> = { ...((state.profile ?? {}) as Record<string, unknown>), info_cache: cache };
  if (typeof profile.last_used === "string") profile.last_used = replacements.get(profile.last_used) ?? profile.last_used;
  if (Array.isArray(profile.last_active_profiles)) profile.last_active_profiles = [...new Set(profile.last_active_profiles.map(p => typeof p === "string" ? replacements.get(p) ?? p : p))];
  await assertClosed();
  await writeJsonAtomic(stateFile, { ...state, profile });
  await writeJsonAtomic(registryFile, registry);
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
  // Native switching can reach any account without calling Pooler again.
  const guarded = true;
  if (guarded) {
    const file = options.vpnStatusFile ??
      path.join(homedir(), ".local", "state", "vpnks", "vpn-state.json");
    const evidence = await (options.readVpn ?? defaultVpnReader)(file);
    if (evidence.state !== "connected" || evidence.assurance !== "verified_ipv4") {
      throw new Error(
        `Refusing to open a browser for ${account.provider}: VPN evidence is "${evidence.assurance}" (${evidence.reason}). ` +
          "Bring the VPN guard to verified_ipv4 before opening the shared account browser.",
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
  const url = safeBrowserUrl(options.url ?? "about:blank");
  const root = heliumRoot;
  const socketPath = path.join(tmpdir(), `bb-pool-${createHash("sha256").update(root).digest("hex").slice(0, 24)}.sock`);
  let registry = await readRegistry(registryFile);
  let entry = registry[account.id];
  const launchFor = (selected: RegistryEntry): TransportLaunch => ({
    root, socketPath, executable, profileDirectory: selected.profileDirectory,
    profileDirectories: Object.values(registry).filter(e => !e.isolated).map(e => e.profileDirectory),
    timezone, url, settleMs: options.settleMs ?? 800, env: options.env ?? process.env,
  });
  if (entry && !entry.isolated && !options.transportImpl && !options.spawnImpl) {
    await requireDirectory(path.join(root, entry.profileDirectory));
    try {
      if (await handoffBrowser(launchFor(entry))) return browserResult(account, entry, root, timezone, url, guarded);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw e;
    }
  }
  // A native or older isolated process may be writing either side of migration.
  // Never join it without the current shared supervisor capability.
  const assertClosed = async () => {
    const running = await (options.listRunning ?? (() => listRunningHelium(executable)))();
    if (running.length) throw new Error("Helium is running without a live transport supervisor for this profile. Close Helium once before updating the shared profile list.");
  };
  await assertClosed();
  await migrateToNative({ heliumRoot, registryFile }, assertClosed);
  // Register the full account list while Local State is closed, so switching
  // does not depend on which account happened to be opened first.
  for (const current of options.accounts) {
    await assertClosed();
    await ensureProfileLocked(current, { heliumRoot, registryFile });
  }
  await prepareSessionRestore({ heliumRoot, registryFile }, assertClosed);
  registry = await readRegistry(registryFile);
  entry = registry[account.id]!;
  await assertClosed();
  await syncLocalStateProfiles(root, Object.values(registry));
  const launch = launchFor(entry);
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
