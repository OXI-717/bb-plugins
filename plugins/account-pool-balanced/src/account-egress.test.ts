import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import {AccountEgress,EgressUnavailable,egressProfileSchema} from './account-egress.js';
import type {PoolKvStorage} from './core-storage.js';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const profile={id:'node-one',version:1,label:'Test exit',node:'node-one',hostIds:['host-one'],transport:'ssh-connect' as const,endpoint:'http://127.0.0.1:19081',dns:'remote' as const,ipv4:true as const,ipv6:false as const,failure:'closed' as const,expectedExit:['192.0.2.1'],assurance:'proxy-enforced' as const};
function storage():PoolKvStorage{
 const m=new Map<string,unknown>();return {get:async k=>structuredClone(m.get(k)),set:async(k,v)=>{m.set(k,structuredClone(v));},delete:async k=>{m.delete(k);},list:async()=>[...m.keys()]};
}
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const close of cleanup.splice(0).reverse())await close();});
it('requires immutable configured versions and a real account; preserves account flags',async()=>{
 const e=new AccountEgress(storage(),async()=>'host-one',async id=>id===a);cleanup.push(()=>e.close());
 await e.initialize();await e.configure(profile);await e.bind(a,{id:profile.id,version:1});
 await expect(e.bind(b,{id:profile.id,version:1})).rejects.toThrow('Account unavailable');
 await expect(e.configure({...profile,endpoint:'http://127.0.0.1:19082'})).rejects.toThrow('immutable');
 await expect(e.bind(a,{id:profile.id,version:2})).rejects.toThrow('first');
 expect((await e.acquire(b)).assigned).toBe(false);
 for(const endpoint of ['http://proxy.example:80','http://user:pass@127.0.0.1:80','https://127.0.0.1:80','http://127.0.0.1:80/bypass'])expect(egressProfileSchema.safeParse({...profile,endpoint}).success).toBe(false);
});
it('pins account and version across edits and server restart without changing process proxy',async()=>{
 const kv=storage(),e=new AccountEgress(kv,async()=>'host-one',async()=>true);cleanup.push(()=>e.close());
 await e.configure(profile);await e.bind(a,{id:profile.id,version:1});
 const initial=await e.acquire(a,'trusted-session');
 await e.configure({...profile,version:2,endpoint:'http://127.0.0.1:19082'});await e.bind(a,{id:profile.id,version:2});
 expect((await e.acquire(a,'trusted-session')).profile?.version).toBe(1);
 expect((await e.acquire(a,'new-session')).profile?.version).toBe(2);
 await expect(e.acquire(b,'trusted-session')).rejects.toBeInstanceOf(EgressUnavailable);
 const restarted=new AccountEgress(kv,async()=>'host-one',async()=>true);cleanup.push(()=>restarted.close());await restarted.initialize();
 expect((await restarted.acquire(a,'trusted-session')).profile?.version).toBe(1);
 const observed=vi.fn(async(_input:unknown,init?:RequestInit)=>{expect((init as any).dispatcher).toBeDefined();expect(init?.redirect).toBe('error');return Response.json({ok:true});});
 vi.stubGlobal('fetch',observed);
 vi.stubEnv('NO_PROXY','*');vi.stubEnv('HTTPS_PROXY','http://127.0.0.1:1');
 await initial.fetch(false)!('https://model.example/v1');expect(observed).toHaveBeenCalledOnce();
 expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:1');
});
it('keeps an already warm unassigned session on its previous route across binding and restart',async()=>{
 const kv=storage(),e=new AccountEgress(kv,async()=>'host-one',async()=>true);cleanup.push(()=>e.close());
 expect((await e.acquire(a,'already-warm')).assigned).toBe(false);
 await e.configure(profile);await e.bind(a,{id:profile.id,version:1});
 expect((await e.acquire(a,'already-warm')).assigned).toBe(false);
 expect((await e.acquire(a,'started-after-binding')).profile?.version).toBe(1);
 const restarted=new AccountEgress(kv,async()=>'host-one',async()=>true);cleanup.push(()=>restarted.close());await restarted.initialize();
 expect((await restarted.acquire(a,'already-warm')).assigned).toBe(false);
 expect((await restarted.acquire(b,'already-warm')).assigned).toBe(false);
 await restarted.bind(b,{id:profile.id,version:1});
 expect((await restarted.acquire(b,'already-warm')).assigned).toBe(false);
 expect((await restarted.acquire(b,'new-after-b-binding')).assigned).toBe(true);
 await expect(restarted.acquire(a,'new-after-b-binding')).rejects.toBeInstanceOf(EgressUnavailable);
});
it('rejects unsupported server hosts and IPv6 destinations',async()=>{
 const e=new AccountEgress(storage(),async()=>'host-two',async()=>true);cleanup.push(()=>e.close());
 await e.configure(profile);await e.bind(a,{id:profile.id,version:1});await expect(e.acquire(a)).rejects.toBeInstanceOf(EgressUnavailable);
});
it('refuses new route decisions at capacity without evicting a warm unassigned route',async()=>{
 const kv=storage(),pins=Object.fromEntries(Array.from({length:4095},(_,i)=>['assigned-'+i,{accountId:a,ref:{id:profile.id,version:1}}]));
 await kv.set('account-egress-v1',{schema:1,profiles:[profile],bindings:{[a]:{id:profile.id,version:1}},pins,unassigned:{warm:[a]}});
 const e=new AccountEgress(kv,async()=>'host-one',async id=>id===a);cleanup.push(()=>e.close());await e.initialize();
 expect((await e.acquire(a,'warm')).assigned).toBe(false);
 expect((await e.acquire(a,'assigned-0')).assigned).toBe(true);
 await expect(e.acquire(a,'new')).rejects.toBeInstanceOf(EgressUnavailable);
 expect((await e.acquire(b,'unrelated-provider')).assigned).toBe(false);
 expect((await e.acquire(a,'warm')).assigned).toBe(false);
});
it('keeps ordinary traffic working at historical capacity in real SDK storage and refuses new assignments',async()=>{
 const host=createFakePluginHost({pluginId:'account-pool-balanced'}),kv=host.bb.storage.kv;
 cleanup.push(()=>host.harness.lifecycle.dispose());
 await kv.set('account-egress-v1',{schema:1,profiles:[],bindings:{},pins:{},unassigned:Object.fromEntries(Array.from({length:4096},(_,i)=>['s'+i.toString(36),[a]]))});
 const e=new AccountEgress(kv,async()=>'host-one',async()=>true);cleanup.push(()=>e.close());await e.initialize();
 expect((await e.acquire(a,'new-ordinary')).assigned).toBe(false);
 await e.configure(profile);
 await expect(e.bind(a,{id:profile.id,version:1})).rejects.toThrow('tracking capacity');
 const restarted=new AccountEgress(kv,async()=>'host-one',async()=>true);cleanup.push(()=>restarted.close());await restarted.initialize();
 expect((await restarted.acquire(a,'new-after-restart')).assigned).toBe(false);
 await expect(restarted.bind(a,{id:profile.id,version:1})).rejects.toThrow('tracking capacity');
});
it('bounds real KV bytes without making unassigned traffic a storage quota or giving assigned traffic direct fallback',async()=>{
 const host=createFakePluginHost({pluginId:'account-pool-balanced'}),kv=host.bb.storage.kv;
 cleanup.push(()=>host.harness.lifecycle.dispose());
 const e=new AccountEgress(kv,async()=>'host-one',async()=>true);cleanup.push(()=>e.close());
 await e.configure(profile);await e.bind(b,{id:profile.id,version:1});await e.acquire(b,'warm-assigned');
 for(let i=0;i<130;i++)expect((await e.acquire(a,i.toString(36)+'x'.repeat(2040))).assigned).toBe(false);
 expect(Buffer.byteLength(JSON.stringify(await kv.get('account-egress-v1')))).toBeLessThan(256*1024);
 expect(e.snapshot().assignmentBlocked).toBe(true);
 expect((await e.acquire(a,'ordinary-after-byte-cap')).assigned).toBe(false);
 expect((await e.acquire(b,'warm-assigned')).assigned).toBe(true);
 await expect(e.acquire(b,'y'.repeat(2040))).rejects.toBeInstanceOf(EgressUnavailable);
 await expect(e.bind(a,{id:profile.id,version:1})).rejects.toThrow('tracking capacity');
});
it('sends CONNECT to the assigned socket despite NO_PROXY; socket failure never reaches the origin',async()=>{
 let connects=0,direct=0;
 const origin=http.createServer((_q,r)=>{direct++;r.end('direct');});
 await new Promise<void>(r=>origin.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>origin.close(()=>r())));
 const proxy=http.createServer();proxy.on('connect',(_request,socket)=>{connects++;socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');});
 await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
 const port=(proxy.address() as any).port,originPort=(origin.address() as any).port;
 const e=new AccountEgress(storage(),async()=>'host-one',async()=>true);cleanup.push(()=>e.close());
 await e.configure({...profile,endpoint:`http://127.0.0.1:${port}`});await e.bind(a,{id:profile.id,version:1});
 const route=await e.acquire(a);vi.stubEnv('NO_PROXY','*');
 await expect(route.fetch(false)!(`https://127.0.0.1:${originPort}/`)).rejects.toBeInstanceOf(EgressUnavailable);
 expect(connects).toBe(1);expect(direct).toBe(0);
 await new Promise<void>(r=>proxy.close(()=>r()));
 await expect(route.fetch(false)!(`https://127.0.0.1:${originPort}/`)).rejects.toBeInstanceOf(EgressUnavailable);
 expect(connects).toBe(1);expect(direct).toBe(0);
});
it('revalidates the server host for warm sessions and refuses IPv6 before dispatch',async()=>{
 let host='host-one';
 const e=new AccountEgress(storage(),async()=>host,async()=>true);cleanup.push(()=>e.close());
 await e.configure(profile);await e.bind(a,{id:profile.id,version:1});
 const route=await e.acquire(a,'session');const outgoing=vi.spyOn(globalThis,'fetch');
 await expect(route.fetch(false)!('https://[::1]/')).rejects.toBeInstanceOf(EgressUnavailable);
 host='host-two';await expect(e.acquire(a,'session')).rejects.toBeInstanceOf(EgressUnavailable);
 await expect(route.fetch(false)!('https://model.example/')).rejects.toBeInstanceOf(EgressUnavailable);
 expect(outgoing).not.toHaveBeenCalled();
});
