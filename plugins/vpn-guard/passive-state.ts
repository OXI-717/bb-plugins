import {execFile} from 'node:child_process';
import {z} from 'zod';
import {isIP} from 'node:net';
import {platform} from 'node:os';
import {lstat} from 'node:fs/promises';
import type {VpnEvidence as FileVpnEvidence} from './vpn-evidence.js';
export type VpnEvidence=Omit<FileVpnEvidence,'assurance'> & {assurance:FileVpnEvidence['assurance']|'system_ipv4';source?:'incy'|'tailscale'};

// Only OS observations: no shell, network probes, VPN controls or state files.
export type Reader=(file:string,args:string[])=>Promise<string>;
export const readCommand:Reader=(file,args)=>new Promise((resolve,reject)=>{
  execFile(file,args,{timeout:1200,maxBuffer:1048576,encoding:'utf8',env:{...process.env,LC_ALL:'C',...(file===TAILSCALE?{TAILSCALE_BE_CLI:'1'}:{})}},
    (error,stdout)=>error?reject(Error('VPN state command unavailable')):resolve(stdout));
});
const unknown=():VpnEvidence=>({state:'unknown',assurance:'invalid',reason:'invalid_evidence',updatedAt:null,probeAt:null});
const iface=(route:string)=>/^\s*interface:\s*(utun[0-9]+)\s*$/m.exec(route)?.[1];
const TAILSCALE='/Applications/Tailscale.app/Contents/MacOS/Tailscale';

async function snapshot(read:Reader) {
  const [route,trafficRoute,processes,raw]=await Promise.all([
    read('/sbin/route',['-n','get','default']),
    read('/sbin/route',['-n','get','1.1.1.1']),
    read('/bin/ps',['-axo','pid=,lstart=,comm=']),
    read(TAILSCALE,['status','--json']).catch(()=>''),
  ]);
  const tunnel=iface(route);
  if(!tunnel)return null;
  // Require both INCY and its fixed tunnel; an unrelated utun is insufficient.
  const core=processes.split('\n').find(line=>/^\s*[1-9][0-9]*\s+/.test(line)&&(/\s\/Applications\/[^\n]+\/resources\/bin\/xray\s*$/.test(line)||/\s\/Applications\/(?:incy|INCY)\.app\/Contents\/MacOS\/(?:incy|INCY)\s*$/.test(line)));
  if(tunnel==='utun244'&&core)return {source:'incy' as const,epoch:core.trim(),tunnel};
  if(iface(trafficRoute)!==tunnel)return null;
  const schema=z.object({BackendState:z.string(),ExitNodeStatus:z.object({ID:z.string(),Online:z.boolean()}).nullable().optional(),Self:z.object({TailscaleIPs:z.array(z.string())})});
  let status:z.infer<typeof schema>;
  try {status=schema.parse(JSON.parse(raw));}catch{return null;}
  const exit=status.ExitNodeStatus;
  if(status?.BackendState!=='Running'||exit?.Online!==true||typeof exit.ID!=='string'||!exit.ID)return null;
  if(!Array.isArray(status?.Self?.TailscaleIPs))return null;
  const addresses=status.Self.TailscaleIPs.filter((value:unknown):value is string=>typeof value==='string'&&isIP(value)===4&&/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(value));
  if(!addresses.length)return null;
  const link=await read('/sbin/ifconfig',[tunnel]);
  const bound=addresses.find((address:string)=>link.split('\n').some(line=>line.trim().split(/\s+/).slice(0,2).join(' ')==='inet '+address));
  if(!bound)return null;
  return {source:'tailscale' as const,epoch:exit.ID+'|'+bound,tunnel};
}

export async function readPassiveState(read:Reader=readCommand,os=platform(),now=Date.now):Promise<VpnEvidence> {
  if(os!=='darwin')return unknown();
  const started=now();
  try {
    const before=await snapshot(read),after=await snapshot(read);
    if(!before||!after||JSON.stringify(before)!==JSON.stringify(after)||now()-started>8000)return unknown();
    return {state:'connected',assurance:'system_ipv4',reason:'ok',source:after.source,updatedAt:started,probeAt:null};
  }catch{return unknown();}
}

// Existing INCY proof remains authoritative, including a failed probe or stale writer.
// Tailscale is a different active route; it does not consume INCY's proof file.
export async function selectVpnEvidence(file:string,stored:VpnEvidence,read=readPassiveState):Promise<VpnEvidence> {
  const passive=await read();
  if(passive.source==='tailscale'&&passive.state==='connected')return passive;
  try {await lstat(file);return stored;}catch(error){
    return (error as NodeJS.ErrnoException).code==='ENOENT'?passive:stored;
  }
}
