#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const usage = 'Usage: node scripts/devin-pool.mjs --pool-url HTTPS_URL --token-file PRIVATE_FILE -- [devin arguments]';
const separator = process.argv.indexOf('--');
const options = process.argv.slice(2, separator < 0 ? undefined : separator);
if (separator < 0 || options.length !== 4 || options[0] !== '--pool-url' || options[2] !== '--token-file') {
  console.error(usage); process.exit(2);
}
const poolUrl = new URL(options[1]);
if (poolUrl.protocol !== 'https:' && !(poolUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(poolUrl.hostname))) {
  throw new Error('Use HTTPS for a remote pool. HTTP is permitted only on loopback.');
}
if (poolUrl.search || poolUrl.hash || poolUrl.username || poolUrl.password) throw new Error('Pool URL must not contain credentials, query or fragment.');
const tokenStat = await fs.stat(options[3]);
if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0) throw new Error('Pool token file must be a private regular file (mode 0600).');
const token = (await fs.readFile(options[3], 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new Error('Invalid pool token file.');
const localKey = randomBytes(32).toString('base64url');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'devin-pool-'));
await fs.chmod(profile, 0o700);
const dataHome = path.join(profile, 'data');
const configHome = path.join(profile, 'config');
await fs.mkdir(path.join(dataHome, 'devin'), { recursive: true, mode: 0o700 });
await fs.mkdir(configHome, { mode: 0o700 });
const MAX_BODY = 16 * 1024 * 1024;
const server = createServer(async (req, res) => {
  const fail = (status) => { res.writeHead(status); res.end(); };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'POST' || !/^\/exa\.[A-Za-z0-9_.]+\/[A-Za-z0-9]+$/u.test(url.pathname)) { fail(404); return; }
    if (url.pathname.endsWith('/BatchRecordAnalyticsEvents')) { res.writeHead(204); res.end(); return; }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Basic ${localKey}` && !new RegExp(`^Basic ${localKey}-[A-Za-z0-9_-]{43}$`, 'u').test(auth)) { fail(401); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { fail(413); return; } chunks.push(chunk); }
    const target = new URL(`${poolUrl.pathname.replace(/\/$/u, '')}/devin${url.pathname}${url.search}`, poolUrl);
    const headers = new Headers();
    for (const name of ['content-type', 'content-encoding', 'connect-content-encoding', 'connect-accept-encoding', 'user-agent']) {
      if (req.headers[name]) headers.set(name, String(req.headers[name]));
    }
    headers.set('x-bb-account-pool-token', token);
    const upstream = await fetch(target, { method: 'POST', headers, body: Buffer.concat(chunks), redirect: 'error' });
    const responseHeaders = {};
    for (const [name, value] of upstream.headers) {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
  } catch { if (!res.headersSent) fail(502); else res.destroy(); }
});
let child;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await fs.writeFile(path.join(dataHome, 'devin', 'credentials.toml'),
    `windsurf_api_key = "${localKey}"\napi_server_url = "http://127.0.0.1:${address.port}"\n`, { mode: 0o600 });
  child = spawn('devin', process.argv.slice(separator + 1), {
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome },
    stdio: 'inherit',
  });
  const forward = (signal) => { if (child && !child.killed) child.kill(signal); };
  process.on('SIGINT', forward); process.on('SIGTERM', forward);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  process.exitCode = code ?? 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
