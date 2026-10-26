// Minimal fake browser for federation-core tests. No network, manual timers.
export const R = (body, status) => ({ __r: true, body, status });
export const ORIGIN = "http://primary.invalid";
export const BRIDGE = "/api/v1/plugins/federation-pilot/http";

export function createEnv({ primary = {}, remote = {}, remotes = {} } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 1;
  const listeners = new Map();
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const win = {
    location: { href: `${ORIGIN}/`, origin: ORIGIN, host: "primary.invalid", protocol: "http:" },
    Request, Response, EventTarget, Event, MessageEvent, CloseEvent,
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    queueMicrotask: (fn) => queueMicrotask(fn),
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of listeners.get(ev.type) ?? []) fn(ev); return true; },
    remoteBridgeDown: false,
  };

  async function fetchImpl(input, init) {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), win.location.href);
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
    let body = init?.body ?? null;
    if (body == null && req && method !== "GET") body = await req.clone().text();
    if (url.pathname === `${BRIDGE}/proxy`) {
      const env = JSON.parse(body);
      calls.push({ to: "bridge", method: env.method, path: env.path, body: env.body, serverId:env.serverId });
      if (win.remoteBridgeDown) throw new TypeError("Failed to fetch");
      const source = remotes[env.serverId] ?? remote;
      const handler = source[`${env.method} ${env.path.split("?")[0]}`] ?? source[`${env.method} ${env.path}`];
      if (!handler) return json({ error: { code: "not_found" } }, 404);
      const out = typeof handler === "function" ? handler(env) : handler;
      return out?.__r ? json(out.body, out.status) : json(out);
    }
    calls.push({ to: "primary", method, path: url.pathname + url.search, body, input });
    const handler = primary[`${method} ${url.pathname}`];
    if (!handler) return json({ ok: true, path: url.pathname });
    const out = typeof handler === "function" ? handler({ url, body }) : handler;
    return out?.__r ? json(out.body, out.status) : json(out);
  }
  win.fetch = fetchImpl;

  class FakeWS extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    static all = [];
    constructor(url) { super(); this.url = String(url); this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
    send(data) { this.sent.push(String(data)); }
    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }
    serverOpen() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    serverSend(m) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(m) })); }
  }
  win.WebSocket = FakeWS;

  return {
    win, calls, timers, FakeWS, json,
    runTimers() { const due = [...timers.entries()]; timers.clear(); for (const [, t] of due) t.fn(); return due.map(([, t]) => t.ms); },
    bridgeCalls: () => calls.filter((c) => c.to === "bridge"),
    primaryCalls: () => calls.filter((c) => c.to === "primary"),
  };
}

export const CONFIG = { enabled: true, projectId: "proj_remote01", label: "Remote Alpha", allowWrites: true };

export const REMOTE_BOOTSTRAP = {
  sections: [],
  projects: [{ id: "proj_remote01", name: "Remote project", threads: [
    { id: "thr_remote01", projectId: "proj_remote01", environmentId: "env_remote01", providerId: "codex" },
  ] }],
  personalProject: null,
};
export const PRIMARY_BOOTSTRAP = {
  sections: [{ id: "sec_local01" }],
  projects: [{ id: "proj_local01", name: "Local", threads: [{ id: "thr_local01", projectId: "proj_local01" }] }],
  personalProject: { id: "proj_personal", name: "Personal", threads: [] },
};
