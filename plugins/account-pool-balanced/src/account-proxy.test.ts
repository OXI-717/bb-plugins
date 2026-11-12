import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {afterEach,expect,it,vi} from 'vitest';
import {AccountEgress,EgressUnavailable} from './account-egress.js';
import {ProxySecrets,parseProxyUrl} from './proxy-secrets.js';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pool-proxy-'));cleanup.push(()=>fs.rm(dir,{recursive:true,force:true}));
 const secrets=new ProxySecrets(path.join(dir,'proxy'));
 const data=new Map<string,unknown>();
 const kv={get:async(k:string)=>structuredClone(data.get(k)),set:async(k:string,v:unknown)=>{data.set(k,structuredClone(v));},delete:async(k:string)=>{data.delete(k);},list:async()=>[...data.keys()]};
 const e=new AccountEgress(kv,async()=>'server-one',async()=>true,secrets);cleanup.push(()=>e.close());
 return {dir,secrets,kv,e};
}
it('validates HTTP/HTTPS without reflecting credentials and refuses SOCKS, paths, IPv6 and malformed encodings',()=>{
 for(const value of ['socks5://user:private@proxy.example:1080','http://user:private@proxy.example/path','http://user:private@proxy.example/?q=1','http://[::1]:80','http://user:%xx@proxy.example:80','garbage','http://proxy.example\n']){
  expect(()=>parseProxyUrl(value)).toThrow();try{parseProxyUrl(value);}catch(e){expect(String(e)).not.toContain('private');}
 }
 expect(parseProxyUrl('https://proxy.example:8443').protocol).toBe('https:');
});
it('keeps credentials in private immutable files, pins versions across restart, isolates accounts and denies missing secrets',async()=>{
 const {e,dir,kv,secrets}=await fixture();
 await e.configureProxy({accountId:a,url:'http://test-user:private-value@proxy.example:8080'});
 const snap=e.snapshot(),ref=snap.bindings[a];
 expect(JSON.stringify(snap)).not.toContain('private-value');expect(JSON.stringify(snap)).not.toContain('test-user');
 const profile=snap.profiles[0];expect(profile.transport).toBe('http-connect');
 expect((await fs.stat(path.join(dir,'proxy'))).mode&0o777).toBe(0o700);
 for(const name of await fs.readdir(path.join(dir,'proxy')))expect((await fs.stat(path.join(dir,'proxy',name))).mode&0o777).toBe(0o600);
 const old=await e.acquire(a,'old');expect(old.assigned).toBe(true);expect((await e.acquire(b)).assigned).toBe(false);
 await e.configureProxy({accountId:a,url:'http://other:another-value@proxy.example:8081'});
 expect((await e.acquire(a,'old')).profile?.id).toBe(ref.id);
 const restarted=new AccountEgress(kv,async()=>'server-one',async()=>true,secrets);cleanup.push(()=>restarted.close());await restarted.initialize();
 expect((await restarted.acquire(a,'old')).profile?.id).toBe(ref.id);
 expect((await restarted.acquire(a,'new')).profile?.id).not.toBe(ref.id);
 expect(()=>e.validateNativeProfile(ref,'server-one')).toThrow(EgressUnavailable);
 const missing=new AccountEgress(kv,async()=>'server-one',async()=>true);cleanup.push(()=>missing.close());await missing.initialize();
 await expect(missing.acquire(a)).rejects.toThrow(EgressUnavailable);
 await expect(restarted.acquire(b,'old')).rejects.toThrow(EgressUnavailable);
});
it('uses authenticated CONNECT on a real socket despite inherited bypasses and never contacts origin on proxy failure',async()=>{
 const {e}=await fixture();let connections=0,direct=0;let authorization:string|undefined;
 const origin=http.createServer((_q,r)=>{direct++;r.end();});await new Promise<void>(r=>origin.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>origin.close(()=>r())));
 const proxy=http.createServer();proxy.on('connect',(req,socket)=>{connections++;authorization=req.headers['proxy-authorization'];socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');});
 await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
 const port=(proxy.address() as any).port,target=(origin.address() as any).port;
 await e.configureProxy({accountId:a,url:`http://test-user:private-value@127.0.0.1:${port}`});
 const route=await e.acquire(a);vi.stubEnv('NO_PROXY','*');vi.stubEnv('no_proxy','*');vi.stubEnv('https_proxy','http://127.0.0.1:1');
 await expect(route.fetch(false)!(`https://127.0.0.1:${target}/`)).rejects.toThrow(EgressUnavailable);
 expect(connections).toBe(1);expect(authorization).toBe('Basic '+Buffer.from('test-user:private-value').toString('base64'));expect(direct).toBe(0);
 await new Promise<void>(r=>proxy.close(()=>r()));
 await expect(route.fetch(false)!(`https://127.0.0.1:${target}/`)).rejects.toThrow(EgressUnavailable);
 expect(connections).toBe(1);expect(direct).toBe(0);
});
