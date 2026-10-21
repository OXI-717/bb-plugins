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
const { randomUUID } = require('node:crypto');
let input = '', primary, proxy, control, socketPath, closing = false;
const sockets = new Set(), selectors = new Set();
function track(s) {
  if (sockets.size >= 512) { s.destroy(); return; }
  sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s));
  s.setTimeout(300000, () => s.destroy());
}
function close() {
  if (closing) return; closing = true;
  if (primary && primary.exitCode === null) primary.kill();
  for (const child of selectors) if (child.exitCode === null) child.kill();
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
  const shared = Array.isArray(cfg.profileDirectories);
  const allowedProfiles = new Set(cfg.profileDirectories || [cfg.profileDirectory]);
  if (!allowedProfiles.size || [...allowedProfiles].some(p => !/^Profile [1-9]\d{0,6}$/.test(p)) || !allowedProfiles.has(cfg.profileDirectory)) throw new Error('Invalid browser profiles.');
  const protocol = shared ? 3 : 2;
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
    '--no-first-run', '--no-default-browser-check', '--no-startup-window', '--remote-debugging-pipe',
    '--proxy-server=http://127.0.0.1:' + port,
    '--proxy-bypass-list=<-loopback>', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
  ];
  const browserEnv = {};
  for (const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','DBUS_SESSION_BUS_ADDRESS','LANG','LANGUAGE','LC_ALL','LC_CTYPE','TZ']) {
    if (process.env[key] !== undefined) browserEnv[key] = process.env[key];
  }
  let nextCommand = 0, output = '', navigationCount = 0, generation = 0;
  let sawPage = false, quitting = false, navigationUncertain = false, idleTimer;
  const pages = new Set(), commands = new Map();
  function command(method, params, timeoutMs = 3500, sessionId) {
    if (commands.size >= 32) return Promise.reject(new Error('Browser navigation is busy.'));
    return new Promise((resolve, reject) => {
      const id = ++nextCommand;
      const timer = setTimeout(() => {
        commands.delete(id); reject(new Error('Browser navigation timed out.'));
      }, timeoutMs);
      commands.set(id, { resolve, reject, timer });
      primary.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', err => {
        if (!err) return;
        const pending = commands.get(id);
        if (pending) { clearTimeout(pending.timer); commands.delete(id); pending.reject(new Error('Browser navigation channel closed.')); }
      });
    });
  }
  async function selectProfile(profileDirectory) {
    if (!allowedProfiles.has(profileDirectory)) throw new Error('Unknown account browser profile; close Helium once to refresh its profile list.');
    const marker = 'data:text/html,<!--pool-profile-' + randomUUID() + '-->';
    // Helium rewrites about:blank fragments into chrome://newtab; a local empty
    // HTML document preserves the unique marker without any network request.
    // Chromium's default CDP context changes when the user switches profiles.
    // Select a native profile using a harmless unique blank page, then navigate
    // that exact target through the inherited pipe. Auth URLs never enter argv.
    await new Promise((resolve, reject) => {
      const child = spawn(cfg.executable, [
        '--user-data-dir=' + cfg.root, '--profile-directory=' + profileDirectory,
        '--no-first-run', '--no-default-browser-check', marker
      ], { stdio: 'ignore', env: browserEnv });
      selectors.add(child);
      const timer = setTimeout(() => { child.kill(); reject(new Error('Browser profile selection timed out.')); }, 2000);
      child.once('error', () => { clearTimeout(timer); selectors.delete(child); reject(new Error('Browser profile selection failed.')); });
      child.once('exit', code => { clearTimeout(timer); selectors.delete(child); code === 0 ? resolve() : reject(new Error('Browser profile selection failed.')); });
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const result = await command('Target.getTargets', {}, 1000);
      const matches = Array.isArray(result?.targetInfos) ? result.targetInfos.filter(t => t?.type === 'page' && t.url === marker) : [];
      if (matches.length === 1 && typeof matches[0].targetId === 'string') return matches[0].targetId;
      if (matches.length > 1) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Selected browser profile was not confirmed; no authorization link was sent.');
  }
  async function navigate(url, initial = false, profileDirectory = cfg.profileDirectory) {
    if (quitting) throw new Error('Account browser is closing. Open it again after it finishes.');
    if (!allowedProfiles.has(profileDirectory)) throw new Error('Unknown account browser profile; close Helium once to refresh its profile list.');
    if (navigationCount >= 8) throw new Error('Browser navigation is busy.');
    navigationCount++; generation++; clearTimeout(idleTimer);
    try {
      if (shared) {
        const targetId = await selectProfile(profileDirectory);
        const attached = await command('Target.attachToTarget', { targetId, flatten: true }, 1000);
        if (typeof attached?.sessionId !== 'string') throw new Error('Selected browser profile could not be attached.');
        try {
          const result = await command('Page.navigate', { url }, 2000, attached.sessionId);
          if (typeof result?.frameId !== 'string' || result.errorText) throw new Error('Browser navigation failed.');
        } finally { await command('Target.detachFromTarget', { sessionId: attached.sessionId }, 1000).catch(() => {}); }
      } else {
        const result = await command('Target.createTarget', { url, newWindow: initial }, initial ? 7000 : 3500);
        if (typeof result?.targetId !== 'string') throw new Error('Browser navigation failed.');
      }
      sawPage = true;
    } catch (error) {
      // A timed-out command may still create a window later. Do not auto-quit
      // this browser while its navigation outcome is unknown. Normal quit works.
      navigationUncertain = true; throw error;
    } finally { navigationCount--; checkIdle(); }
  }
  function checkIdle(attempt = 0) {
    clearTimeout(idleTimer);
    if (!sawPage || pages.size || navigationCount || navigationUncertain || quitting) return;
    idleTimer = setTimeout(async () => {
      const version = generation;
      const retry = () => { if (attempt < 2 && version === generation) checkIdle(attempt + 1); };
      try {
        // A fresh snapshot covers windows created outside Pooler and target churn.
        const result = await command('Target.getTargets', {});
        if (!Array.isArray(result?.targetInfos) || result.targetInfos.some(t => !t || typeof t.type !== 'string')) { retry(); return; }
        const stillIdle = () => version === generation && !navigationCount && !navigationUncertain && !pages.size && !quitting;
        if (!stillIdle() || result.targetInfos.some(t => t.type === 'page')) return;
        // Responses and target events can arrive in separate pipe chunks. Let
        // queued window events invalidate the snapshot before committing to quit.
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!stillIdle()) return;
        quitting = true;
        // Browser.close alone can leave a no-startup-window Chromium in the Dock.
        // Pipe EOF releases its remote-debugging lifetime and requests normal quit.
        // Keep the proxy alive until the browser has exited and saved its profile.
        await command('Browser.close', {}).catch(() => {});
        primary.stdio[3].end();
        setTimeout(close, 10000).unref();
      } catch {
        // Retry a transient observation failure, but never turn unknown into quit.
        retry();
      }
    }, 250 * 2 ** attempt);
  }
  function targetEvent(message) {
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
      const target = message.params?.targetInfo;
      if (target?.type !== 'page' || typeof target.targetId !== 'string') return;
      sawPage = true; pages.add(target.targetId); generation++; clearTimeout(idleTimer);
    } else if (message.method === 'Target.targetDestroyed' && pages.delete(message.params?.targetId)) {
      generation++; checkIdle();
    }
  }
  function launch() {
    // No URL or remote debugging TCP port enters argv. Only inherited pipes
    // carry navigation commands, including one-time authorization links.
    primary = spawn(cfg.executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: browserEnv });
    primary.on('error', close); primary.on('exit', close);
    primary.stdio[3].on('error', close);
    primary.stdio[4].on('error', close); primary.stdio[4].on('end', () => { if (!quitting) close(); });
    primary.stdio[4].setEncoding('utf8');
    primary.stdio[4].on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) { close(); return; }
      let end;
      while ((end = output.indexOf('\0')) >= 0) {
        let response;
        try { response = JSON.parse(output.slice(0, end)); } catch { close(); return; }
        output = output.slice(end + 1);
        if (response.method) { targetEvent(response); continue; }
        const pending = commands.get(response.id);
        if (!pending) continue;
        clearTimeout(pending.timer); commands.delete(response.id);
        // Protocol diagnostics may echo the URL; never forward them.
        if (response.error || !response.result || typeof response.result !== 'object') pending.reject(new Error('Browser navigation failed.'));
        else pending.resolve(response.result);
      }
    });
  }
  control = net.createServer(s => {
    track(s); s.setTimeout(5000, () => s.destroy()); let data = '', negotiated = false;
    s.on('data', chunk => {
      data += chunk; if (data.length > 16384) { s.destroy(); return; }
      if (!data.includes('\n')) return;
      const message = data; data = '';
      Promise.resolve().then(async () => {
        const cmd = JSON.parse(message);
        if (!negotiated && cmd.type === 'hello') { negotiated = true; s.write(JSON.stringify({ protocol, navigation: 'pipe', ...(shared ? { profiles: 'native' } : {}) }) + '\n'); return; }
        s.removeAllListeners('data');
        if (!negotiated || cmd.protocol !== protocol) throw new Error('Close this account browser and reopen it after updating Pooler.');
        if (cmd.timezone !== cfg.timezone || cmd.executable !== cfg.executable || !primary || primary.exitCode !== null) {
          throw new Error('Close this account browser window before changing its exit timezone or executable.');
        }
        if (typeof cmd.url !== 'string' || !(cmd.url === 'about:blank' || /^https:\/\//.test(cmd.url))) throw new Error('Invalid browser URL.');
        await navigate(cmd.url, false, shared ? cmd.profileDirectory : cfg.profileDirectory); s.end(JSON.stringify({ ok: true }) + '\n');
      }).catch(e => s.end(JSON.stringify({ error: e.message }) + '\n'));
    });
  });
  await listen(control, socketPath); fs.chmodSync(socketPath, 0o600);
  launch();
  await command('Target.setDiscoverTargets', { discover: true });
  await navigate(cfg.url, true);
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
  /** Native profiles sharing this supervised browser; absent for legacy isolated tests. */
  profileDirectories?: readonly string[];
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
  // Negotiate on this same socket before sending any URL. Replacing the
  // socket path between handshake and navigation cannot select a legacy worker.
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let data = "", negotiated = false, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error("Browser supervisor did not respond.")), 5000);
    socket.on("connect", () => socket.write(JSON.stringify({ type: "hello" }) + "\n"));
    socket.on("data", chunk => {
      data += chunk;
      if (data.length > 16384) { finish(new Error("Invalid supervisor response.")); return; }
      let end: number;
      while (!settled && (end = data.indexOf("\n")) >= 0) {
        let result: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(data.slice(0, end));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          result = parsed as Record<string, unknown>;
        } catch { finish(new Error("Invalid supervisor response.")); return; }
        data = data.slice(end + 1);
        if (!negotiated) {
          if (result.protocol !== (options.profileDirectories ? 3 : 2) || result.navigation !== "pipe" || (options.profileDirectories && result.profiles !== "native")) {
            finish(new Error("Close this account browser and reopen it after updating Pooler.")); return;
          }
          negotiated = true;
          socket.write(JSON.stringify({ protocol: options.profileDirectories ? 3 : 2, profileDirectory: options.profileDirectory, timezone: options.timezone, executable: options.executable, url: options.url }) + "\n");
        } else if (result.ok === true) finish();
        else finish(new Error(typeof result.error === "string" ? result.error : "Browser handoff failed."));
      }
    });
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Browser supervisor closed before confirming navigation.")));
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
