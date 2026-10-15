import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const metadataFiles = ['dist/server.meta.json', 'dist/app.meta.json'];

for (const path of metadataFiles) {
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(metadata.pluginId, 'oxi-projects', `${path} has the wrong plugin id`);
  assert.equal(
    metadata.pluginVersion,
    manifest.version,
    `${path} has the wrong plugin version`
  );
  assert.equal(
    metadata.sdkVersion,
    metadata.builtWith.pluginSdkVersion,
    `${path} has inconsistent SDK metadata`
  );
}

for (const path of ['dist/server.js', 'dist/app.js', 'dist/app.css']) {
  assert.ok((await stat(path)).size > 0, `${path} is empty`);
}

console.log('Taskboard build metadata is valid.');
