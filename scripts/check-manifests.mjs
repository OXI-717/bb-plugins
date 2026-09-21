import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const marketplace = read('marketplace.json');
const collection = read('.bb/plugins.json');
const seen = new Set();
const releaseTags = new Set();
assert.equal(marketplace.name, 'oxi-public');
assert.equal(marketplace.schemaVersion, 1);
assert.equal(collection.schemaVersion, 1);
assert.equal(collection.plugins.length, marketplace.plugins.length);

for (const entry of marketplace.plugins) {
  assert.match(entry.id, /^[a-z][a-z0-9-]*$/);
  assert(!seen.has(entry.id), `duplicate plugin: ${entry.id}`);
  seen.add(entry.id);
  assert.match(entry.icon?.url ?? '', /^\.\/icons\/[a-z0-9-]+\.svg$/);
  assert(existsSync(entry.icon.url), `missing icon: ${entry.id}`);
  const source = entry.source.git;
  assert.equal(source.url, 'https://github.com/OXI-717/bb-plugins.git');
  assert.equal(source.subdir, `plugins/${entry.id}`);
  assert.equal(source.tagPrefix, `${entry.id}/`);
  assert(collection.plugins.some((p) => p.name === entry.id && p.source === `./${source.subdir}`));
  const manifest = read(`${source.subdir}/package.json`);
  const lock = read(`${source.subdir}/package-lock.json`);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(source.range, `^${manifest.version}`);
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  assert.equal(manifest.license, 'MIT');
  for (const kind of ['server', 'app']) {
    const file = manifest.bb[kind];
    assert(file && !file.includes('..') && !file.startsWith('/'));
    assert(existsSync(resolve(source.subdir, file)));
  }
  assert(existsSync(`${source.subdir}/PLUGIN_OVERVIEW.md`));
  releaseTags.add(`${entry.id}/v${manifest.version}`);
}
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert(releaseTags.has(process.env.GITHUB_REF_NAME), 'tag must match a plugin version');
}
console.log(`Validated ${seen.size} public plugin(s).`);
