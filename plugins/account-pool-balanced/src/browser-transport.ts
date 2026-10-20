/** A detached supervisor owns one browser and its IPv4-only HTTPS proxy.
 * It survives plugin reloads; its private Unix socket is also the handoff proof.
 * No PID/JSON marker can authorize joining an unrelated browser process.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { lstat, unlink } from "node:fs/promises";

// Kept as JavaScript so the installed bundle needs no private runtime/TS loader.
// All input arrives on stdin or a private socket, never through shell expansion.
export const BROWSER_WORKER = String.raw`
const { createServer } = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let input = '', primary, proxy, control, socketPath, closing = false;
const sockets = new Set();
function track(s) {
  if (sockets.size >= 512) { s.destroy(); return; }
  sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s));
  s.setTimeout(300000, () => s.destroy());
}
function close() {
  if (closing) return; closing = true;
  for (const s of sockets) s.destroy();
  if (proxy) proxy.close(); if (control) control.close();
  if (socketPath) { try { fs.unlinkSync(socketPath); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
process.on('uncaughtException', close);
function listen(server, address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(address, () => { server.off('error', reject); resolve(); });
  });
}
async function boot(cfg) {
  socketPath = cfg.socketPath;
  proxy = createServer({ maxHeaderSize: 16384, requestTimeout: 4000, headersTimeout: 4000 }, (_q, r) => {
    r.writeHead(405); r.end();
  });
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    // CONNECT is the only egress path. IPv6 literals never reach net.connect.
    const m = /^([^\s/:\[\]@?#]+):(\d{1,5})$/.exec(req.url || '');
    if (!m || +m[2] < 1 || +m[2] > 65535) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const upstream = net.connect({ host: m[1], port: +m[2], family: 4 });
    track(upstream);
    const timer = setTimeout(() => { upstream.destroy(); client.destroy(); }, 4000);
    upstream.once('connect', () => {
      clearTimeout(timer); client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => { clearTimeout(timer); client.destroy(); });
    client.on('close', () => upstream.destroy());
  });
  await listen(proxy, { port: 0, host: '127.0.0.1' });
  const port = proxy.address().port;
  const args = [
    '--user-data-dir=' + cfg.root, '--profile-directory=' + cfg.profileDirectory,
    '--no-first-run', '--no-default-browser-check',
    '--proxy-server=http://127.0.0.1:' + port,
    '--proxy-bypass-list=<-loopback>', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
  ];
  const browserEnv = {};
  for (const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','DBUS_SESSION_BUS_ADDRESS','LANG','LANGUAGE','LC_ALL','LC_CTYPE','TZ']) {
    if (process.env[key] !== undefined) browserEnv[key] = process.env[key];
  }
  function launch(url, first) {
    return new Promise((resolve, reject) => {
      const child = spawn(cfg.executable, [...args, url], { stdio: 'ignore', env: browserEnv });
      if (first) primary = child;
      let settled = false;
      const done = err => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => done(), cfg.settleMs);
      child.on('error', () => { done(new Error('Browser spawn failed.')); if (first) close(); });
      child.on('exit', code => {
        if (first) { done(new Error('Browser exited during launch.')); close(); }
        else done(code === 0 ? null : new Error('Browser handoff failed.'));
      });
    });
  }
  control = net.createServer(s => {
    track(s); s.setTimeout(5000, () => s.destroy()); let data = '';
    s.on('data', chunk => {
      data += chunk; if (data.length > 16384) { s.destroy(); return; }
      if (!data.includes('\n')) return;
      s.removeAllListeners('data');
      Promise.resolve().then(async () => {
        const cmd = JSON.parse(data);
        if (cmd.timezone !== cfg.timezone || cmd.executable !== cfg.executable || !primary || primary.exitCode !== null) {
          throw new Error('Close this account browser window before changing its exit timezone or executable.');
        }
        if (typeof cmd.url !== 'string' || !(cmd.url === 'about:blank' || /^https:\/\//.test(cmd.url))) throw new Error('Invalid browser URL.');
        await launch(cmd.url, false); s.end(JSON.stringify({ ok: true }) + '\n');
      }).catch(e => s.end(JSON.stringify({ error: e.message }) + '\n'));
    });
  });
  await listen(control, socketPath); fs.chmodSync(socketPath, 0o600);
  await launch(cfg.url, true);
  process.stdout.write(JSON.stringify({ ok: true, port }) + '\n');
  process.stdout.end();
}
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => {
  input += chunk; if (input.length > 32768) close();
});
process.stdin.on('end', () => { boot(JSON.parse(input)).catch(close); });
`;

export interface TransportLaunch {
  socketPath: string;
  root: string;
  executable: string;
  profileDirectory: string;
  timezone: string | null;
  url: string;
  settleMs: number;
  env: NodeJS.ProcessEnv;
}

/** null means no supervisor. An existing but unresponsive endpoint fails closed. */
export async function handoffBrowser(options: TransportLaunch): Promise<boolean> {
  try {
    const info = await lstat(options.socketPath);
    if (!info.isSocket() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("Unsafe browser control socket.");
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Browser supervisor did not respond.")); }, 5000);
    socket.on("connect", () => socket.write(JSON.stringify({ timezone: options.timezone, executable: options.executable, url: options.url }) + "\n"));
    socket.on("data", chunk => { data += chunk; if (data.length > 16384) socket.destroy(new Error("Invalid supervisor response.")); });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(data) as { ok?: boolean; error?: string };
        if (result.ok !== true) throw new Error(result.error ?? "Browser handoff failed.");
        resolve(true);
      } catch (e) { reject(e); }
    });
  });
}

export async function startBrowserTransport(options: TransportLaunch): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", BROWSER_WORKER], {
      detached: true, stdio: ["pipe", "pipe", "ignore"], env: { ...options.env, ELECTRON_RUN_AS_NODE: "1", ...(options.timezone ? { TZ: options.timezone } : {}) },
    });
    let data = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Browser supervisor startup timed out.")); }, 10000);
    const fail = () => { clearTimeout(timer); reject(new Error("Browser supervisor failed to launch.")); };
    child.once("error", fail); child.once("exit", fail);
    child.stdin.on("error", () => {});
    const { env: _env, ...config } = options;
    child.stdin.end(JSON.stringify(config));
    child.stdout.on("data", chunk => {
      data += chunk;
      if (data.length > 16384) { child.kill(); fail(); return; }
      if (!data.includes("\n")) return;
      try {
        if (JSON.parse(data).ok !== true) throw new Error();
        clearTimeout(timer); child.off("exit", fail); child.off("error", fail);
        child.stdout.destroy(); child.unref(); resolve();
      } catch { child.kill(); fail(); }
    });
  });
}

/** Stale sockets are only removed after the caller has proved no browser uses the root. */
export async function removeStaleBrowserSocket(socketPath: string): Promise<void> {
  await unlink(socketPath).catch(e => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; });
}
