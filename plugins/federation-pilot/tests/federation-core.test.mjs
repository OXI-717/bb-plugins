// Narrow tests for federation-core.mjs. Run: node --test tests/federation-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createFederation, loadConfig } from "../federation-core.mjs";
import { createEnv, CONFIG, REMOTE_BOOTSTRAP, PRIMARY_BOOTSTRAP, R } from "./fake-env.mjs";

const PID = "federation-pilot";
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup({ config = CONFIG, primary = {}, remote = {} } = {}) {
  const env = createEnv({
    primary: { "GET /api/v1/sidebar-bootstrap": PRIMARY_BOOTSTRAP, ...primary },
    remote: { "GET /api/v1/sidebar-bootstrap": REMOTE_BOOTSTRAP, ...remote },
  });
  const rows = new Map();
  const log = [];
  const nativeFetch = env.win.fetch;
  const NativeWS = env.win.WebSocket;
  const fed = createFederation({
    win: env.win, config, pluginId: PID,
    setRowStatus: (id, s) => (s === null ? rows.delete(id) : rows.set(id, s)),
    log: (kind, data) => log.push({ kind, ...data }),
  });
  return { env, fed, rows, log, nativeFetch, NativeWS, fetch: (...a) => env.win.fetch(...a) };
}
async function boot(t) {
  const r = await t.fetch("/api/v1/sidebar-bootstrap");
  return r.json();
}

// ---------------- config ----------------
test("disabled or invalid config installs nothing", async () => {
  const env = createEnv({ primary: { "GET /api/v1/plugins/federation-pilot/http/config": { enabled: false } } });
  const f = env.win.fetch;
  assert.equal(await loadConfig({ win: env.win, pluginId: PID }), null);
  assert.equal(env.win.fetch, f);
  const env2 = createEnv({ primary: { "GET /api/v1/plugins/federation-pilot/http/config": { enabled: true, projectId: "proj_personal" } } });
  await assert.rejects(loadConfig({ win: env2.win, pluginId: PID }), /concrete remote project/);
  const env3 = createEnv({ primary: { "GET /api/v1/plugins/federation-pilot/http/config": { enabled: true, projectId: "proj_remote01", label: "Remote Alpha" } } });
  assert.deepEqual(await loadConfig({ win: env3.win, pluginId: PID }), { enabled: true, projectId: "proj_remote01", label: "Remote Alpha", allowWrites: false });
});

// ---------------- lists ----------------
test("sidebar-bootstrap merges one remote project, relabels it, keeps primary Personal", async () => {
  const t = setup();
  const b = await boot(t);
  assert.deepEqual(b.projects.map((p) => p.name), ["Local", "Remote project · Remote Alpha"]);
  assert.equal(b.personalProject.id, "proj_personal");
  assert.deepEqual(b.sections.map((s) => s.id), ["sec_local01"]);
  assert.ok(t.fed.isRemote("thr_remote01") && t.fed.isRemote("env_remote01"));
  assert.ok(!t.fed.isRemote("thr_local01"));
});

test("remote list failure keeps local rows and last known remote rows; nothing remote goes to primary", async () => {
  const t = setup();
  await boot(t);
  t.env.win.remoteBridgeDown = true;
  const b = await boot(t);
  assert.deepEqual(b.projects.map((p) => p.id), ["proj_local01", "proj_remote01"]);
  assert.equal(t.fed.state.remoteState, "offline");
  assert.ok(t.env.primaryCalls().every((c) => !c.path.includes("remote")));
});

test("scoped collections go to their owner only", async () => {
  const t = setup({ remote: { "GET /api/v1/threads": [{ id: "thr_remote02", projectId: "proj_remote01" }], "GET /api/v1/hosts": [{ id: "host_remote01" }] } });
  await boot(t);
  t.env.calls.length = 0;
  await t.fetch("/api/v1/threads?projectId=proj_remote01&archived=false");
  await t.fetch("/api/v1/threads?projectId=proj_local01");
  assert.deepEqual(t.env.calls.map((c) => `${c.to} ${c.path}`), [
    "bridge /api/v1/threads?projectId=proj_remote01&archived=false",
    "primary /api/v1/threads?projectId=proj_local01",
  ]);
  assert.ok(t.fed.isRemote("thr_remote02"), "ids learned from remote list");
});

// ---------------- path / system routes ----------------
test("remote ids in path route to the bridge with the exact envelope; failures never fall back", async () => {
  const t = setup({ remote: { "GET /api/v1/threads/thr_remote01/timeline": { rows: [] } } });
  await boot(t);
  t.env.calls.length = 0;
  const ok = await t.fetch("/api/v1/threads/thr_remote01/timeline?limit=200");
  assert.equal(ok.status, 200);
  assert.deepEqual(t.env.calls.map((c) => [c.to, c.method, c.path, c.body]), [["bridge", "GET", "/api/v1/threads/thr_remote01/timeline?limit=200", null]]);
  t.env.win.remoteBridgeDown = true; t.env.calls.length = 0;
  const bad = await t.fetch("/api/v1/threads/thr_remote01");
  assert.equal(bad.status, 503);
  assert.equal((await bad.json()).error.code, "federation_remote_unreachable");
  assert.equal(t.env.primaryCalls().length, 0);
});

test("system selectors: remote host/project/environment -> bridge; unscoped -> primary; others refused", async () => {
  const t = setup({ remote: {
    "GET /api/v1/system/execution-options": { models: [] },
    "GET /api/v1/system/environment-providers": { providers: [] },
    "GET /api/v1/system/providers/state": { states: [] },
    "GET /api/v1/system/providers": { providers: [] },
  } });
  await boot(t);
  t.env.calls.length = 0;
  for (const p of [
    "/api/v1/system/execution-options?environmentId=env_remote01&providerId=codex",
    "/api/v1/system/environment-providers?projectId=proj_remote01",
    "/api/v1/system/providers/state?environmentId=env_remote01",
    "/api/v1/system/providers?environmentId=env_remote01",
    "/api/v1/system/execution-options?providerId=codex",
    "/api/v1/system/config",
  ]) await t.fetch(p);
  assert.deepEqual(t.env.calls.map((c) => c.to), ["bridge", "bridge", "bridge", "bridge", "primary", "primary"]);
  const refused = await t.fetch("/api/v1/system/usage-limits?environmentId=env_remote01");
  assert.equal(refused.status, 409);
  const mixed = await t.fetch("/api/v1/system/environment-providers?projectId=proj_remote01&hostId=host_local01");
  assert.equal(mixed.status, 409, "unknown host id counts as local: mixed request refused");
});

// ---------------- creation ----------------
const createBody = (environment, extra = {}) => JSON.stringify({ projectId: "proj_remote01", providerId: "codex", origin: "user", input: [{ type: "text", text: "hi" }], environment, ...extra });

test("ordinary new-thread POST: every environment shape with remote ids goes to the bridge unchanged", async () => {
  const t = setup({ remote: {
    "POST /api/v1/threads": R({ id: "thr_created01", projectId: "proj_remote01", environmentId: "env_remote02", providerId: "codex" }, 201),
    "GET /api/v1/hosts": [{ id: "host_remote01", name: "Remote Alpha host" }],
  } });
  await boot(t);
  t.env.calls.length = 0;
  for (const env of [
    { type: "project-default" },
    { type: "reuse", environmentId: "env_remote01" },
    { type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host_remote01" }, inputs: null },
  ]) {
    if (env.machine) await t.fetch("/api/v1/hosts"); // the composer's merged machine list
    assert.ok(!env.machine || t.fed.isRemote("host_remote01"));
    const body = createBody(env);
    const r = await t.fetch("/api/v1/threads", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(r.status, 201);
    const last = t.env.bridgeCalls().at(-1);
    assert.equal(last.body, body, "body forwarded byte-for-byte (provider untouched)");
  }
  assert.equal(t.env.primaryCalls().filter((c) => c.method === "POST").length, 0);
  // the created id is known before the client opens it
  t.env.calls.length = 0;
  await t.fetch("/api/v1/threads/thr_created01");
  assert.equal(t.env.calls[0].to, "bridge");
});

test("creation via Request object, mixed owners, new machine, local section, read-only", async () => {
  const t = setup({ remote: { "POST /api/v1/threads": R({ id: "thr_created02", projectId: "proj_remote01" }, 201) } });
  await boot(t);
  const viaRequest = await t.fetch(new Request("http://primary.invalid/api/v1/threads", { method: "POST", headers: { "content-type": "application/json" }, body: createBody({ type: "project-default" }) }));
  assert.equal(viaRequest.status, 201);
  t.env.calls.length = 0;
  const mixed = await t.fetch("/api/v1/threads", { method: "POST", body: createBody({ type: "host", hostId: "host_local01", workspace: { type: "personal" } }) });
  assert.equal((await mixed.json()).error.code, "federation_mixed_owner");
  const newMachine = await t.fetch("/api/v1/threads", { method: "POST", body: createBody({ type: "provider", environmentProviderId: "x", machine: { type: "new", machineProviderId: "m" } }) });
  assert.equal((await newMachine.json()).error.code, "federation_new_machine_unsupported");
  const section = await t.fetch("/api/v1/threads", { method: "POST", body: createBody({ type: "project-default" }, { sectionId: "sec_local01" }) });
  assert.equal((await section.json()).error.code, "federation_section_unsupported");
  assert.equal(t.env.calls.length, 0, "nothing sent anywhere");
  const ro = setup({ config: { ...CONFIG, allowWrites: false } });
  await boot(ro);
  const r = await ro.fetch("/api/v1/threads", { method: "POST", body: createBody({ type: "project-default" }) });
  assert.equal(r.status, 403);
  const send = await ro.fetch("/api/v1/threads/thr_remote01/send", { method: "POST", body: "{}" });
  assert.equal(send.status, 403);
});

test("local requests are untouched, including local creation and malformed bodies", async () => {
  const t = setup();
  await boot(t);
  t.env.calls.length = 0;
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "proj_local01", input: [], environment: { type: "project-default" } }) };
  await t.fetch("/api/v1/threads", init);
  await t.fetch("/api/v1/threads", { method: "POST", body: "{not json" });
  await t.fetch("/api/v1/threads/thr_local01/send", { method: "POST", body: "{}" });
  await t.fetch("https://elsewhere.invalid/x");
  assert.deepEqual(t.env.calls.map((c) => c.to), ["primary", "primary", "primary", "primary"]);
  assert.equal(t.env.calls[0].body, init.body);
});

// ---------------- plugins / bodies / conflicts ----------------
test("other plugins' RPC with remote ids is refused; without them it stays local", async () => {
  const t = setup();
  await boot(t);
  t.env.calls.length = 0;
  const r = await t.fetch("/api/v1/plugins/github/rpc/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "thr_remote01" }) });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, "federation_plugin_not_federated");
  await t.fetch("/api/v1/plugins/github/rpc/status", { method: "POST", body: JSON.stringify({ threadId: "thr_local01" }) });
  assert.deepEqual(t.env.calls.map((c) => c.to), ["primary"]);
});

test("binary/multipart bodies to the remote are refused with 415", async () => {
  const t = setup();
  await boot(t);
  const fd = new FormData(); fd.append("f", new Blob(["x"]), "x.txt");
  const r = await t.fetch("/api/v1/projects/proj_remote01/attachments", { method: "POST", body: fd });
  assert.equal(r.status, 415);
  assert.equal(t.env.bridgeCalls().filter((c) => c.method === "POST").length, 0);
});

test("primary owner takes precedence over a remote claim", async () => {
  const t = setup({ remote: { "GET /api/v1/sidebar-bootstrap": { ...REMOTE_BOOTSTRAP, projects: [{ id: "proj_remote01", name: "AI", threads: [{ id: "thr_local01", projectId: "proj_remote01" }] }] } } });
  const b = await boot(t);
  assert.ok(!t.fed.conflicts().includes("thr_local01"));
  t.env.calls.length = 0;
  const r = await t.fetch("/api/v1/threads/thr_local01");
  assert.equal(r.status, 200);
  assert.equal(t.env.calls.length, 1);
  assert.equal(t.env.calls[0].to,"primary");
  assert.ok(b.projects.some((p) => p.id === "proj_remote01"));
});

// ---------------- realtime ----------------
function wsSetup() {
  const t = setup();
  const core = new t.NativeWS("ws://primary.invalid/ws"); // opened by bb BEFORE the plugin
  core.serverOpen();
  return { ...t, core };
}

test("strict gate: only the core /ws is federated", async () => {
  const t = wsSetup();
  await boot(t);
  const before = t.env.FakeWS.all.length;
  const term = new t.env.win.WebSocket("ws://primary.invalid/api/v1/terminals/term_1/ws");
  const q = new t.env.win.WebSocket("ws://primary.invalid/ws?x=1");
  assert.ok(term instanceof t.NativeWS && q instanceof t.NativeWS);
  assert.equal(t.env.FakeWS.all.length, before + 2, "no extra remote channel opened");
});

test("capture: next core frame closes it once; `online` nudge is bounded and cancellable", async () => {
  const t = wsSetup();
  const onlines = [];
  t.env.win.addEventListener("online", () => onlines.push(1));
  t.env.runTimers(); // first nudge
  assert.equal(onlines.length, 1);
  t.core.send(JSON.stringify({ type: "ping" }));
  await flush();
  assert.equal(t.core.readyState, 3, "captured core socket closed so bb reconnects through the wrapper");
  assert.equal(t.fed.state.counters.captured, 1);
  assert.equal(t.NativeWS.prototype.send.name, "send", "prototype restored after capture");
  t.env.runTimers();
  assert.equal(onlines.length, 1, "no more nudges after capture");
});

test("federated socket: routing, readiness, policy, row status, backoff, catch-up, no orphans", async () => {
  const t = wsSetup();
  await boot(t);
  const outer = new t.env.win.WebSocket("ws://primary.invalid/ws");
  const got = [];
  outer.addEventListener("message", (e) => got.push(JSON.parse(e.data)));
  const [primary, remote] = t.env.FakeWS.all.slice(-2);
  assert.equal(primary.url, "ws://primary.invalid/ws");
  assert.equal(remote.url, "ws://primary.invalid/api/v1/plugins/federation-pilot/http/remote-ws");
  primary.serverOpen(); remote.serverOpen();
  outer.send(JSON.stringify({ type: "subscribe", target: { kind: "thread-list" } }));
  outer.send(JSON.stringify({ type: "subscribe", target: { kind: "thread-detail", threadId: "thr_remote01" } }));
  outer.send(JSON.stringify({ type: "subscribe", target: { kind: "thread-detail", threadId: "thr_local01" } }));
  outer.send(JSON.stringify({ type: "ping" }));
  const kinds = (ws) => ws.sent.map((x) => JSON.parse(x)).map((m) => m.type + ":" + (m.target?.threadId ?? m.target?.kind ?? ""));
  assert.deepEqual(kinds(primary), ["subscribe:thread-list", "subscribe:thr_local01", "ping:"]);
  assert.deepEqual(kinds(remote), ["subscribe:thread-list", "subscribe:thr_remote01"]);
  assert.equal(t.fed.state.remoteState, "connecting", "open bridge socket is not readiness");
  remote.serverSend({ type: "fedprobe-remote-ready" });
  assert.equal(t.fed.state.remoteState, "open");
  assert.deepEqual(t.rows.get("thr_remote01"), { icon: "Network", label: "Remote Alpha", tone: "default" });
  assert.ok(got.some(m=>m.id==='thr_remote01'), 'initial readiness invalidates pre-plugin errors');
  got.length=0;
  // policy
  remote.serverSend({ type: "changed", entity: "system", changes: ["config-changed"] });
  remote.serverSend({ type: "changed", entity: "thread", id: "thr_local01", changes: ["events-appended"] });
  remote.serverSend({ type: "plugin-signal", pluginId: "x", channel: "c", payload: {} });
  remote.serverSend({ type: "pong" });
  remote.serverSend({ type: "changed", entity: "thread", id: "thr_remote01", changes: ["events-appended"] });
  remote.serverSend({ type: "changed", entity: "thread", id: "thr_new01", changes: ["thread-created"], metadata: { projectId: "proj_remote01" } });
  assert.deepEqual(got.map((m) => m.id), ["thr_remote01"]);
  assert.ok(!t.fed.isRemote("thr_new01"), "unverified socket IDs never gain ownership");
  // outage + bounded backoff (no reset until real readiness)
  const delays = [];
  remote.close(1006);
  assert.equal(t.fed.state.remoteState, "offline");
  assert.equal(t.rows.get("thr_remote01").tone, "error");
  for (let i = 0; i < 7; i++) {
    delays.push(...t.env.runTimers().filter((ms) => ms !== 0 && ms !== 6000)); // drop capture nudges
    const r = t.env.FakeWS.all.at(-1);
    r.serverOpen(); // bridge reachable, upstream still down
    r.close(4001);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  for (let i = 0; i < 3; i++) t.env.runTimers(); // exhaust bounded nudges; next retry fires
  const back = t.env.FakeWS.all.at(-1);
  back.serverOpen();
  got.length = 0;
  back.serverSend({ type: "fedprobe-remote-ready" });
  assert.equal(t.fed.state.remoteState, "open");
  assert.ok(kinds(back).includes("subscribe:thr_remote01"), "remote subscriptions replayed");
  assert.ok(got.some((m) => m.id === "thr_remote01" && m.changes.includes("events-appended")), "catch-up invalidation");
  assert.equal(primary.readyState, 1, "primary channel untouched by remote outage");
  // primary close ends everything: no orphan retry
  back.close(1006);
  assert.equal(t.env.timers.size, 1);
  primary.close(1006);
  assert.equal(t.env.timers.size, 0, "retry cancelled with the outer socket");
});

test("dispose: ordinary changed for remote rows, statuses cleared, globals restored only if ours, sockets closed", async () => {
  const t = wsSetup();
  await boot(t);
  const outer = new t.env.win.WebSocket("ws://primary.invalid/ws");
  const got = [];
  outer.addEventListener("message", (e) => got.push(JSON.parse(e.data)));
  const [primary, remote] = t.env.FakeWS.all.slice(-2);
  primary.serverOpen(); remote.serverOpen(); remote.serverSend({ type: "fedprobe-remote-ready" });
  assert.ok(t.rows.size > 0);
  // someone else wraps fetch after us: we must not remove their wrapper
  const theirs = async (...a) => "theirs";
  t.env.win.fetch = theirs;
  let closed = null;
  outer.addEventListener("close", (e) => { closed = e.code; });
  t.fed.dispose();
  assert.ok(got.some((m) => m.entity === "project" && m.id === "proj_remote01" && m.changes.includes("threads-changed")));
  assert.equal(t.rows.size, 0);
  assert.equal(t.env.win.fetch, theirs, "foreign wrapper kept");
  assert.equal(t.env.win.WebSocket, t.NativeWS);
  assert.notEqual(t.NativeWS.prototype.send.name, "patchedSend");
  assert.equal(remote.readyState, 3);
  assert.equal(primary.readyState, 3);
  assert.equal(closed, 4000);
  assert.equal(t.env.timers.size, 0, "no timers left (nudges, retries)");
  t.fed.dispose(); // idempotent
});

test('cold remote route sends to its owner before bootstrap and invalidates a cached 404 without subscription',async()=>{
 const env=createEnv({remote:{'POST /api/v1/threads/thr_remote01/send':{ok:true}}});
 env.win.location.href='http://primary.invalid/projects/proj_remote01/threads/thr_remote01';
 const fed=createFederation({win:env.win,config:CONFIG,pluginId:PID});
 const r=await env.win.fetch('/api/v1/threads/thr_remote01/send',{method:'POST',body:'{}'});
 assert.equal(r.status,200);assert.equal(env.primaryCalls().length,0);
 const ws=new env.win.WebSocket('ws://primary.invalid/ws');const frames=[];
 ws.addEventListener('message',e=>frames.push(JSON.parse(e.data)));
 const [a,b]=env.FakeWS.all.slice(-2);a.serverOpen();b.serverOpen();b.serverSend({type:'fedprobe-remote-ready'});
 assert(frames.some(m=>m.entity==='thread'&&m.id==='thr_remote01'));
 fed.dispose();
});
test('late bootstrap moves a premature subscription off primary and refreshes remote detail',async()=>{
 const t=wsSetup();const ws=new t.env.win.WebSocket('ws://primary.invalid/ws');const frames=[];
 ws.addEventListener('message',e=>frames.push(JSON.parse(e.data)));
 const [a,b]=t.env.FakeWS.all.slice(-2);a.serverOpen();b.serverOpen();b.serverSend({type:'fedprobe-remote-ready'});
 ws.send(JSON.stringify({type:'subscribe',target:{kind:'thread-detail',threadId:'thr_remote01'}}));
 assert(a.sent.some(s=>JSON.parse(s).type==='subscribe'));
 await boot(t);
 assert(a.sent.some(s=>JSON.parse(s).type==='unsubscribe'&&JSON.parse(s).target.threadId==='thr_remote01'));
 assert(b.sent.some(s=>JSON.parse(s).type==='subscribe'&&JSON.parse(s).target.threadId==='thr_remote01'));
 assert(frames.some(m=>m.entity==='thread'&&m.id==='thr_remote01'));
 t.fed.dispose();
});

test('send keeps cross-server mention bytes and timeline read never claims referenced local ids',async()=>{
 const reference={type:'text',text:'See @local',mentions:[{start:4,end:10,resource:{kind:'thread',threadId:'thr_local01',projectId:'proj_local01',label:'Local'}}]};
 const response={id:'thr_remote01',projectId:'proj_remote01',input:[reference]};
 const t=setup({remote:{'POST /api/v1/threads/thr_remote01/send':response,'GET /api/v1/threads/thr_remote01/timeline':{events:[{input:[reference]}]}}});
 await boot(t);
 const body=JSON.stringify({input:[reference],mode:'queue-if-active'});
 assert.equal((await t.fetch('/api/v1/threads/thr_remote01/send',{method:'POST',body})).status,200);
 assert.equal(t.env.bridgeCalls().at(-1).body,body);
 await t.fetch('/api/v1/threads/thr_remote01/timeline');
 assert.deepEqual(t.fed.conflicts(),[]);
 assert.equal(t.fed.isRemote('thr_local01'),false);
 assert.equal(t.fed.isRemote('proj_local01'),false);
 await t.fetch('/api/v1/threads/thr_local01');
 assert.equal(t.env.primaryCalls().at(-1).path,'/api/v1/threads/thr_local01');
 t.fed.dispose();
});
