import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handoffBrowser, startBrowserTransport, type TransportLaunch } from "./browser-transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(extraEnv: NodeJS.ProcessEnv = {}): Promise<TransportLaunch> {
  const root = await mkdtemp(path.join(tmpdir(), "pb-"));
  const executable = path.join(root, "browser");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.on('uncaughtException', e => { fs.writeFileSync(process.argv[1] + '.error', String(e)); process.exit(1); });
const args = process.argv.slice(2);
const root = args.find(a => a.startsWith('--user-data-dir=')).slice(16);
try { fs.writeFileSync(root + '/pid', String(process.pid), { flag: 'wx' }); } catch { process.exit(0); }
fs.writeFileSync(root + '/capture.json', JSON.stringify({ args, tz: process.env.TZ, secretPresent: process.env.POOL_SYNTHETIC_SECRET !== undefined, electronFlag: process.env.ELECTRON_RUN_AS_NODE }));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 15000);
setTimeout(() => process.exit(0), ${Number(extraEnv.FIXTURE_EXIT_MS ?? 15000)});
`, { mode: 0o700 });
  const options: TransportLaunch = {
    root, socketPath: path.join(root, "control.sock"), executable,
    profileDirectory: "Profile 1", timezone: "UTC", url: "about:blank", settleMs: 100,
    env: { PATH: process.env.PATH, ...extraEnv },
  };
  cleanup.push(async () => {
    try { process.kill(Number(await readFile(path.join(root, "pid"), "utf8")), "SIGTERM"); } catch {}
    for (let i = 0; i < 100; i++) {
      try { await access(options.socketPath); await delay(10); } catch { break; }
    }
    await rm(root, { recursive: true, force: true });
  });
  return options;
}
async function capture(options: TransportLaunch): Promise<{ args: string[]; tz: string; secretPresent: boolean; electronFlag?: string }> {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await readFile(path.join(options.root, "capture.json"), "utf8")); }
    catch { await delay(10); }
  }
  throw new Error("Fixture browser did not write capture: " + options.root);
}
function tunnel(port: number, target: string, payload = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: "127.0.0.1", port }); let data = "";
    const timer = setTimeout(() => { s.destroy(); reject(new Error("Tunnel timed out")); }, 2500);
    s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${payload}`));
    s.on("data", chunk => { data += chunk; if (data.includes("fixture-response") || data.includes("400")) s.destroy(); });
    s.on("error", reject); s.on("close", () => { clearTimeout(timer); resolve(data); });
  });
}
async function proxyPort(options: TransportLaunch): Promise<number> {
  const { args } = await capture(options);
  return Number(new URL(args.find(a => a.startsWith("--proxy-server="))!.slice(15)).port);
}

describe("detached browser supervisor", () => {
  it("survives the caller and reopens only the same timezone through its private socket", async () => {
    const options = await fixture({ POOL_SYNTHETIC_SECRET: "synthetic-private-value" });
    expect(await handoffBrowser(options)).toBe(false);
    await startBrowserTransport(options);
    await capture(options);
    expect(await handoffBrowser({ ...options, url: "https://example.test/" })).toBe(true);
    await expect(handoffBrowser({ ...options, timezone: "Europe/Paris" })).rejects.toThrow(/timezone/);
    const { args, tz } = await capture(options);
    expect(tz).toBe("UTC");
    const envCapture = await capture(options);
    expect(envCapture.secretPresent).toBe(false);
    expect(envCapture.electronFlag).toBeUndefined();
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(args).not.toContain("--disable-ipv6");
  });
  it("uses a real IPv4 CONNECT socket and rejects an IPv6-only trap", async () => {
    const options = await fixture();
    const peers: string[] = []; const sockets = new Set<Socket>();
    const server = createServer(s => { sockets.add(s); peers.push(s.remoteFamily!); s.on("data", () => s.end("fixture-response")); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await startBrowserTransport(options);
    const port = await proxyPort(options);
    expect(await tunnel(port, `localhost:${(server.address() as { port: number }).port}`, "hello")).toContain("fixture-response");
    expect(peers).toEqual(["IPv4"]);
    expect(await tunnel(port, "[::1]:443")).toContain("400");
    expect(await tunnel(port, "does-not-exist.invalid:443")).not.toContain("200 Connection");
  });
  it("does not resolve an IPv6-only DNS destination onto an IPv6 trap", async () => {
    let hits = 0;
    const trap = createServer(s => { hits++; s.destroy(); });
    await new Promise<void>(resolve => trap.listen(0, "::1", resolve));
    cleanup.push(async () => { await new Promise<void>(resolve => trap.close(() => resolve())); });
    const options = await fixture();
    const preload = path.join(options.root, "dns.cjs");
    await writeFile(preload, `const dns = require('node:dns'); const original = dns.lookup;
      dns.lookup = (host, opts, cb) => {
        if (host !== 'ipv6.fixture.test') return original(host, opts, cb);
        if (opts.family === 4) return cb(Object.assign(new Error('IPv4 unavailable'), { code: 'ENOTFOUND' }));
        if (opts.all) cb(null, [{ address: '::1', family: 6 }]); else cb(null, '::1', 6);
      };`);
    options.env.NODE_OPTIONS = "--require=" + preload;
    await startBrowserTransport(options);
    const response = await tunnel(await proxyPort(options), `ipv6.fixture.test:${(trap.address() as { port: number }).port}`);
    expect(response).not.toContain("200 Connection"); expect(hits).toBe(0);
  });
  it("closes proxy/control resources after a late browser exit", async () => {
    const options = await fixture({ FIXTURE_EXIT_MS: "500" });
    await startBrowserTransport(options);
    const port = await proxyPort(options);
    await delay(650);
    expect(await handoffBrowser(options)).toBe(false);
    await expect(tunnel(port, "127.0.0.1:443")).rejects.toThrow();
  });
  it("rejects missing executable without leaving a control socket", async () => {
    const options = await fixture(); options.executable += "-missing";
    await expect(startBrowserTransport(options)).rejects.toThrow(/failed/);
    await expect(access(options.socketPath)).rejects.toThrow();
  });
});
