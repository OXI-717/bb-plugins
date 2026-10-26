// Integration: the pilot core against bb's REAL WebSocketManager
// (apps/app/src/lib/ws.ts) and its partysocket. Fake sockets, no network.
// Run from <bb-checkout>/apps/app:  <bb-checkout>/node_modules/.bin/tsx <this file>
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFederation } from "../federation-core.mjs";
import { createEnv, CONFIG, REMOTE_BOOTSTRAP, PRIMARY_BOOTSTRAP } from "./fake-env.mjs";

const BB = process.env.BB_CHECKOUT;
if(!BB)throw new Error("Set BB_CHECKOUT to a BB 0.46.1 source checkout with dependencies installed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: String(e) }); }
}

const env = createEnv({
  primary: { "GET /api/v1/sidebar-bootstrap": PRIMARY_BOOTSTRAP },
  remote: { "GET /api/v1/sidebar-bootstrap": REMOTE_BOOTSTRAP },
});
const win: any = env.win;
// bb code reads `window` and the global `WebSocket` identifier.
(globalThis as any).window = win;
Object.defineProperty(globalThis, "WebSocket", { configurable: true, get: () => win.WebSocket, set: (v) => { win.WebSocket = v; } });
const { WebSocketManager } = createRequire(import.meta.url)(`${BB}/apps/app/src/lib/ws.ts`);

const manager = new WebSocketManager(); // default browser events: listens to window "online"
const changed: any[] = [];
const connected: any[] = [];
manager.onChanged((m: any) => changed.push(m));
manager.onConnected((e: any) => connected.push(e));
manager.connect();
await sleep(20);
const core = env.FakeWS.all.at(-1)!;
core.serverOpen();
await sleep(5);
manager.subscribe({ kind: "thread-list" });
manager.subscribe({ kind: "thread-detail", threadId: "thr_local01" });

// --- plugin generation mounts late ---
const rows = new Map();
const fed = createFederation({ win, config: CONFIG, pluginId: "federation-pilot", setRowStatus: (id: string, s: any) => (s ? rows.set(id, s) : rows.delete(id)) });
await (await win.fetch("/api/v1/sidebar-bootstrap")).json(); // learn remote ids as bb's refetch would
// bb only pings when the socket was quiet for 5 s; emulate quiet time.
(manager as any).lastServerActivityAt = Date.now() - 6000;
env.runTimers(); // bounded `online` nudge -> manager probe -> ping -> capture
await sleep(1600); // partysocket reconnect delay

await check("online nudge made the native manager send; core socket captured and closed", () => {
  assert.equal(fed.state.counters.captured, 1);
  assert.equal(core.readyState, 3);
});
const [primary, remote] = env.FakeWS.all.slice(-2);
await check("partysocket reconnected through the federated constructor", () => {
  assert.equal(primary.url, "ws://primary.invalid/ws");
  assert.match(remote.url, /\/api\/v1\/plugins\/federation-pilot\/http\/remote-ws$/);
});
primary.serverOpen(); remote.serverOpen();
await sleep(10);
remote.serverSend({ type: "fedprobe-remote-ready" });
manager.subscribe({ kind: "thread-detail", threadId: "thr_remote01" });
await sleep(5);
await check("subscriptions replayed by bb are split by owner", () => {
  const subs = (ws: any) => ws.sent.map((x: string) => JSON.parse(x)).filter((m: any) => m.type === "subscribe").map((m: any) => m.target.threadId ?? m.target.kind);
  assert.deepEqual(new Set(subs(primary)), new Set(["thread-list", "thr_local01"]));
  assert.deepEqual(new Set(subs(remote)), new Set(["thread-list", "thr_remote01"]));
});
await check("manager connected (real method), reconnect wave fired", () => {
  assert.equal(manager.getConnectionState(), "connected");
  assert.equal(connected.at(-1)?.reconnected, true);
});
changed.length = 0;
remote.serverSend({ type: "changed", entity: "thread", id: "thr_remote01", changes: ["events-appended"] });
remote.serverSend({ type: "changed", entity: "system", changes: ["config-changed"] });
primary.serverSend({ type: "changed", entity: "thread", id: "thr_local01", changes: ["status-changed"] });
await check("remote change reaches bb's handler; remote system change is filtered", () => {
  assert.deepEqual(changed.map((m) => `${m.entity}:${m.id}`), ["thread:thr_remote01", "thread:thr_local01"]);
});
await check("row status grey while remote ready", () => assert.equal(rows.get("thr_remote01")?.tone, "default"));
remote.close(1006);
await sleep(5);
await check("remote outage: bb stays connected, row status red", () => {
  assert.equal(manager.getConnectionState(), "connected");
  assert.equal(primary.readyState, 1);
  assert.equal(rows.get("thr_remote01")?.tone, "error");
});

// --- disable the plugin ---
changed.length = 0;
const before = env.FakeWS.all.length;
fed.dispose();
await sleep(1600);
await check("dispose: ordinary changed emitted, globals restored, bb reconnects natively", () => {
  assert.ok(changed.some((m) => m.entity === "project" && m.id === "proj_remote01"));
  assert.equal(win.WebSocket, env.FakeWS);
  const after = env.FakeWS.all.slice(before);
  assert.equal(after.length, 1, "exactly one new native socket");
  assert.equal(after[0].url, "ws://primary.invalid/ws");
  assert.equal(rows.size, 0);
  assert.equal(env.timers.size, 0);
});
manager.disconnect();
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : " — " + r.error}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
