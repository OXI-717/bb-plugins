import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { contract,type Route } from './contract.js';
import { runProcess,storeCredential,serviceEnvironment } from './core.js';
const pending=new Set<string>();
async function environment(route:Route,signal:AbortSignal){
 if(signal.aborted)throw new Error('Operation cancelled');
 if(route.authentication==='desktop'){
  const env:NodeJS.ProcessEnv={...process.env,OP_BIOMETRIC_UNLOCK_ENABLED:'true'};
  for(const key of Object.keys(env))if(key==='OP_SERVICE_ACCOUNT_TOKEN'||key.startsWith('OP_SESSION')||key.startsWith('OP_CONNECT')||key==='OP_RUN_NO_MASKING')delete env[key];
  return env;
 }
 return serviceEnvironment(process.env[route.tokenEnvironment!]??'');
}
export default experimental_defineHostEntry({contract,handlers:{
 store:async({route,title,username,password},ctx)=>{
  const key=route.vaultId+'\0'+title;if(pending.has(key))throw new Error('This item is already being stored');pending.add(key);
  const runner:typeof runProcess=(binary,args,env,input,signal)=>runProcess(binary,route.authentication==='desktop'?['--account',route.accountId!,...args]:args,env,input,signal);
  try{return await storeCredential(runner,await environment(route,ctx.signal),route.vaultId,title,username,password,ctx.signal);}finally{pending.delete(key);}
 },
 run:async({route,operation},ctx)=>{
  const matches=route.operations.filter(x=>x.name===operation);if(matches.length!==1)throw new Error('Operation is not configured');const op=matches[0];
  const env=await environment(route,ctx.signal);
  for(const [key,ref] of Object.entries(op.references)){if(key.startsWith('OP_')||!ref.startsWith('op://'+route.vaultId+'/'))throw new Error('Reference is outside the configured vault');env[key]=ref;}
  await runProcess('op',[...(route.authentication==='desktop'?['--account',route.accountId!]:[]),'run','--',...op.argv],env,undefined,ctx.signal);
  return {completed:true as const};
 }
}});
