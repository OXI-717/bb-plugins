import {expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {lstatWithTimeout,readCommand,readPassiveState,selectVpnEvidence,type Reader} from './passive-state.js';
import {readRemoteEvidence} from './remote-evidence.js';
import type {VpnEvidence} from './passive-state.js';
const ip='100.80.1.2';
function fixture(overrides:{iface?:string;external?:string;bound?:string;core?:boolean;exit?:boolean;online?:boolean;backend?:string;raw?:string}={}){
 const calls:[string,string[]][]=[];
 const read:Reader=async(file,args)=>{
  calls.push([file,args]);
  if(file==='/sbin/route')return 'interface: '+(args.at(-1)==='default'?(overrides.iface??'utun5'):(overrides.external??overrides.iface??'utun5'));
  if(file==='/sbin/ifconfig')return 'inet '+(overrides.bound??ip)+' --> '+ip;
  if(file==='/bin/ps')return overrides.core?' 1234 Wed Nov 11 12:00:00 2026 /Applications/Example.app/Contents/resources/bin/xray':'';
  return overrides.raw??JSON.stringify({BackendState:overrides.backend??'Running',Self:{TailscaleIPs:[ip]},ExitNodeStatus:overrides.exit===false?null:{ID:'example-exit',Online:overrides.online??true}});
 };
 return {read,calls};
}
it('accepts a stable Tailscale exit route using only status commands',async()=>{
 const {read,calls}=fixture();
 expect(await readPassiveState(read,'darwin',()=>1000)).toEqual({state:'connected',assurance:'system_ipv4',source:'tailscale',reason:'ok',updatedAt:1000,probeAt:null});
 expect(calls.length).toBe(10);
 expect(calls.every(([file,args])=>['/sbin/route','/sbin/ifconfig','/bin/ps','/Applications/Tailscale.app/Contents/MacOS/Tailscale'].includes(file)&&!args.some(arg=>['up','down','set','connect','disconnect'].includes(arg)))).toBe(true);
});
it('accepts INCY without a Tailscale installation',async()=>{
 const {read}=fixture({iface:'utun244',core:true,raw:'invalid'});
 expect(await readPassiveState(read,'darwin')).toMatchObject({state:'connected',source:'incy'});
});
it.each([{exit:false},{online:false},{backend:'Stopped'},{iface:'en0'},{external:'en0'},{bound:'100.80.1.3'},{raw:'bad json'},{iface:'utun244',raw:'null'}])('denies unconfirmed or ambiguous VPN state %#',async options=>{
 expect(await readPassiveState(fixture(options).read,'darwin')).toMatchObject({state:'unknown',assurance:'invalid'});
});
it('rejects route changes during observation',async()=>{
 let n=0;const a=fixture().read,b=fixture({iface:'en0'}).read;
 expect(await readPassiveState((f,args)=>(++n<=5?a:b)(f,args),'darwin')).toMatchObject({state:'unknown'});
});
it('does not run macOS commands on other platforms or expose errors',async()=>{
 const {read,calls}=fixture();expect(await readPassiveState(read,'linux')).toMatchObject({state:'unknown'});expect(calls).toEqual([]);
 expect(JSON.stringify(await readPassiveState(async()=>{throw Error('sensitive');},'darwin'))).not.toContain('sensitive');
});
it('preserves existing INCY proof, and falls back only for a missing file',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'vpn-passive-'));
 try{
  const file=path.join(root,'state');
  const stored:VpnEvidence={state:'unknown',assurance:'invalid',reason:'probe_failed',updatedAt:null,probeAt:null};
  const passive=await readPassiveState(fixture({iface:'utun244',core:true}).read,'darwin');
  expect(await selectVpnEvidence(file,stored,async()=>passive)).toEqual(passive);
  await writeFile(file,'{}');
  expect(await selectVpnEvidence(file,stored,async()=>passive)).toEqual(stored);
  const ts=await readPassiveState(fixture().read,'darwin');
  expect(await selectVpnEvidence(file,stored,async()=>ts)).toEqual(ts);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('validates passive state freshness and identity on server receipt',async()=>{
 const good=await readPassiveState(fixture().read,'darwin');
 const check=(e:VpnEvidence)=>readRemoteEvidence(async()=>({state:'connected',evidence:e}),()=>{});
 expect(await check(good)).toMatchObject({state:'connected'});
 for(const bad of [{updatedAt:Date.now()-11000},{updatedAt:Date.now()+10000},{source:undefined},{probeAt:Date.now()}]){
  expect(await check({...good,...bad})).toMatchObject({state:'unknown'});
 }
});

it('does not mistake an intentional INCY DNS bypass for VPN loss',async()=>{
 expect(await readPassiveState(fixture({iface:'utun244',external:'en0',core:true}).read,'darwin')).toMatchObject({state:'connected',source:'incy'});
});

it('recognizes INCY with an embedded core',async()=>{
 const {read}=fixture({iface:'utun244',external:'en0',core:true});
 expect(await readPassiveState((file,args)=>file==='/bin/ps'?Promise.resolve(' 1234 Wed Nov 11 12:00:00 2026 /Applications/incy.app/Contents/MacOS/incy'):read(file,args),'darwin')).toMatchObject({state:'connected',source:'incy'});
});

it('rejects passive observation when second snapshot exceeds the budget',async()=>{
  let callCount=0;
  const slowSecondRead:Reader=async(file,args,options)=>{
    callCount++;
    if(callCount>5){
      return new Promise(resolve=>setTimeout(()=>resolve(''),500));
    }
    return fixture().read(file,args,options);
  };
  const result=await readPassiveState(slowSecondRead,'darwin',Date.now,{timeoutMs:50});
  expect(result).toMatchObject({state:'unknown',assurance:'invalid'});
});

it('returns unknown and does not fall back to passive INCY when lstat times out',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'vpn-passive-'));
  try{
    const file=path.join(root,'state');
    const stored:VpnEvidence={state:'unknown',assurance:'invalid',reason:'probe_failed',updatedAt:null,probeAt:null};
    const incyPassive=await readPassiveState(fixture({iface:'utun244',core:true}).read,'darwin');
    expect(incyPassive).toMatchObject({state:'connected',source:'incy'});

    const slowLstat=()=>new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('timeout')),500));
    const result=await selectVpnEvidence(file,stored,async()=>incyPassive,{
      timeoutMs:50,
      lstatFn:slowLstat,
    });
    expect(result).toMatchObject({state:'unknown',assurance:'invalid'});
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

it('aborts commands when signal is triggered',async()=>{
  const controller=new AbortController();
  controller.abort();
  const result=await readPassiveState(readCommand,'darwin',Date.now,{signal:controller.signal});
  expect(result).toMatchObject({state:'unknown',assurance:'invalid'});
});

it('returns read_deadline when passive read exhausts budget with a valid stored file',async()=>{
  const stored:VpnEvidence={state:'connected',assurance:'verified_ipv4',reason:'ok',updatedAt:Date.now(),probeAt:Date.now()};
  const slowPassive=()=>new Promise<VpnEvidence>(resolve=>setTimeout(()=>resolve({state:'unknown',assurance:'invalid',reason:'read_deadline',updatedAt:null,probeAt:null}),200));
  const result=await selectVpnEvidence('/tmp/dummy',stored,slowPassive as never,{timeoutMs:50});
  expect(result).toMatchObject({state:'unknown',assurance:'invalid',reason:'read_deadline'});
});

it('retains invalid_evidence when stored evidence is invalid and read is within budget',async()=>{
  const stored:VpnEvidence={state:'unknown',assurance:'invalid',reason:'invalid_evidence',updatedAt:null,probeAt:null};
  const fastPassive=async():Promise<VpnEvidence>=>({state:'unknown',assurance:'invalid',reason:'invalid_evidence',updatedAt:null,probeAt:null});
  const fastLstat=async()=>({});
  const result=await selectVpnEvidence('/tmp/dummy',stored,fastPassive as never,{timeoutMs:1000,lstatFn:fastLstat});
  expect(result).toMatchObject({state:'unknown',assurance:'invalid',reason:'invalid_evidence'});
});

it('cleans up abort listener on lstatWithTimeout completion in finally',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'vpn-lstat-'));
  try{
    const file=path.join(root,'test-file');
    await import('node:fs/promises').then(fs=>fs.writeFile(file,'ok'));
    const controller=new AbortController();
    const spy=vi.spyOn(controller.signal,'removeEventListener');
    await lstatWithTimeout(file,1000,controller.signal);
    expect(spy).toHaveBeenCalledWith('abort',expect.any(Function));
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

it('passes only the remaining budget to ifconfig after parallel commands',async()=>{
  const recordedTimeouts:number[]=[];
  const mockRead:Reader=async(file,args,options)=>{
    if(file==='/sbin/ifconfig'){
      recordedTimeouts.push(options?.timeout??0);
      return 'inet 100.64.0.1';
    }
    if(file==='/sbin/route')return 'interface: utun10';
    if(file==='/bin/ps')return '123 /Applications/Tailscale.app/Contents/MacOS/Tailscale';
    if(file.includes('Tailscale'))return JSON.stringify({BackendState:'Running',ExitNodeStatus:{ID:'exit1',Online:true},Self:{TailscaleIPs:['100.64.0.1']}});
    return '';
  };
  await readPassiveState(mockRead,'darwin',Date.now,{timeoutMs:1000});
  expect(recordedTimeouts.length).toBeGreaterThan(0);
  expect(recordedTimeouts[0]).toBeLessThanOrEqual(1000);
});
