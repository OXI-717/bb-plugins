import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountRemoteMachines} from '../machine-presentation.mjs';
import {createFederation} from '../federation-core.mjs';
import {createEnv} from './fake-env.mjs';

const machines=[{serverId:'alpha',label:'Alpha <test>',state:'open',host:{id:'host_alpha',name:'Worker',maxPermissionMode:'full'}}];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('remote machine group is read-only, escaped, separately labelled and cleaned up',async()=>{
  const dom=new JSDOM('<head></head><body><section><h2>Machines</h2><div data-machine-row><a href="/settings/machines/host_local">Local</a><button>Remove local</button></div><div data-machine-row><a href="/settings/machines/host_alpha">Worker</a><button>Remove remote</button><span>Full Access</span></div></section></body>',{url:'http://primary.invalid/settings/machines'});
  const {window:win}=dom;let rows=machines;const view=mountRemoteMachines(win,()=>rows);await flush();
  const panel=win.document.querySelector('section[data-federation-machines]');
  assert.match(panel.textContent,/Remote BB: Alpha <test> \(alpha\)/);assert.match(panel.textContent,/Permissions on remote server: Full Access/);
  assert.equal(panel.querySelectorAll('button,a,input,test').length,0);
  assert.match(win.document.querySelector('style').textContent,/host_alpha/);assert.doesNotMatch(win.document.querySelector('style').textContent,/host_local/);
  const link=win.document.querySelector('a[href$="host_alpha"]');const click=new win.MouseEvent('click',{bubbles:true,cancelable:true});
  assert.equal(link.dispatchEvent(click),false);assert.equal(win.location.pathname,'/settings/machines');
  win.history.pushState(null,'','/settings/machines/host_alpha');view.refresh();await flush();assert.equal(win.location.pathname,'/settings/machines');
  rows=[];view.refresh();await flush();assert.equal(panel.isConnected,false);assert.equal(win.document.querySelector('style').textContent,'');
  view.dispose();assert.equal(win.document.querySelectorAll('[data-federation-machines]').length,0);dom.window.close();
});
test('native remote host selectors are branded without changing permissions or identity; host mutations never reach either server',async()=>{
  const local={id:'host_local',name:'Laptop',type:'persistent',maxPermissionMode:'full'};
  const remote={id:'host_alpha',name:'Worker',type:'persistent',maxPermissionMode:'full'};
  const e=createEnv({primary:{'GET /api/v1/hosts':[local]},remotes:{alpha:{'GET /api/v1/hosts':[remote],'GET /api/v1/hosts/host_alpha':remote}}});
  const f=createFederation({win:e.win,config:{servers:[{serverId:'alpha',label:'Alpha',projectId:'proj_alpha',allowWrites:true}]},pluginId:'federation-pilot'});
  const hosts=await(await e.win.fetch('/api/v1/hosts')).json();assert.deepEqual(hosts[0],local);assert.deepEqual(hosts[1],{...remote,name:'🌐 Worker · Remote BB: Alpha (alpha)'});
  const detail=await(await e.win.fetch('/api/v1/hosts/host_alpha')).json();assert.equal(detail.name,hosts[1].name);
  for(const method of ['DELETE','PATCH','POST']){e.calls.length=0;const r=await e.win.fetch('/api/v1/hosts/host_alpha',{method,body:'{}'});assert.equal(r.status,403);assert.equal(e.calls.length,0);}
  e.calls.length=0;await e.win.fetch('/api/v1/hosts/host_local',{method:'PATCH',body:'{}'});assert.equal(e.calls[0].to,'primary');f.dispose();
});
test('disposal restores native fetch before host invalidation and cancels late list merging',async()=>{
  const host={id:'host_alpha',name:'Worker'};
  const e=createEnv({primary:{'GET /api/v1/hosts':[]},remote:{'GET /api/v1/hosts':[host]}});
  const f=createFederation({win:e.win,config:{projectId:'proj_alpha',label:'Alpha'},pluginId:'federation-pilot'});
  await e.win.fetch('/api/v1/hosts');
  const socket=new e.win.WebSocket('ws://primary.invalid/ws');let reread;
  socket.addEventListener('message',event=>{if(JSON.parse(event.data).entity==='host')reread=e.win.fetch('/api/v1/hosts');});
  e.calls.length=0;f.dispose();assert.deepEqual(await(await reread).json(),[]);assert.ok(e.calls.every(c=>c.to==='primary'));
  const e2=createEnv({primary:{'GET /api/v1/hosts':[]}});const native=e2.win.fetch;let resolve;
  e2.win.fetch=(input,init)=>String(input).endsWith('/proxy')?new Promise(r=>resolve=r):native(input,init);
  const f2=createFederation({win:e2.win,config:{projectId:'proj_alpha',label:'Alpha'},pluginId:'federation-pilot'});
  const pending=e2.win.fetch('/api/v1/hosts');f2.dispose();resolve(new Response(JSON.stringify([host]),{headers:{'content-type':'application/json'}}));
  assert.deepEqual(await(await pending).json(),[]);
});
