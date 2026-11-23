import {spawn} from 'node:child_process';
import {isAbsolute,basename} from 'node:path';
import type {TaskAssignment} from './task-contract.js';
import type {Route} from './contract.js';

/** Fixed Linux helper owns parent-death bindings; no caller command/context env. */
export async function runTaskProcess(route:Route,assignment:TaskAssignment,token:string,signal:AbortSignal){
 if(process.platform!=='linux'||signal.aborted)throw new Error('Prepared operation requires Linux and a live caller');
 const operations=route.operations.filter(x=>x.name===assignment.operation);
 if(operations.length!==1||Object.keys(operations[0].references).length)throw new Error('Fixed prepared operation required');
 const argv=operations[0].argv;
 if(argv.length!==4||!isAbsolute(argv[0])||argv[1]!=='-I'||!isAbsolute(argv[2])||basename(argv[2])!=='native_unlock.py'||argv[3]!=='--automatic')
  throw new Error('Fixed isolated prepared operation argv required');
 const remaining=Math.min(25_000,assignment.deadline-Date.now());
 if(remaining<=0||!token||token!==token.trim())throw new Error('Prepared operation expired or context unavailable');
 const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',OP_SERVICE_ACCOUNT_TOKEN:token,OP_BIOMETRIC_UNLOCK_ENABLED:'false'};
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(argv[0],['-I',argv[2],'--op-parent',String(process.pid)],{env,detached:true,stdio:['pipe','ignore','ignore']});
  let expired=false,cleanupFailed=false;
  const kill=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')cleanupFailed=true;}};
  const abort=()=>kill();signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{expired=true;kill();},remaining);
  const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  child.on('exit',()=>kill()); // Wrapper exit cannot leave its operation group alive.
  child.on('error',()=>{finish();reject(new Error('Prepared operation could not start'));});
  child.on('close',code=>{finish();if(code!==0||expired||cleanupFailed||signal.aborted)reject(new Error('Prepared operation outcome unconfirmed'));else resolve();});
  child.stdin.on('error',()=>{});
  const frame=Buffer.from(JSON.stringify({parentPid:child.pid,assignment,vaultId:route.vaultId,opBinary:route.opBinary}));
  const length=Buffer.alloc(4);length.writeUInt32BE(frame.length);
  if(frame.length>8192){kill();child.stdin.end();return;}
  child.stdin.end(Buffer.concat([length,frame]));
  if(signal.aborted)kill();
 });
}
