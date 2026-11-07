import {setTimeout as wait} from 'node:timers/promises';
import {z} from 'zod';
import {providerSchema} from './contracts.js';
import {GuardRequiredError} from './network-errors.js';
import {bindGuardNetworkDecision,createGuardNetworkCheck,guardStageSchema,type GuardRead,type GuardDiagnostic} from './guard-network.js';

export interface GuardServerAccess {
  serverHost:(signal:AbortSignal)=>Promise<string|null>;
  decision:(hostId:string,provider:z.infer<typeof providerSchema>,signal:AbortSignal)=>Promise<unknown>;
}
export function serverGuardRead(access:GuardServerAccess):GuardRead {
  return async(provider,signal,trace)=>{
    trace.stage('server-host');
    const hostId=await access.serverHost(signal);
    if(!hostId)throw Error('Pool server machine unknown');
    trace.host(hostId);trace.stage('guard-rpc');
    const decision=await access.decision(hostId,provider,signal);
    trace.stage('server-host-recheck');
    const current=await access.serverHost(signal);
    trace.stage('validate-host');
    if(current!==hostId)throw Error('Pool server machine changed');
    return bindGuardNetworkDecision(decision,hostId);
  };
}
export const guardProbeSchema=z.object({
  provider:providerSchema,
  delayStage:guardStageSchema.exclude(['permission','validate-host']).default('guard-rpc'),
  delayMs:z.number().int().min(0).max(4500).default(0),
  delayAttempts:z.enum(['first','all']).default('first'),
}).strict();
export type GuardProbeInput=z.infer<typeof guardProbeSchema>;
/** Read-only rehearsal. Delays belong to this invocation, never the live policy. */
export async function runGuardProbe(access:GuardServerAccess,input:GuardProbeInput,timeoutMs=4000){
  const config=guardProbeSchema.parse(input),events:GuardDiagnostic[]=[];
  const check=createGuardNetworkCheck(async(provider,signal,trace)=>{
    const inject=config.delayMs>0&&(trace.attempt===1||config.delayAttempts==='all');
    let calls=0;
    const wrapped:GuardServerAccess={
      async serverHost(s){
        const stage=calls++%2===0?'server-host':'server-host-recheck';
        if(inject&&config.delayStage===stage)await wait(config.delayMs,undefined,{signal:s});
        return access.serverHost(s);
      },
      async decision(host,p,s){
        if(inject&&config.delayStage==='guard-rpc')await wait(config.delayMs,undefined,{signal:s});
        return access.decision(host,p,s);
      },
    };
    return serverGuardRead(wrapped)(provider,signal,trace);
  },timeoutMs,event=>events.push(event));
  try{return {schema:'bb-account-pool/guard-probe/1' as const,allowed:true,route:await check(config.provider)??'guard-allowed',events};}
  catch(error){if(!(error instanceof GuardRequiredError))throw error;
    return {schema:'bb-account-pool/guard-probe/1' as const,allowed:false,code:error.code,reason:error.failureReason??'blocked',events};}
}
