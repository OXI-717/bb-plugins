import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openAccountBrowser, listBrowserProfiles } from './browser-profiles.js';
import * as promises from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => { const real = await importOriginal<typeof import('node:fs/promises')>(); return { ...real, rename: vi.fn(real.rename) }; });
afterEach(() => vi.mocked(promises.rename).mockClear());
import type { AccountSummary } from './contracts.js';
const accounts = [
  { id: 'synthetic-a', provider: 'claude', email: 'a@example.test', label: 'A' },
  { id: 'synthetic-b', provider: 'kimi', email: 'b@example.test', label: 'B' },
] as AccountSummary[];
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'pool-shared-'))), heliumRoot = path.join(dir, 'helium'), dataDir = path.join(dir, 'data');
  const registryFile = path.join(dataDir, 'plugins', 'account-pool-balanced', 'browser-profiles', 'registry.json');
  mkdirSync(heliumRoot); mkdirSync(path.dirname(registryFile), { recursive: true });
  const launches: any[] = [];
  const options = { accounts, heliumRoot, dataDir, pluginId: 'account-pool-balanced', query: accounts[0]!.id,
    readVpn: async () => ({ state: 'connected', assurance: 'verified_ipv4', reason: 'ok', updatedAt: 1, probeAt: 1 } as const),
    fetcher: async () => ({ timezone: 'UTC' }), exists: () => true, listRunning: async () => [],
    transportImpl: async (launch: any) => { launches.push(launch); },
  };
  return { heliumRoot, registryFile, options, launches };
}
function oldIsolated(f: ReturnType<typeof fixture>) {
  const entry = { profileDirectory: 'Profile 1', profileName: 'Claude · a@example.test', createdAt: 1, isolated: true };
  const sourceRoot = path.join(f.heliumRoot, 'Pool Accounts', 'Profile 1'), source = path.join(sourceRoot, 'Profile 1');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'Preferences'), JSON.stringify({ profile: { name: entry.profileName }, custom: true }));
  writeFileSync(path.join(source, 'opaque'), 'current authorization fixture'); writeFileSync(path.join(sourceRoot, 'Local State'), '{}');
  mkdirSync(path.join(f.heliumRoot, 'Profile 1')); writeFileSync(path.join(f.heliumRoot, 'Profile 1', 'opaque'), 'old native fixture');
  writeFileSync(path.join(f.heliumRoot, 'Local State'), JSON.stringify({ custom: 'keep', profile: { info_cache: {
    'Profile 1': { name: entry.profileName }, 'Profile 99': { name: 'Personal' },
  } } }));
  writeFileSync(f.registryFile, JSON.stringify({ [accounts[0]!.id]: entry })); return source;
}
describe('shared native profile store', () => {
  it('registers all accounts in one native picker and launches the common root', async () => {
    const f = fixture(); await openAccountBrowser(f.options); const rows = await listBrowserProfiles(f.options);
    expect(rows.every(r => r.exists && path.dirname(r.profileDir) === f.heliumRoot)).toBe(true);
    const cache = JSON.parse(readFileSync(path.join(f.heliumRoot, 'Local State'), 'utf8')).profile.info_cache;
    expect(Object.values(cache).map((v: any) => v.name).sort()).toEqual(['Claude · a@example.test', 'Kimi · b@example.test']);
    expect(f.launches[0].root).toBe(f.heliumRoot);
    expect(f.launches[0].profileDirectories.sort()).toEqual(rows.map(r => r.profileDirectory).sort());
  });
  it('migrates current isolated data once, preserving original copies and unrelated picker entries', async () => {
    const f = fixture(), source = oldIsolated(f), first = await openAccountBrowser(f.options);
    expect(path.dirname(first.profileDir)).toBe(f.heliumRoot); expect(first.profileDir).not.toBe(path.join(f.heliumRoot, 'Profile 1'));
    expect(readFileSync(path.join(first.profileDir, 'opaque'), 'utf8')).toBe('current authorization fixture');
    expect(readFileSync(path.join(f.heliumRoot, 'Profile 1', 'opaque'), 'utf8')).toBe('old native fixture');
    expect(readFileSync(path.join(source, 'opaque'), 'utf8')).toBe('current authorization fixture');
    const state = JSON.parse(readFileSync(path.join(f.heliumRoot, 'Local State'), 'utf8'));
    expect(state.custom).toBe('keep'); expect(state.profile.info_cache['Profile 99'].name).toBe('Personal'); expect(state.profile.info_cache['Profile 1']).toBeUndefined();
    writeFileSync(path.join(first.profileDir, 'opaque'), 'newer native data');
    expect((await openAccountBrowser(f.options)).profileDir).toBe(first.profileDir);
    expect(readFileSync(path.join(first.profileDir, 'opaque'), 'utf8')).toBe('newer native data');
  });
  it('checks VPN even when starting with Kimi because the picker can switch to protected accounts', async () => {
    const f = fixture();
    await expect(openAccountBrowser({ ...f.options, query: accounts[1]!.id,
      readVpn: async () => ({ state: 'unknown', assurance: 'unverified', reason: 'missing', updatedAt: null, probeAt: null } as const),
    })).rejects.toThrow(/verified_ipv4/);
    expect(f.launches).toHaveLength(0); expect(existsSync(f.registryFile)).toBe(false);
  });
  it('refuses to mutate any profile while an unmanaged or legacy browser is running', async () => {
    const f = fixture(); oldIsolated(f); const before = readFileSync(f.registryFile, 'utf8');
    await expect(openAccountBrowser({ ...f.options, listRunning: async () => [42] })).rejects.toThrow(/clos|running/i);
    expect(readFileSync(f.registryFile, 'utf8')).toBe(before); expect(f.launches).toHaveLength(0);
  });
  it('rejects missing or symlinked source profiles without using stale native data', async () => {
    const f = fixture(); oldIsolated(f); const registry = JSON.parse(readFileSync(f.registryFile, 'utf8'));
    registry[accounts[0]!.id].profileDirectory = 'Profile 2'; writeFileSync(f.registryFile, JSON.stringify(registry));
    await expect(openAccountBrowser(f.options)).rejects.toThrow(); expect(f.launches).toHaveLength(0);
    mkdirSync(path.join(f.heliumRoot, 'Pool Accounts', 'Profile 2'), { recursive: true });
    symlinkSync(path.join(f.heliumRoot, 'Profile 1'), path.join(f.heliumRoot, 'Pool Accounts', 'Profile 2', 'Profile 2'));
    await expect(openAccountBrowser(f.options)).rejects.toThrow(); expect(f.launches).toHaveLength(0);
  });
  it('recovers after registry commit fails without overwriting the completed native copy', async () => {
    const f = fixture(); oldIsolated(f);
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    let failed = false;
    vi.mocked(promises.rename).mockImplementation(async (a, b) => {
      if (String(b) === f.registryFile && !failed) { failed = true; throw new Error('synthetic registry failure'); }
      return realRename(a, b);
    });
    try {
      await expect(openAccountBrowser(f.options)).rejects.toThrow('synthetic registry failure');
      expect(f.launches).toHaveLength(0);
      const plan = JSON.parse(readFileSync(path.join(path.dirname(f.registryFile), 'native-migration-plan.json'), 'utf8'));
      const target = path.join(f.heliumRoot, plan[accounts[0]!.id].profileDirectory);
      writeFileSync(path.join(target, 'opaque'), 'completed copy retained');
      expect(JSON.parse(readFileSync(f.registryFile, 'utf8'))[accounts[0]!.id].isolated).toBe(true);
      const result = await openAccountBrowser(f.options);
      expect(result.profileDir).toBe(target);
      expect(readFileSync(path.join(target, 'opaque'), 'utf8')).toBe('completed copy retained');
      expect(existsSync(path.join(path.dirname(f.registryFile), 'registry.before-native.json'))).toBe(true);
      expect(existsSync(path.join(path.dirname(f.registryFile), 'local-state.before-native.json'))).toBe(true);
    } finally { vi.mocked(promises.rename).mockImplementation(realRename); }
  });
  it('rejects incompatible encryption metadata before copying a profile', async () => {
    const f = fixture(); oldIsolated(f);
    writeFileSync(path.join(f.heliumRoot, 'Pool Accounts', 'Profile 1', 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'synthetic-only' } }));
    const before = readFileSync(f.registryFile, 'utf8');
    await expect(openAccountBrowser(f.options)).rejects.toThrow(/encryption/);
    expect(readFileSync(f.registryFile, 'utf8')).toBe(before); expect(f.launches).toHaveLength(0);
  });
  it('does not replace an unknown directory at a planned migration destination', async () => {
    const f = fixture(); oldIsolated(f);
    mkdirSync(path.join(f.heliumRoot, 'Profile 101'));
    writeFileSync(path.join(f.heliumRoot, 'Profile 101', 'opaque'), 'foreign data');
    writeFileSync(path.join(path.dirname(f.registryFile), 'native-migration-plan.json'), JSON.stringify({
      [accounts[0]!.id]: { profileDirectory: 'Profile 101', profileName: 'A', createdAt: 1, sourceDirectory: 'Profile 1' },
    }));
    await expect(openAccountBrowser(f.options)).rejects.toThrow(/occupied/);
    expect(readFileSync(path.join(f.heliumRoot, 'Profile 101', 'opaque'), 'utf8')).toBe('foreign data');
  });

});
