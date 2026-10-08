import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

it('uses project-bound Devin credentials without exposing them to the agent environment', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pool-devin-launcher-'));
  const token = 'P'.repeat(43);
  let receivedToken: string | undefined;
  let receivedPath: string | undefined;
  const server = createServer((req, res) => {
    receivedToken = req.headers['x-bb-account-pool-token'] as string;
    receivedPath = req.url;
    req.resume(); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    await writeFile(path.join(dir, 'devin'), `#!${process.execPath}
const fs = require('node:fs');
(async () => {
  if (process.env.OXI_DEVIN_POOL_TOKEN || process.env.OXI_DEVIN_POOL_URL) process.exit(7);
  const credentials = fs.readFileSync(process.env.XDG_DATA_HOME + '/devin/credentials.toml', 'utf8');
  const settings = Object.fromEntries(credentials.trim().split(String.fromCharCode(10)).map(line => { const [name, value] = line.split(' = '); return [name, JSON.parse(value)]; }));
  const localAuth = settings.windsurf_api_key;
  const url = settings.api_server_url;
  const response = await fetch(url + '/exa.test.Service/Chat', {method:'POST',headers:{authorization:'Basic ' + localAuth},body:'{}'});
  process.exit(response.ok ? 0 : 8);
})().catch(() => process.exit(9));
`, { mode: 0o700 });
    const child = spawn(process.execPath, [path.resolve('scripts/devin-pool.mjs'), '--pool-url', 'http://127.0.0.1:1', '--token-file', path.join(dir, 'missing'), '--', '-p', 'synthetic'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OXI_DEVIN_POOL_URL: `http://127.0.0.1:${address.port}/pool`, OXI_DEVIN_POOL_TOKEN: token },
      stdio: 'pipe',
    });
    let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    expect(stderr).toBe(''); expect(exit).toBe(0); expect(receivedToken).toBe(token);
    expect(receivedPath).toBe('/pool/devin/exa.test.Service/Chat');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
