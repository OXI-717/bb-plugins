/** Per-account browser profiles for the Account Pooler, on a dedicated Helium.
 *
 * One Helium installation carries one native profile per pool account (the
 * standard profile picker works for manual use). Profiles are named
 * "<Provider> · <email>" so the window always shows which account it serves.
 * `open` launches Helium with the profile and a process timezone aligned to
 * the current exit IP. All IO is dependency-injected so tests stay hermetic.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { request as httpRequest } from "undici";
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
  // family 4: the verified VPN evidence covers the IPv4 route; do not let the
  // geo probe itself leak through a non-VPN IPv6 path on dual-stack hosts.
  const res = await httpRequest(url, {
    method: "GET",
    headersTimeout: 4000,
    bodyTimeout: 4000,
    // @ts-expect-error undici forwards connect options; family is runtime-valid
    connect: { family: 4 },
  });
  if (res.statusCode !== 200) {
    await res.body.dump();
    return null;
  }
  const text = await res.body.text();
  if (text.length > GEO_MAX_BYTES) return null;
  return JSON.parse(text) as unknown;
};

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
    if (typeof timezone !== "string" || timezone === "") return null;
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
}

type Registry = Record<string, RegistryEntry>;

async function readRegistry(file: string): Promise<Registry> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Registry;
  } catch {
    return {};
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
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
  } catch {
    return [];
  }
}

const execFileAsync = promisify(execFile);

/** Pids of running Helium main processes. Anchored at the end so helper
 *  binaries ("Helium Helper.app/Contents/MacOS/Helium Helper") don't match. */
export async function listRunningHelium(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "Helium.app/Contents/MacOS/Helium$"]);
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

interface LaunchMarker {
  tz: string;
  pid: number;
  at: number;
}

async function readLaunchMarker(file: string): Promise<LaunchMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.tz !== "string" || typeof record.pid !== "number") return null;
    return { tz: record.tz, pid: record.pid, at: typeof record.at === "number" ? record.at : 0 };
  } catch {
    return null;
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
  let localState: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(localStateFile, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      localState = parsed as Record<string, unknown>;
    }
  } catch {
    // first launch — file absent, created here
  }
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
  const registry = await readRegistry(options.registryFile);
  const existing = registry[account.id];
  if (existing !== undefined) return existing;
  const name = profileNameFor(account);
  const profileDirectory = nextProfileDirectory(await listHeliumProfileDirs(options.heliumRoot));
  const profileDir = path.join(options.heliumRoot, profileDirectory);
  await mkdir(profileDir, { recursive: true });
  await writeJsonAtomic(path.join(profileDir, "Preferences"), {
    profile: { name },
  });
  const entry: RegistryEntry = { profileDirectory, profileName: name, createdAt: Date.now() };
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
  const markerFile = path.join(profileStore, "last-launch.json");
  const running = await (options.listRunning ?? listRunningHelium)();
  const timezone = geo?.timezone ?? null;
  if (timezone !== null && running.length > 0) {
    // SIP hides process env on macOS, so trust is established by our own marker:
    // the running instance is accepted only when WE started it with this timezone
    // and the recorded pid is still a live Helium process.
    const marker = await readLaunchMarker(markerFile);
    const trusted = marker !== null && marker.tz === timezone && running.includes(marker.pid);
    if (!trusted) {
      throw new Error(
        "Helium is already running with an unverified timezone. " +
          "Quit Helium (Cmd+Q) and open the profile again so the exit timezone applies.",
      );
    }
  }
  const entry = await ensureProfile(account, { heliumRoot, registryFile });
  // Helium rewrites Local State live: sync the picker only while it is closed.
  if (running.length === 0) {
    const registry = await readRegistry(registryFile);
    await syncLocalStateProfiles(heliumRoot, Object.values(registry));
  }
  const url = options.url ?? PROVIDER_HOME[account.provider] ?? "about:blank";
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (timezone !== null) env.TZ = timezone;
  const wasRunning = running.length > 0;
  const child = (options.spawnImpl ?? spawn)(executable, [
    `--profile-directory=${entry.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    // The verified VPN evidence covers IPv4 only; keep the browser off any
    // non-VPN IPv6 route on dual-stack hosts (system-level IPv6 off is the
    // full guarantee, this flag is the in-process constraint).
    "--disable-ipv6",
    url,
  ], { detached: true, stdio: "ignore", env });
  await waitForLaunch(child, options.settleMs ?? 800, wasRunning);
  if (timezone !== null) {
    // On handoff the spawned process exits immediately, so record the pid of the
    // already-running main process, not the transient child.
    const trustedPid = wasRunning ? running[0] : child.pid;
    if (trustedPid !== undefined) {
      await writeJsonAtomic(markerFile, { tz: timezone, pid: trustedPid, at: Date.now() });
    }
  }
  return {
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    profileName: entry.profileName,
    profileDirectory: entry.profileDirectory,
    profileDir: path.join(heliumRoot, entry.profileDirectory),
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
    const profileDir = entry === undefined ? "" : path.join(heliumRoot, profileDirectory);
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
      profileName: entry?.profileName ?? "",
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
