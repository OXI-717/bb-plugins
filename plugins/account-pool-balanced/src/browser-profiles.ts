/** Per-account persistent browser profiles for the Account Pooler.
 *
 * Opens the provider's own web UI for one pool account in an isolated Chrome
 * profile whose process timezone matches the current exit IP timezone. All IO
 * is dependency-injected so tests stay hermetic: no network, no spawning.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import path from "node:path";
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

const DEFAULT_GEO_URL = "https://ipinfo.io/json";
const GEO_URL_ENV = "POOL_BROWSER_GEO_URL";
const GEO_MAX_BYTES = 65536;

export interface ExitGeo {
  timezone: string;
  city: string | null;
  country: string | null;
}

export type GeoFetcher = (url: string) => Promise<unknown>;
export type VpnReader = (file: string) => Promise<VpnEvidence>;

const defaultVpnReader: VpnReader = (file) => readVpnEvidence(file, Date.now());

const defaultGeoFetcher: GeoFetcher = async (url) => {
  const res = await httpRequest(url, {
    method: "GET",
    headersTimeout: 4000,
    bodyTimeout: 4000,
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

/** Dedicated browser for pool profiles: the Playwright-cached Chromium build,
 * never the user's daily Chrome. Override with POOL_BROWSER_CHROMIUM. */
const BROWSER_PATH_ENV = "POOL_BROWSER_CHROMIUM";

/** Candidate executables: env override first, then newest cached Chromium. */
export function browserExecutableCandidates(
  platformName: NodeJS.Platform = currentPlatform(),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env[BROWSER_PATH_ENV];
  const out: string[] = override ? [override] : [];
  const cacheRoots = platformName === "darwin"
    ? [path.join(home, "Library", "Caches", "ms-playwright")]
    : platformName === "win32"
      ? [path.join(home, "AppData", "Local", "ms-playwright")]
      : [path.join(home, ".cache", "ms-playwright")];
  const subPaths = platformName === "darwin"
    ? [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      ]
    : platformName === "win32"
      ? ["chrome-win/chrome.exe"]
      : ["chrome-linux/chrome", "chrome-linux64/chrome"];
  for (const root of cacheRoots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root)
        .filter((name) => name.startsWith("chromium-"))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const entry of entries) {
      for (const sub of subPaths) out.push(path.join(root, entry, sub));
    }
  }
  return out;
}

export interface OpenAccountBrowserOptions {
  accounts: readonly AccountSummary[];
  query: string;
  url?: string | undefined;
  dataDir: string;
  pluginId: string;
  vpnStatusFile?: string | null;
  fetcher?: GeoFetcher | undefined;
  readVpn?: VpnReader | undefined;
  spawnImpl?: typeof spawn | undefined;
  platformName?: NodeJS.Platform | undefined;
  exists?: ((file: string) => boolean) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  settleMs?: number | undefined;
}

export interface OpenAccountBrowserResult {
  accountId: string;
  provider: string;
  label: string;
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
      "Chromium executable not found. Install the shared build once with " +
        "`npx playwright install chromium` or set POOL_BROWSER_CHROMIUM to a Chromium-family binary.",
    );
  }
  const profileDir = path.join(
    options.dataDir,
    "plugins",
    options.pluginId,
    "browser-profiles",
    account.id,
  );
  await mkdir(profileDir, { recursive: true });
  const url = options.url ?? PROVIDER_HOME[account.provider] ?? "about:blank";
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (geo !== null) env.TZ = geo.timezone;
  const child = (options.spawnImpl ?? spawn)(executable, [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ], { detached: true, stdio: "ignore", env });
  await waitForLaunch(child, options.settleMs ?? 800);
  return {
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    profileDir,
    timezone: geo?.timezone ?? null,
    url,
    guarded,
  };
}

export interface BrowserProfileInfo {
  accountId: string;
  provider: string;
  label: string;
  email: string | null;
  profileDir: string;
  exists: boolean;
  updatedAt: number | null;
}

/** Registry view: every pool account and the state of its browser profile. */
export async function listBrowserProfiles(options: {
  accounts: readonly AccountSummary[];
  dataDir: string;
  pluginId: string;
}): Promise<BrowserProfileInfo[]> {
  const root = path.join(
    options.dataDir,
    "plugins",
    options.pluginId,
    "browser-profiles",
  );
  const rows: BrowserProfileInfo[] = [];
  for (const account of options.accounts) {
    const profileDir = path.join(root, account.id);
    let updatedAt: number | null = null;
    try {
      updatedAt = Math.round((await stat(profileDir)).mtimeMs);
    } catch {
      // profile not created yet — expected state, not an error
    }
    rows.push({
      accountId: account.id,
      provider: account.provider,
      label: account.label,
      email: account.email,
      profileDir,
      exists: updatedAt !== null,
      updatedAt,
    });
  }
  return rows;
}

/** Fail fast when the browser process dies during the settle window. */
function waitForLaunch(
  child: ReturnType<typeof spawn>,
  settleMs: number,
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
    const onExit = (code: number | null) =>
      finish(new Error(`Browser exited during launch (code ${String(code)}).`));
    const timer = setTimeout(() => {
      child.unref();
      finish();
    }, settleMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
