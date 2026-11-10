import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = resolve('scripts/check-manifests.mjs');
function check(mutate = () => {}, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oxi-manifest-test-'));
  try {
    for (const path of ['plugins', 'icons', '.bb', 'marketplace.json']) {
      cpSync(path, join(root, path), { recursive: true, filter: (p) => !/\/(node_modules|dist|coverage)(\/|$)/.test(p) });
    }
    const edit = (path, fn) => {
      const file = join(root, path);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      fn(data);
      writeFileSync(file, JSON.stringify(data));
    };
    mutate(edit);
    return spawnSync(process.execPath, [checker, root], { env: { ...process.env, GITHUB_REF_TYPE: 'branch', ...env }, encoding: 'utf8', timeout: 10000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('all packages and a matching release tag pass', () => {
  const result = check(); assert.equal(result.status, 0, result.stderr);
  const version = JSON.parse(readFileSync('plugins/federation-pilot/package.json')).version;
  assert.equal(check(undefined, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `federation-pilot/v${version}` }).status, 0);
});
const cases = {
  'missing OXI prefix': (m) => { m.plugins[0].displayName = 'Account Pool'; },
  'non-English description': (m) => { m.plugins[0].description = 'Описание плагина'; },
  'empty description': (m) => { m.plugins[0].description = ''; },
  'branch pin': (m) => { m.plugins[0].source.git.ref = 'main'; },
  'commit pin': (m) => { m.plugins[0].source.git.commit = 'abc123'; },
  'wrong tag prefix': (m) => { m.plugins[0].source.git.tagPrefix = 'other/'; },
  'wrong range': (m) => { m.plugins[0].source.git.range = '^99.0.0'; },
  'missing package listing': (m) => { m.plugins.pop(); },
  'duplicate listing': (m) => { m.plugins[1] = m.plugins[0]; },
};
for (const [name, mutate] of Object.entries(cases)) {
  test(`rejects ${name}`, () => assert.notEqual(check((edit) => edit('marketplace.json', mutate)).status, 0));
}
test('rejects package text and lockfile drift', () => {
  for (const mutate of [d => { d.bb.name = 'OXI Different'; }, d => { d.bb.description = 'A different English description for this plugin.'; }]) {
    assert.notEqual(check(edit => edit('plugins/vpn-guard/package.json', mutate)).status, 0);
  }
  assert.notEqual(check(edit => edit('plugins/vpn-guard/package-lock.json', d => { d.version = '99.0.0'; })).status, 0);
});
test('rejects unknown and stale release tags', () => {
  for (const tag of ['unknown/v1.0.0', 'federation-pilot/v0.2.5']) {
    assert.notEqual(check(undefined, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag }).status, 0);
  }
});
