// Frontend transport core of the federation pilot. Pure module: every browser
// global arrives through `win`, so narrow tests run in Node.
//
// Projects from independently configured remote BB servers is shown inside the ordinary
// bb client. Ownership is per entity id (no global "current server"), so any
// number of local and remote threads may be open at once.
//
// Rules:
//  - requests whose ids (path, query, selected JSON fields) belong to the
//    remote go ONLY through the plugin bridge; any failure stays a remote
//    error (never re-sent to the primary);
//  - mixed local/remote ids in one request are refused before sending;
//  - an id known on both servers is refused (cloned databases);
//  - unscoped lists are merged; unscoped system APIs stay primary;
//  - other plugins' RPC/HTTP calls carrying remote ids are refused;
//  - writes to the remote require config.allowWrites; only the bounded raster
//    image route accepts multipart, other non-JSON bodies are refused;
//  - only the exact core realtime URL is federated; other sockets pass through;
//  - remote realtime frames are filtered: `changed` for remote-owned
//    thread/project/environment/host ids only.
// No React internals are used. Cache refresh relies on bb's own `changed`
// handling and reconnect wave.

import {remoteMachineName, mountRemoteMachines} from './machine-presentation.mjs';
import {mountImageUrls} from './image-presentation.mjs';
import {IMAGE_MAX_BYTES, IMAGE_MIMES, ImageTransferError, isImagePath, validateImage} from './image-format.ts';
export const ID_RE = /^(thr|proj|env|host)_[a-z0-9]+$/u;
export const PERSONAL = "proj_personal";
const OWNER_KEYS = new Set([
  "id", "threadId", "projectId", "environmentId", "hostId", "parentThreadId",
  "sourceThreadId", "environmentHostId", "rootThreadId",
]);
const MERGED_COLLECTIONS = new Set(["/api/v1/projects", "/api/v1/threads", "/api/v1/hosts", "/api/v1/environments"]);
const SCOPE_PARAMS = ["projectId", "hostId", "environmentId", "parentThreadId", "sourceThreadId", "threadId"];
const SYSTEM_SELECTOR_ROUTES = new Set([
  "/api/v1/system/execution-options",
  "/api/v1/system/providers",
  "/api/v1/system/providers/state",
  "/api/v1/system/environment-providers",
]);
const READ_METHODS = new Set(["GET", "HEAD"]);
const NON_JSON = Symbol("non-json-body");
const LIST_KINDS = new Set(["thread-list", "project-list", "environment-list", "host-list"]);
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

export class FederationError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}

export function createFederation({ win, config, pluginId, setRowStatus = null, log = () => {} }) {
  const entries = config.servers ?? [{...config, serverId: "default"}];
  const peers = entries.map(c => ({...c, label:String(c.label || c.serverId), ids:new Set([c.projectId]), state:"connecting", lists:new Map()}));
  const peerById = new Map(peers.map(p => [p.serverId,p]));
  const label = peers.map(p => p.label).join(", ");
  const BRIDGE = `/api/v1/plugins/${pluginId}/http`;
  const remoteIds = new Set(peers.map(p => p.projectId));
  const owners = new Map(peers.map(p => [p.projectId,p]));
  const primaryIds = new Set();
  const conflicts = new Set();
  const rowStatusIds = new Set();
  const outerSockets = new Set();
  const inner = new WeakSet();
  const remoteMachines=new Map();
  let machineView=null;
  let imageView=null;
  const imageRequests=new AbortController();
  const state = {
    remoteState: "connecting",
    servers: peers,
    counters: { primary: 0, remote: 0, merged: 0, refused: 0, wsAccepted: 0, wsDropped: 0, wsPassThrough: 0, captured: 0 },
    lastRemoteLists: new Map(),
    disposed: false,
  };

  // ---------- ownership ----------
  const isRemote = (id) => typeof id === "string" && remoteIds.has(id) && !conflicts.has(id);
  const addRemote = (id, peer, notify = true) => {
    if (typeof id !== "string" || !ID_RE.test(id) || id === PERSONAL) return;
    if (primaryIds.has(id)) { log("remote-primary-claim-ignored",{id,serverId:peer.serverId});return; }
    if (owners.has(id) && owners.get(id)!==peer) {conflicts.add(id);imageView?.refresh();return;}
    owners.set(id,peer);peer.ids.add(id);
    if (!remoteIds.has(id)) {
      remoteIds.add(id);
      if (id.startsWith("thr_")) applyRowStatus(id);
      for (const socket of outerSockets) socket._adoptRemoteId(id, peer, notify);
    }
  };
  const addPrimary = (id) => {
    if (typeof id !== "string" || !ID_RE.test(id) || id === PERSONAL) return;
    primaryIds.add(id);
    if(remoteIds.has(id)){
      const peer=owners.get(id);owners.delete(id);remoteIds.delete(id);peer?.ids.delete(id);conflicts.delete(id);
      for(const socket of outerSockets)socket._restorePrimaryId(id);
      if(rowStatusIds.delete(id)&&setRowStatus)try{setRowStatus(id,null);}catch{}
      log("primary-owner-restored",{id});
      remoteMachines.delete(id);machineView?.refresh();
      imageView?.refresh();
    }
  };
  // Structured walk: only owner-bearing keys, never free text in timelines.
  const walkIds = (value, onId, depth = 0) => {
    if (depth > 10 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) walkIds(v, onId, depth + 1); return; }
    for (const [k, v] of Object.entries(value)) {
      if (k === "personalProject") continue;
      // References in message content can point to another server. Reading a
      // remote timeline must not reassign those referenced objects to remote.
      if (k === "mentions" && Array.isArray(v)) continue;
      if (typeof v === "string") { if (OWNER_KEYS.has(k)) onId(v); }
      else walkIds(v, onId, depth + 1);
    }
  };
  // Entity ownership is learned only from API resource positions, never agent content.
  function learnResponse(path, value, onId) {
    const route = path.split("?")[0];
    const entity = x => { if(!x || typeof x!=="object")return; for(const k of ["id","projectId","environmentId","environmentHostId","hostId"])if(typeof x[k]==="string")onId(x[k]); };
    const project = p => {entity(p);for(const t of p?.threads??[])entity(t);for(const source of p?.sources??[])if(typeof source.hostId==="string")onId(source.hostId);};
    if(route==="/api/v1/sidebar-bootstrap") {for(const p of value?.projects??[])project(p);return;}
    if(route==="/api/v1/projects" && Array.isArray(value)){value.forEach(project);return;}
    if(["/api/v1/threads","/api/v1/hosts","/api/v1/environments"].includes(route)) { (Array.isArray(value)?value:[value]).forEach(entity);return; }
    if(/^\/api\/v1\/(threads\/thr_|projects\/proj_|hosts\/host_|environments\/env_)[a-z0-9]+$/.test(route))entity(value);
  }
  const learnRemote = (path,json,peer) => {
    learnResponse(path,json,id=>addRemote(id,peer));
    const route=path.split('?')[0];
    if(route==='/api/v1/hosts' || /^\/api\/v1\/hosts\/host_[a-z0-9]+$/.test(route)){
      for(const host of Array.isArray(json)?json:[json])if(host && /^host_[a-z0-9]+$/.test(host.id) && owners.get(host.id)===peer && !conflicts.has(host.id))remoteMachines.set(host.id,{host,serverId:peer.serverId,label:peer.label,peer});
      machineView?.refresh();
    }
  };
  const learnPrimary = (path,json) => learnResponse(path,json,addPrimary);

  // ---------- row status ----------
  function currentRowStatus(peer) {
    const label=peer.label;
    if (peer.state === "open") return { icon: "Network", label, tone: "default" };
    return { icon: "Network", label: `${label}: ${peer.state === "offline" ? "offline" : "connecting"}`, tone: peer.state === "offline" ? "error" : "default" };
  }
  function applyRowStatus(id) {
    if (!setRowStatus || state.disposed) return;
    try { setRowStatus(id, currentRowStatus(owners.get(id))); rowStatusIds.add(id); } catch (e) { log("row-status-error", { error: String(e) }); }
  }
  function setRemoteState(peer,s) {
    if (peer.state === s) return;
    peer.state = s;
    state.remoteState = peers.every(p=>p.state==="open")?"open":peers.some(p=>p.state==="offline")?"offline":"connecting";
    log("remote-state", { state: s });
    for (const id of peer.ids) if (id.startsWith("thr_")) applyRowStatus(id);
    machineView?.refresh();
  }

  // ---------- HTTP ----------
  const nativeFetch = win.fetch;
  const json = (body, status = 200) => new win.Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const errorResponse = (code, status, message) => json({ error: { code, message } }, status);

  function imageContentUrl(value) {
    let url;
    try {url=new URL(value,win.location.href);}catch{return null;}
    if(url.origin!==win.location.origin)return null;
    const match=/^\/api\/v1\/projects\/(proj_[a-z0-9]+)\/attachments\/content$/.exec(url.pathname);
    if(!match)return null;
    if(conflicts.has(match[1]))return 'about:blank#federation-id-conflict';
    if(!isRemote(match[1]))return null;
    const path=url.searchParams.get('path');
    if([...url.searchParams.keys()].length!==1||!path||!isImagePath(path))return 'about:blank#federation-image-unsupported';
    const peer=owners.get(match[1]);
    return `${BRIDGE}/image-content?${new URLSearchParams({serverId:peer.serverId,projectId:match[1],path})}`;
  }
  async function imageFetch(url, options) {
    let r;
    try {
      r=await nativeFetch.call(win,url,{...options,signal: options?.signal ? AbortSignal.any([imageRequests.signal,options.signal]) : imageRequests.signal});
    } catch {
      throw new FederationError('federation_image_unreachable',503,'Remote image transfer failed or was cancelled. It was not retried.');
    }
    const primaryOwner=r.headers.get('x-bb-federation-primary');
    if(primaryOwner && ID_RE.test(primaryOwner))addPrimary(primaryOwner);
    state.counters.remote++;
    return r;
  }
  async function uploadImage(peer, req, init) {
    requireWrites(peer,'POST');
    const Form=win.FormData??globalThis.FormData;
    let form;
    if(init?.body instanceof Form)form=init.body;
    else if(req && !init?.body && req.headers.get('content-type')?.startsWith('multipart/form-data'))form=await req.clone().formData();
    else throw new FederationError('federation_image_invalid',400,'An image upload requires one multipart file.');
    const fields=[...form.keys()],file=form.get('file');
    if(fields.length!==1||fields[0]!=='file'||!file||typeof file==='string'||typeof file.arrayBuffer!=='function')throw new FederationError('federation_image_invalid',400,'Upload exactly one image file.');
    if(file.size<1||file.size>IMAGE_MAX_BYTES)throw new FederationError('federation_image_too_large',413,'Remote images must be between 1 byte and 4 MiB.');
    if(!IMAGE_MIMES.includes(file.type))throw new FederationError('federation_image_format',415,'Remote images support PNG, JPEG, GIF and WebP.');
    const bytes=new Uint8Array(await file.arrayBuffer());validateImage(bytes,file.type);
    if(state.disposed)throw new FederationError('federation_disabled',503,'Federation was disabled during image upload.');
    // Ownership may change while reading a file; never send its bytes then.
    if(ownerOf([peer.projectId])!==peer)throw new FederationError('federation_image_owner',409,'Image project ownership changed.');
    let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return imageFetch(`${BRIDGE}/image-upload`,{method:'POST',headers:{'content-type':'application/json'},signal:init?.signal??req?.signal,
      body:JSON.stringify({serverId:peer.serverId,projectId:peer.projectId,filename:file.name,mimeType:file.type,bytesBase64:(win.btoa??globalThis.btoa)(binary)})});
  }

  async function viaBridge(peer, method, path, body) {
    let r;
    try {
      r = await nativeFetch.call(win, `${BRIDGE}/proxy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(config.servers?{serverId:peer.serverId}:{}), method, path, body: body ?? null }),
      });
    } catch (e) {
      throw new FederationError("federation_remote_unreachable", 503, `Remote server "${label}" is unreachable: ${String(e)}`);
    }
    const primaryOwner=r.headers.get("x-bb-federation-primary");
    if(primaryOwner && ID_RE.test(primaryOwner))addPrimary(primaryOwner);
    state.counters.remote++;
    log("fetch", { method, path, owner: "remote", status: r.status });
    // Learn new ids BEFORE bb sees the response: a just-created thread is
    // opened by the very next request and must already be remote-owned.
    if (r.headers.get("content-type")?.includes("application/json")) {
      try { if(r.ok){
        const data=await r.clone().json();learnRemote(path,data,peer);
        if(/^\/api\/v1\/hosts\/host_[a-z0-9]+$/.test(path.split('?')[0]))return json({...data,name:remoteMachineName(data,peer)},r.status);
      } } catch { /* non-JSON error body */ }
    }
    return r;
  }

  async function readBody(req, init) {
    if (init && "body" in init && init.body != null) {
      return typeof init.body === "string" ? init.body : NON_JSON;
    }
    if (!req || READ_METHODS.has(req.method)) return null;
    const ct = req.headers.get("content-type") ?? "";
    if (ct && !ct.includes("json")) return NON_JSON;
    return await req.clone().text();
  }
  const parseJson = (text) => { if (typeof text !== "string" || text === "") return null; try { return JSON.parse(text); } catch { return undefined; } };

  // Ids that decide the owner of a thread creation/fork body.
  function creationIds(body) {
    const ids = [];
    const push = (v) => { if (typeof v === "string") ids.push(v); };
    push(body?.projectId); push(body?.parentThreadId); push(body?.sourceThreadId);
    const env = body?.environment;
    if (env && typeof env === "object") {
      push(env.environmentId); push(env.hostId);
      if (env.machine?.type === "existing") push(env.machine.hostId);
    }
    return ids;
  }

  // Classify a set of ids: "remote" | "primary" | "none"; throws on mix/conflict.
  function ownerOf(ids) {
    const found = new Set();
    for(const id of ids){
      if(!ID_RE.test(id))continue;
      if(conflicts.has(id))throw new FederationError("federation_id_conflict",409,`Identifier ${id} exists on multiple servers.`);
      found.add(owners.get(id)??"primary");
    }
    if(found.size>1)throw new FederationError("federation_mixed_owner",409,"One request mixes objects from different servers.");
    return found.values().next().value??"none";
  }
  const relabel = (p,peer) => p && typeof p.name==="string" ? {...p,...(Array.isArray(p.threads)?{threads:p.threads.filter(t=>owners.get(t.id)===peer&&!conflicts.has(t.id))}:{}),name:p.name.endsWith(` · ${peer.label}`)?p.name:`${p.name} · ${peer.label}`} : p;
  async function mergedList(input,init,url,isBootstrap){
    const path=url.pathname+url.search;
    const [aResp,...results]=await Promise.all([nativeFetch.call(win,input,init),...peers.map(async peer=>{
      try{const r=await viaBridge(peer,"GET",path);if(!r.ok)throw Error(`remote ${r.status}`);const b=await r.json();peer.lists.set(path,b);return b;}
      catch(e){log("merge-remote-failed",{serverId:peer.serverId,path,error:String(e)});setRemoteState(peer,"offline");return peer.lists.get(path)??null;}
    })]);
    if(!aResp.ok || state.disposed)return aResp;
    const a=await aResp.json();learnPrimary(path,a);
    results.forEach((b,n)=>{if(b)learnRemote(path,b,peers[n]);});state.counters.merged++;
    const extra=results.flatMap((b,n)=>{
      const rows=isBootstrap?b?.projects:b;
      return (Array.isArray(rows)?rows:[]).filter(r=>r?.id!==PERSONAL&&!conflicts.has(r?.id)&&owners.get(r?.id)===peers[n]).map(r=>isBootstrap||url.pathname==="/api/v1/projects"?relabel(r,peers[n]):url.pathname==='/api/v1/hosts'?{...r,name:remoteMachineName(r,peers[n])}:r);
    });
    return json(isBootstrap?{...a,projects:[...(a.projects??[]),...extra]}:[...(Array.isArray(a)?a:[]),...extra]);
  }

  async function route(input, init, ctx) {
    const req = input instanceof win.Request ? input : null;
    let url;
    try { url = new URL(req ? req.url : String(input), win.location.href); } catch { return null; }
    if (url.origin !== win.location.origin || !url.pathname.startsWith("/api/v1/")) return null;
    if (url.pathname.startsWith(BRIDGE)) return null;
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
    const path = url.pathname + url.search;
    // SPA navigation can open an archived remote thread after installation.
    // Only the current explicit project/thread route grants this tentative scope;
    // the server still checks primary ownership before forwarding any body.
    const currentRoute=/^\/projects\/(proj_[a-z0-9]+)\/threads\/(thr_[a-z0-9]+)/u.exec(new URL(win.location.href).pathname);
    const currentPeer=peers.find(p=>p.projectId===currentRoute?.[1]);
    if(currentPeer && !primaryIds.has(currentRoute[2]))addRemote(currentRoute[2],currentPeer);
    const pathIds = url.pathname.split("/").filter((s) => ID_RE.test(s));
    const queryIds = [];
    for (const [k, v] of url.searchParams) if (SCOPE_PARAMS.includes(k) || ID_RE.test(v)) queryIds.push(v);

    // Only the explicit federation-aware handoff RPCs accept remote selectors
    // on primary. Their backend validates destination ownership and permissions.
    if(method==='POST'&&/^\/api\/v1\/plugins\/handoff\/rpc\/remote(Targets|Options|Prepare|Start|Status)$/.test(url.pathname))return null;
    // Other plugin operations remain unsupported for remote objects.
    const pluginMatch = /^\/api\/v1\/plugins\/([^/]+)\/(rpc|http)\//u.exec(url.pathname);
    if (pluginMatch) {
      const raw = READ_METHODS.has(method) ? null : await readBody(req, init);
      const ids = [...pathIds, ...queryIds];
      const parsed = parseJson(raw);
      if (parsed) walkIds(parsed, (id) => ids.push(id));
      if (ids.some(isRemote) || ids.some((id) => conflicts.has(id))) {
        throw new FederationError("federation_plugin_not_federated", 409, `Plugin "${pluginMatch[1]}" cannot act on "${label}" objects in this pilot.`);
      }
      return null;
    }

    // Body-addressed creation.
    if (method === "POST" && (url.pathname === "/api/v1/threads" || url.pathname === "/api/v1/threads/fork")) {
      const raw = await readBody(req, init);
      const body = parseJson(raw);
      if (raw === NON_JSON || body === undefined) {
        if (pathIds.some(isRemote)) throw new FederationError("federation_body_unsupported", 415, "Only JSON bodies are federated.");
        return null;
      }
      const ids = [...creationIds(body), ...queryIds];
      const owner = ownerOf(ids);
      if (typeof owner !== "object") return null;
      ctx.remote = true;
      if (body?.environment?.type === "provider" && body.environment.machine?.type === "new") {
        throw new FederationError("federation_new_machine_unsupported", 409, `Creating a machine on "${label}" is not part of the pilot.`);
      }
      if (body?.sectionId != null) {
        throw new FederationError("federation_section_unsupported", 409, `Local thread sections cannot hold "${label}" threads.`);
      }
      requireWrites(owner,method);
      return viaBridge(owner,method, path, raw);
    }

    // File APIs address hosts in the JSON body; not federated in the pilot.
    if (url.pathname.startsWith("/api/v1/files/") && !READ_METHODS.has(method)) {
      const parsed = parseJson(await readBody(req, init));
      if (parsed && (isRemote(parsed.hostId) || conflicts.has(parsed.hostId))) {
        throw new FederationError("federation_files_unsupported", 409, `File access on "${label}" machines is not part of the pilot.`);
      }
      return null;
    }

    const owner = ownerOf([...pathIds, ...queryIds]);
    if (typeof owner === "object") ctx.remote = true;

    if (method === "GET" && url.pathname === "/api/v1/sidebar-bootstrap" && owner === "none") {
      return mergedList(input, init, url, true);
    }
    if (method === "GET" && MERGED_COLLECTIONS.has(url.pathname) && owner === "none") {
      return mergedList(input, init, url, false);
    }
    if (typeof owner !== "object") {
      if (MERGED_COLLECTIONS.has(url.pathname) || url.pathname === "/api/v1/sidebar-bootstrap") {
        // primary-scoped collection: still learn its ids for conflict detection
        const r = await nativeFetch.call(win, input, init);
        if (r.ok) { try { learnPrimary(path,await r.clone().json()); } catch { /* ignore */ } }
        state.counters.primary++;
        return r;
      }
      return null;
    }
    if(method==='POST' && url.pathname===`/api/v1/projects/${owner.projectId}/attachments`)return uploadImage(owner,req,init);
    if(method==='GET' && url.pathname===`/api/v1/projects/${owner.projectId}/attachments/content`){
      const target=imageContentUrl(url.href);
      if(!target||target.startsWith('about:'))throw new FederationError('federation_image_invalid',400,'Invalid remote image address.');
      return imageFetch(target,{signal:init?.signal??req?.signal});
    }
    if(!READ_METHODS.has(method) && /^\/api\/v1\/hosts\/host_/.test(url.pathname))throw new FederationError('federation_machine_management',403,'Manage this machine on its remote BB server.');
    if (url.pathname.startsWith("/api/v1/system/") && !SYSTEM_SELECTOR_ROUTES.has(url.pathname)) {
      throw new FederationError("federation_system_unsupported", 409, `${url.pathname} is not federated for "${label}".`);
    }
    if (!READ_METHODS.has(method)) requireWrites(owner,method);
    const raw = READ_METHODS.has(method) ? null : await readBody(req, init);
    if (raw === NON_JSON) throw new FederationError("federation_body_unsupported", 415, `Uploads and binary bodies to "${label}" are not supported yet.`);
    return viaBridge(owner,method, path, raw);
  }
  function requireWrites(peer,method) {
    if (!peer.allowWrites) throw new FederationError("federation_read_only", 403, `"${label}" is read-only in this pilot (${method} refused).`);
  }

  const federatedFetch = async function (input, init) {
    let result;
    const ctx = { remote: false };
    try {
      result = await route(input, init, ctx);
    } catch (e) {
      if (e instanceof FederationError || e instanceof ImageTransferError) {
        state.counters.refused++;
        log("fetch-refused", { code: e.code, message: e.message });

        return errorResponse(e.code ?? 'federation_image_error', e.status, e.message);
      }
      // An adapter bug must neither turn a remote request into a local one
      // nor break a local request: fail closed only when remote-addressed.
      log("fetch-internal-error", { error: String(e), remote: ctx.remote });
      if (ctx.remote) return errorResponse("federation_internal_error", 500, String(e));
      return nativeFetch.call(this ?? win, input, init);
    }
    if (result) return result;
    state.counters.primary++;
    return nativeFetch.call(this ?? win, input, init);
  };

  // ---------- realtime ----------
  const Native = win.WebSocket;
  const wsProto = win.location.protocol === "https:" ? "wss:" : "ws:";
  const coreUrl = `${wsProto}//${win.location.host}/ws`;
  const remoteUrl = `${wsProto}//${win.location.host}${BRIDGE}/remote-ws`;
  function acceptRemote(m,peer){
    return m?.type==="changed" && ["thread","project","environment","host"].includes(m.entity) && owners.get(m.id)===peer && !conflicts.has(m.id);
  }
  class FederatedSocket extends win.EventTarget {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(url,protocols){
      const target=String(url);
      if(target!==coreUrl||state.disposed){state.counters.wsPassThrough++;return protocols===undefined?new Native(url):new Native(url,protocols);}
      super();outerSockets.add(this);
      Object.assign(this,{url:target,readyState:0,binaryType:"blob",protocol:"",extensions:"",bufferedAmount:0,onopen:null,onmessage:null,onclose:null,onerror:null,_closed:false});
      this._allSubs=new Map();this._channels=new Map(peers.map(peer=>[peer,{peer,ws:null,timer:null,attempt:0,ready:false,subs:new Map()}]));
      this._primary=protocols===undefined?new Native(target):new Native(target,protocols);inner.add(this._primary);
      this._primary.addEventListener("open",()=>{this.readyState=1;this._emit(new win.Event("open"));});
      this._primary.addEventListener("message",e=>this._emit(new win.MessageEvent("message",{data:e.data})));
      this._primary.addEventListener("close",e=>{this._shutdown();this.readyState=3;this._emit(new win.CloseEvent("close",{code:e.code,reason:e.reason}));});
      this._primary.addEventListener("error",()=>this._emit(new win.Event("error")));
      for(const c of this._channels.values())this._openRemote(c);
    }
    _emit(ev){this.dispatchEvent(ev);const h=this["on"+ev.type];if(typeof h==="function")h.call(this,ev);}
    _emitJson(m){this._emit(new win.MessageEvent("message",{data:JSON.stringify(m)}));}
    _shutdown(){outerSockets.delete(this);this._closed=true;for(const c of this._channels.values()){if(c.timer!==null)win.clearTimeout(c.timer);c.timer=null;const ws=c.ws;c.ws=null;if(ws)try{ws.close(1000,"outer-closed");}catch{}}}
    _openRemote(c){
      if(this._closed)return;
      if(c.peer.state!=="offline")setRemoteState(c.peer,"connecting");
      const r=new Native(remoteUrl+(config.servers?`?serverId=${encodeURIComponent(c.peer.serverId)}`:""));inner.add(r);c.ws=r;c.ready=false;
      r.addEventListener("open",()=>{if(this._closed||c.ws!==r){r.close();return;}for(const raw of c.subs.values())r.send(raw);});
      r.addEventListener("message",e=>{
        let m;try{m=JSON.parse(String(e.data));}catch{return;}
        if(this._closed||c.ws!==r)return;
        if(m?.type==="fedprobe-remote-ready"){c.ready=true;c.attempt=0;setRemoteState(c.peer,"open");state.needsCatchUp=false;this._catchUp(c.peer);return;}
        if(acceptRemote(m,c.peer)){state.counters.wsAccepted++;this._emit(new win.MessageEvent("message",{data:String(e.data)}));}
        else {state.counters.wsDropped++;log("ws-remote-dropped",{serverId:c.peer.serverId,type:m?.type,entity:m?.entity});}
      });
      r.addEventListener("close",()=>{if(c.ws!==r)return;c.ws=null;c.ready=false;if(this._closed)return;setRemoteState(c.peer,"offline");state.needsCatchUp=true;const delay=Math.min(RETRY_MAX_MS,RETRY_MIN_MS*2**c.attempt++);c.timer=win.setTimeout(()=>{c.timer=null;this._openRemote(c);},delay);});
    }
    _catchUp(peer){for(const id of peer.ids)if(isRemote(id)){if(id.startsWith("thr_"))this._refreshThread(id);if(id.startsWith("host_"))this._refreshHost(id);}this._emitJson({type:"changed",entity:"project",id:peer.projectId,changes:["threads-changed","project-updated"]});}
    _refreshHost(id){this._emitJson({type:'changed',entity:'host',id,changes:['host-connected']});}
    _refreshThread(id){this._emitJson({type:"changed",entity:"thread",id,changes:["events-appended","interactions-changed","status-changed","queue-changed"]});}
    _restorePrimaryId(id){
      for(const [key,raw]of this._allSubs){const t=JSON.parse(raw).target;if((t.threadId??t.projectId??t.environmentId??t.hostId)!==id)continue;
        for(const c of this._channels.values())if(c.subs.delete(key)&&c.ws?.readyState===1)c.ws.send(JSON.stringify({type:"unsubscribe",target:t}));
        if(this._primary.readyState===1)this._primary.send(raw);
      }
    }
    _adoptRemoteId(id,peer,notify){
      const c=this._channels.get(peer);if(!c)return;
      for(const [key,raw]of this._allSubs){const target=JSON.parse(raw).target;if((target.threadId??target.projectId??target.environmentId??target.hostId)!==id||c.subs.has(key))continue;c.subs.set(key,raw);if(this._primary.readyState===1)this._primary.send(JSON.stringify({type:"unsubscribe",target}));if(c.ws?.readyState===1)c.ws.send(raw);}
      if(notify&&c.ready&&id.startsWith("thr_"))this._refreshThread(id);
      if(notify&&c.ready&&id.startsWith('host_'))this._refreshHost(id);
    }
    send(data){
      let m;try{m=JSON.parse(data);}catch{this._primary.send(data);return;}
      if(m?.type==="subscribe"||m?.type==="unsubscribe"){
        const t=m.target??{},key=JSON.stringify(t),id=t.threadId??t.projectId??t.environmentId??t.hostId;
        if(m.type==="subscribe")this._allSubs.set(key,data);else this._allSubs.delete(key);
        if(conflicts.has(id))return;
        for(const c of this._channels.values())if(id===undefined?LIST_KINDS.has(t.kind):owners.get(id)===c.peer){if(m.type==="subscribe")c.subs.set(key,data);else c.subs.delete(key);if(c.ws?.readyState===1)c.ws.send(data);}
        if(id===undefined||!isRemote(id))this._primary.send(data);return;
      }
      this._primary.send(data);
    }
    close(code,reason){this._shutdown();this.readyState=2;this._primary.close(code,reason);}
  }

  // ---------- install ----------
  const nativeSend = Native.prototype.send;
  let captured = false;
  const patchedSend = function (data) {
    const result = nativeSend.call(this, data);
    if (!captured && !state.disposed && !inner.has(this) && String(this.url) === coreUrl) {
      captured = true; state.counters.captured++;
      if (Native.prototype.send === patchedSend) Native.prototype.send = nativeSend;
      log("core-socket-captured", {});
      win.queueMicrotask(() => this.close(4000, "federation-install"));
    }
    return result;
  };
  // Ownership of an explicitly remote deep link is known even before bootstrap.
  // The server bridge still verifies that the thread belongs to this project.
  const routeMatch = /^\/projects\/(proj_[a-z0-9]+)\/threads\/(thr_[a-z0-9]+)/u.exec(win.location.pathname ?? new URL(win.location.href).pathname);
  const routePeer=peers.find(p=>p.projectId===routeMatch?.[1]);
  if(routePeer)addRemote(routeMatch[2],routePeer);
  win.fetch = federatedFetch;
  Native.prototype.send = patchedSend;
  win.WebSocket = FederatedSocket;
  machineView=mountRemoteMachines(win,()=>[...remoteMachines.values()].filter(m=>owners.get(m.host.id)===m.peer&&!conflicts.has(m.host.id)).map(({peer,...m})=>({...m,state:peer.state})));
  imageView=mountImageUrls(win,imageContentUrl);

  // bb pings on its own every 25 s while visible; an `online` signal makes the
  // native manager probe now (a ping is a send), so capture is prompt. Bounded,
  // cancellable, harmless when the socket is closed (bb then reconnects).
  let nudges = 0;
  let nudgeTimer = null;
  const nudge = () => {
    nudgeTimer = null;
    if (captured || state.disposed || nudges >= 6) return;
    nudges++;
    try { win.dispatchEvent(new win.Event("online")); } catch { /* ignore */ }
    nudgeTimer = win.setTimeout(nudge, 6000);
  };
  nudgeTimer = win.setTimeout(nudge, 0);

  function dispose() {
    if (state.disposed) return;
    // Restore HTTP BEFORE invalidating: BB may immediately refetch cached lists.
    // Otherwise that refetch merges remote rows back into the native cache.
    state.disposed = true;
    imageRequests.abort();imageView?.dispose();
    if (win.fetch === federatedFetch) win.fetch = nativeFetch;
    if (Native.prototype.send === patchedSend) Native.prototype.send = nativeSend;
    if (win.WebSocket === FederatedSocket) win.WebSocket = Native;
    // Let bb drop remote rows through its ordinary change handling.
    for (const s of outerSockets) {
      for(const peer of peers)s._emitJson({ type: "changed", entity: "project", id: peer.projectId, changes: ["threads-changed", "project-updated"] });
      for (const id of remoteIds) if (id.startsWith("thr_")) s._emitJson({ type: "changed", entity: "thread", id, changes: ["status-changed"] });
      for (const id of remoteIds) if (id.startsWith('host_')) s._refreshHost(id);
    }
    machineView?.dispose();remoteMachines.clear();
    if (nudgeTimer !== null) { win.clearTimeout(nudgeTimer); nudgeTimer = null; }
    // 2. clear our row decorations
    if (setRowStatus) for (const id of rowStatusIds) { try { setRowStatus(id, null); } catch { /* host may already be gone */ } }
    rowStatusIds.clear();
    // 4. close wrappers: bb reconnects natively and refetches (reconnect wave)
    for (const s of [...outerSockets]) s.close(4000, "federation-dispose");
    log("disposed", {});
  }

  return {
    dispose,
    state,
    isRemote,
    knownRemoteIds: () => [...remoteIds],
    conflicts: () => [...conflicts],
    _internals: { FederatedSocket, federatedFetch, patchedSend, coreUrl, remoteUrl, RETRY_MIN_MS, RETRY_MAX_MS },
  };
}

export async function loadConfig({ win, pluginId, signal }) {
  const r = await win.fetch(`/api/v1/plugins/${pluginId}/http/config`, { signal, headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`federation config HTTP ${r.status}`);
  const c = await r.json();
  if (!c || c.enabled !== true) return null;
  if(Array.isArray(c.servers)){
    const seen=new Set(),projects=new Set();
    const servers=c.servers.map(p=>{
      if(!p || !/^[a-z][a-z0-9-]{0,39}$/.test(p.serverId) || seen.has(p.serverId) || !/^proj_[a-z0-9]+$/.test(p.projectId) || p.projectId===PERSONAL || projects.has(p.projectId))throw Error("Invalid or duplicate federation server/project");
      seen.add(p.serverId);projects.add(p.projectId);return {serverId:p.serverId,projectId:p.projectId,label:String(p.label||p.serverId),allowWrites:p.allowWrites===true};
    });
    return servers.length?{enabled:true,servers}:null;
  }
  if (typeof c.projectId !== "string" || !ID_RE.test(c.projectId) || c.projectId === PERSONAL) {
    throw new Error("federation config: projectId must be a concrete remote project id");
  }
  return { enabled: true, projectId: c.projectId, label: typeof c.label === "string" && c.label ? c.label : "remote", allowWrites: c.allowWrites === true };
}
