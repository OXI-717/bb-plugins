export class ConfigurationChangedError extends Error {}
// Bounded, per-destination recovery. Only probes and explicitly safe reads repeat.
export type FailureKind='bridge_offline'|'bridge_unavailable'|'ssh_unavailable'|'remote_bb_unavailable';
export function failureKind(error:unknown):FailureKind {
 const message=error instanceof Error?error.message:'';
 for(const kind of ['bridge_offline','ssh_unavailable','remote_bb_unavailable'] as const)
  if(message.includes(`federation:${kind}`))return kind;
 return 'bridge_unavailable';
}
export const failureLabels:Record<FailureKind,string>={bridge_offline:'Bridge machine offline',bridge_unavailable:'Bridge worker unavailable',ssh_unavailable:'SSH unavailable',remote_bb_unavailable:'Remote BB unavailable'};
export function retryDelay(attempt:number,random=Math.random){return Math.round(Math.min(60000,1000*2**Math.min(attempt,6))*(0.8+0.2*random()));}
export function createRecovery(deps:{probe:(signal:AbortSignal)=>Promise<void>,notify:()=>Promise<void>,now?:()=>number,random?:()=>number,setTimer?:typeof setTimeout,clearTimer?:typeof clearTimeout}){
 const now=deps.now??Date.now,setTimer=deps.setTimer??setTimeout,clearTimer=deps.clearTimer??clearTimeout;
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|null=null,pending:Promise<void>|null=null,notified=false,notifying=false;
 const state={status:'connecting' as 'connecting'|'connected'|FailureKind,lastSuccess:null as number|null,outageSince:null as number|null,retryAt:null as number|null,attempt:0};
 const active=()=>!controller.signal.aborted;
 function schedule(delay:number){if(!active()||timer!==null)return;state.retryAt=now()+delay;timer=setTimer(()=>{timer=null;void check().catch(()=>{});},delay);}
 function failed(error:unknown){if(!active())return;if(state.status==='connected'&&timer!==null){clearTimer(timer);timer=null;}state.status=failureKind(error);state.outageSince??=now();
  if(!notified&&!notifying&&now()-state.outageSince>=120000){notifying=true;const outage=state.outageSince;void deps.notify().then(()=>{if(state.outageSince===outage)notified=true;}).catch(()=>{}).finally(()=>{notifying=false;});}
  if(timer===null)schedule(retryDelay(state.attempt++,deps.random));
 }
 function success(){if(!active())return;state.status='connected';state.lastSuccess=now();state.outageSince=null;state.attempt=0;notified=false;
  if(timer!==null){clearTimer(timer);timer=null;}schedule(30000);
 }
 function check():Promise<void>{
  if(!active())return Promise.reject(Error('Federation monitor disposed'));
  if(pending)return pending;
  const task=Promise.resolve().then(()=>deps.probe(controller.signal)).then(()=>{if(!active())throw Error('Federation monitor disposed');success();},e=>{failed(e);throw e;});
  pending=task;void task.finally(()=>{if(pending===task)pending=null;}).catch(()=>{});return task;
 }
 async function ready(){
  if(!active())throw Error('Federation monitor disposed');
  if(state.status==='connected')return;
  if(pending)return pending;
  if(state.retryAt!==null&&now()<state.retryAt)throw Error(`federation:${state.status}`);
  return check();
 }
 async function run<T>(method:string,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  await ready();
  const limit=method==='GET'||method==='HEAD'?2:1;
  for(let attempt=0;;attempt++)try{const value=await action(controller.signal);if(!active())throw Error('Federation monitor disposed');return value;}
  catch(error){if(error instanceof ConfigurationChangedError)throw error;if(!active())throw Error('Federation monitor disposed');failed(error);if(attempt+1>=limit)throw Error(`federation:${failureKind(error)}`);
   // One immediate health probe permits at most one retry of this safe read.
   await check();
  }
 }
 return {state,check,run,signal:controller.signal,dispose(){controller.abort();if(timer!==null)clearTimer(timer);timer=null;state.retryAt=null;}};
}
