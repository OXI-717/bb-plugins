import {execFile} from 'node:child_process';
import {z} from 'zod';
import {isIP} from 'node:net';
import {platform} from 'node:os';
import {lstat} from 'node:fs/promises';
import type {VpnEvidence as FileVpnEvidence} from './vpn-evidence.js';
export type VpnEvidence=Omit<FileVpnEvidence,'assurance'> & {assurance:FileVpnEvidence['assurance']|'system_ipv4';source?:'incy'|'tailscale'};

function isTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const err = error as {
    message?: string;
    name?: string;
    code?: string | number;
    killed?: boolean;
    signal?: string | null;
  };
  return (
    err.message === 'timeout' ||
    err.name === 'AbortError' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ABORT_ERR' ||
    Boolean(err.killed) ||
    err.signal === 'SIGKILL' ||
    err.signal === 'SIGTERM'
  );
}

// Only OS observations: no shell, network probes, VPN controls or state files.
export type ReaderOptions={timeout?:number;signal?:AbortSignal};
export type Reader=(file:string,args:string[],options?:ReaderOptions)=>Promise<string>;
export const readCommand:Reader=(file,args,options)=>new Promise((resolve,reject)=>{
  if(options?.signal?.aborted)return reject(Error('timeout'));
  const timeout=Math.max(1,Math.min(1200,options?.timeout??1200));
  execFile(file,args,{timeout,killSignal:'SIGKILL',signal:options?.signal,maxBuffer:1048576,encoding:'utf8',env:{...process.env,LC_ALL:'C',...(file===TAILSCALE?{TAILSCALE_BE_CLI:'1'}:{})}},
    (error,stdout)=>{
      if(!error)return resolve(stdout);
      if(options?.signal?.aborted||isTimeoutError(error))return reject(Error('timeout'));
      return reject(Error('VPN state command unavailable'));
    });
});
export const unknown=():VpnEvidence=>({state:'unknown',assurance:'invalid',reason:'invalid_evidence',updatedAt:null,probeAt:null});
export const readDeadline=():VpnEvidence=>({state:'unknown',assurance:'invalid',reason:'read_deadline',updatedAt:null,probeAt:null});
const iface=(route:string)=>/^\s*interface:\s*(utun[0-9]+)\s*$/m.exec(route)?.[1];
const TAILSCALE='/Applications/Tailscale.app/Contents/MacOS/Tailscale';

async function snapshot(read:Reader,options?:ReaderOptions) {
  const startSnapshot=performance.now();
  const snapshotBudget=options?.timeout??1200;
  const [route,trafficRoute,processes,raw]=await Promise.all([
    read('/sbin/route',['-n','get','default'],options),
    read('/sbin/route',['-n','get','1.1.1.1'],options),
    read('/bin/ps',['-axo','pid=,lstart=,comm='],options),
    read(TAILSCALE,['status','--json'],options).catch(err=>isTimeoutError(err)?null:''),
  ]);
  const tunnel=iface(route);
  if(!tunnel)return null;
  // Require both INCY and its fixed tunnel; an unrelated utun is insufficient.
  const core=processes.split('\n').find(line=>/^\s*[1-9][0-9]*\s+/.test(line)&&(/\s\/Applications\/[^\n]+\/resources\/bin\/xray\s*$/.test(line)||/\s\/Applications\/(?:incy|INCY)\.app\/Contents\/MacOS\/(?:incy|INCY)\s*$/.test(line)));
  if(tunnel==='utun244'&&core)return {source:'incy' as const,epoch:core.trim(),tunnel};
  if(iface(trafficRoute)!==tunnel)return null;
  if(raw===null)throw Error('timeout');
  const schema=z.object({BackendState:z.string(),ExitNodeStatus:z.object({ID:z.string(),Online:z.boolean()}).nullable().optional(),Self:z.object({TailscaleIPs:z.array(z.string())})});
  let status:z.infer<typeof schema>;
  try {status=schema.parse(JSON.parse(raw));}catch{return null;}
  const exit=status.ExitNodeStatus;
  if(status?.BackendState!=='Running'||exit?.Online!==true||typeof exit.ID!=='string'||!exit.ID)return null;
  if(!Array.isArray(status?.Self?.TailscaleIPs))return null;
  const addresses=status.Self.TailscaleIPs.filter((value:unknown):value is string=>typeof value==='string'&&isIP(value)===4&&/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(value));
  if(!addresses.length)return null;
  const remIfconfig=snapshotBudget-Math.round(performance.now()-startSnapshot);
  if(remIfconfig<=0||options?.signal?.aborted)throw Error('timeout');
  const link=await read('/sbin/ifconfig',[tunnel],{signal:options?.signal,timeout:remIfconfig});
  const bound=addresses.find((address:string)=>link.split('\n').some(line=>line.trim().split(/\s+/).slice(0,2).join(' ')==='inet '+address));
  if(!bound)return null;
  return {source:'tailscale' as const,epoch:exit.ID+'|'+bound,tunnel};
}

export type PassiveStateOptions={signal?:AbortSignal;timeoutMs?:number};

export async function readPassiveState(read:Reader=readCommand,os=platform(),now=Date.now,options?:PassiveStateOptions):Promise<VpnEvidence> {
  if(os!=='darwin')return unknown();
  const started=now();
  const budget=options?.timeoutMs??2000;
  const deadline=started+budget;
  try {
    const rem1=deadline-now();
    if(rem1<=0||options?.signal?.aborted)return readDeadline();
    const before=await snapshot(read,{signal:options?.signal,timeout:Math.min(1200,Math.max(1,rem1))});
    const rem2=deadline-now();
    if(rem2<=0||options?.signal?.aborted)return readDeadline();
    const after=await snapshot(read,{signal:options?.signal,timeout:Math.min(1200,Math.max(1,rem2))});
    if(now()-started>budget||options?.signal?.aborted)return readDeadline();
    if(!before||!after||JSON.stringify(before)!==JSON.stringify(after))return unknown();
    return {state:'connected',assurance:'system_ipv4',reason:'ok',source:after.source,updatedAt:started,probeAt:null};
  }catch(error){
    if(isTimeoutError(error)||now()-started>budget||options?.signal?.aborted)return readDeadline();
    return unknown();
  }
}

export async function lstatWithTimeout(file:string,timeoutMs:number,signal?:AbortSignal) {
  if(timeoutMs<=0||signal?.aborted)throw Error('timeout');
  let timer:ReturnType<typeof setTimeout>|undefined;
  let onAbort:(()=>void)|undefined;
  const timeoutPromise=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),timeoutMs);});
  const abortPromise=signal?new Promise<never>((_,reject)=>{
    if(signal.aborted)reject(Error('timeout'));
    else {
      onAbort=()=>reject(Error('timeout'));
      signal.addEventListener('abort',onAbort,{once:true});
    }
  }):null;
  try {
    return await Promise.race([lstat(file),timeoutPromise,...(abortPromise?[abortPromise]:[])]);
  } finally {
    clearTimeout(timer);
    if(signal&&onAbort)signal.removeEventListener('abort',onAbort);
  }
}

export type SelectEvidenceOptions=PassiveStateOptions&{now?:()=>number;lstatFn?:(file:string)=>Promise<unknown>};

// Existing INCY proof remains authoritative, including a failed probe or stale writer.
// Tailscale is a different active route; it does not consume INCY's proof file.
export async function selectVpnEvidence(
  file:string,
  stored:VpnEvidence,
  read:(r?:Reader,os?:NodeJS.Platform,n?:()=>number,opts?:PassiveStateOptions)=>Promise<VpnEvidence>=readPassiveState,
  options?:SelectEvidenceOptions
):Promise<VpnEvidence> {
  const now=options?.now??Date.now;
  const started=now();
  const budget=options?.timeoutMs??2000;
  const deadline=started+budget;
  const remForPassive=deadline-now();
  if(remForPassive<=0||options?.signal?.aborted)return readDeadline();

  let passive:VpnEvidence;
  try{
    passive=await read(readCommand,platform(),now,{signal:options?.signal,timeoutMs:remForPassive});
  }catch(error){
    if(isTimeoutError(error)||now()-started>budget||options?.signal?.aborted)return readDeadline();
    return unknown();
  }
  if(passive.source==='tailscale'&&passive.state==='connected')return passive;
  if(passive.reason==='read_deadline')return readDeadline();

  const remForLstat=deadline-now();
  if(remForLstat<=0||options?.signal?.aborted)return readDeadline();

  try {
    if(options?.lstatFn)await options.lstatFn(file);
    else await lstatWithTimeout(file,remForLstat,options?.signal);
    if(now()-started>budget||options?.signal?.aborted)return readDeadline();
    return stored;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'){
      if(now()-started>budget||options?.signal?.aborted)return readDeadline();
      return passive;
    }
    if(isTimeoutError(error)||(error as Error).message==='timeout'||now()-started>budget||options?.signal?.aborted)return readDeadline();
    return stored;
  }
}
