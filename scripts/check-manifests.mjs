import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
if (process.argv[2]) process.chdir(process.argv[2]);
const english = (value) => typeof value === 'string' && /^[\x20-\x7e]+$/.test(value);
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
  assert(english(entry.displayName) && /^OXI [A-Z0-9]/.test(entry.displayName), `OXI English name required: ${entry.id}`);
  assert(english(entry.description) && entry.description.trim() === entry.description && entry.description.length >= 30 && entry.description.length <= 140, `English description required: ${entry.id}`);
  assert.deepEqual(Object.keys(entry.source), ['git']);
  assert.match(entry.icon?.url ?? '', /^\.\/icons\/[a-z0-9-]+\.svg$/);
  assert(existsSync(entry.icon.url), `missing icon: ${entry.id}`);
  const source = entry.source.git;
  assert.deepEqual(Object.keys(source).sort(), ['range', 'subdir', 'tagPrefix', 'url']);
  assert.equal(source.url, 'https://github.com/OXI-717/bb-plugins.git');
  assert.equal(source.subdir, `plugins/${entry.id}`);
  assert.equal(source.tagPrefix, `${entry.id}/`);
  assert(collection.plugins.some((p) => p.name === entry.id && p.source === `./${source.subdir}`));
  const manifest = read(`${source.subdir}/package.json`);
  assert.equal(manifest.name, `bb-plugin-${entry.id}`, 'persisted plugin ID must match the catalog');
  assert.equal(manifest.bb.name, entry.displayName);
  assert.equal(manifest.bb.description, entry.description);
  const lock = read(`${source.subdir}/package-lock.json`);
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(source.range, `^${manifest.version}`);
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  assert.equal(manifest.license, 'MIT');
  for (const kind of ['server', 'app']) {
    const file = manifest.bb[kind];
    if (kind === 'app' && file === undefined) continue;
    assert(file && !file.includes('..') && !file.startsWith('/'));
    assert(existsSync(resolve(source.subdir, file)));
  }
  assert(existsSync(`${source.subdir}/PLUGIN_OVERVIEW.md`));
  releaseTags.add(`${entry.id}/v${manifest.version}`);
}
const packages = readdirSync('plugins').filter((id) => existsSync(`plugins/${id}/package.json`));
assert.deepEqual([...seen].sort(), packages.sort(), 'every plugin must be listed');
assert.deepEqual(collection.plugins.map((p) => p.name).sort(), [...seen].sort(), 'collection IDs must match exactly');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert(releaseTags.has(process.env.GITHUB_REF_NAME), 'tag must match a plugin version');
}
console.log(`Validated ${seen.size} public plugin(s).`);
