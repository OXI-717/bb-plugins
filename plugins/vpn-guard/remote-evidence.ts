import {z} from 'zod';
import type {VpnEvidence,VpnState} from './vpn-evidence.js';
import {VPN_FILE_TTL_MS,VPN_PROBE_TTL_MS} from './vpn-evidence.js';

export const rpcDiagnosticSchema=z.object({category:z.enum(['ok','timeout','host_unavailable','cancelled','rpc_error']),elapsedMs:z.number().int().nonnegative()});
type Diagnostic=z.infer<typeof rpcDiagnosticSchema>;
type HostState={state:VpnState;evidence?:VpnEvidence};
const errorShape=z.object({code:z.string().optional(),name:z.string().optional(),body:z.object({code:z.string().optional()}).optional()});
function errorCategory(error:unknown):Diagnostic['category'] {
  const parsed=errorShape.safeParse(error);
  const code=parsed.success?(parsed.data.body?.code??parsed.data.code):undefined;
  if(code==='command_timeout'||code==='host_rpc_timeout'||error instanceof Error&&/deadline|timed out|timeout/i.test(error.message))return 'timeout';
  if(code==='host_unavailable'||error instanceof Error&&error.message==='Host is not connected')return 'host_unavailable';
  if(code==='request_cancelled'||parsed.success&&parsed.data.name==='AbortError')return 'cancelled';
  return 'rpc_error';
}
export async function readRemoteEvidence(call:(timeoutMs:number)=>Promise<HostState>,onFailure:(diagnostic:Diagnostic)=>void):Promise<HostState&{rpc:Diagnostic}> {
  const started=performance.now();
  const diagnostic=(category:Diagnostic['category']):Diagnostic=>({category,elapsedMs:Math.max(0,Math.round(performance.now()-started))});
  let result:HostState;
  try {result=await call(10_000);}
  catch(error){const rpc=diagnostic(errorCategory(error));onFailure(rpc);return {state:'unknown',rpc};}
  const evidence=result.evidence;
  const now=Date.now();
  const fresh=(at:number|null,ttl:number)=>at!==null&&Number.isSafeInteger(at)&&now-at>=0&&now-at<=ttl;
  let reason:string|null=null;
  if(evidence&&evidence.assurance==='verified_ipv4') {
    if(result.state!==evidence.state||evidence.state!=='connected'||evidence.reason!=='ok')reason='invalid_evidence';
    else if(!fresh(evidence.updatedAt,VPN_FILE_TTL_MS))reason='file_stale_or_schema';
    else if(!fresh(evidence.probeAt,VPN_PROBE_TTL_MS)||evidence.probeAt===null||evidence.updatedAt===null||evidence.probeAt>evidence.updatedAt)reason='probe_unverified';
  }
  return {...(reason?{state:'unknown' as const,evidence:{state:'unknown' as const,assurance:'invalid' as const,reason,updatedAt:null,probeAt:null}}:result),rpc:diagnostic('ok')};
}
