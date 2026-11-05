import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { contract,type Route } from './contract.js';
import { runProcess,storeCredential,serviceEnvironment } from './core.js';
const pending=new Set<string>();
async function environment(route:Route,signal:AbortSignal){
 let token:string|undefined;
 if(route.keychainAccount){if(process.platform!=='darwin')throw new Error('Keychain requires macOS');token=await runProcess('/usr/bin/security',['find-generic-password','-s','oxi.op.agent-service-account','-a',route.keychainAccount,'-w'],process.env,undefined,signal);}
 else token=process.env[route.tokenEnvironment!];
 return serviceEnvironment(token??'');
}
export default experimental_defineHostEntry({contract,handlers:{
 store:async({route,title,username,password},ctx)=>{
  const key=route.vaultId+'\0'+title;if(pending.has(key))throw new Error('This item is already being stored');pending.add(key);
  try{return await storeCredential(runProcess,await environment(route,ctx.signal),route.vaultId,title,username,password,ctx.signal);}finally{pending.delete(key);}
 },
 run:async({route,operation},ctx)=>{
  const matches=route.operations.filter(x=>x.name===operation);if(matches.length!==1)throw new Error('Operation is not configured');const op=matches[0];
  const env=await environment(route,ctx.signal);
  for(const [key,ref] of Object.entries(op.references)){if(key.startsWith('OP_')||!ref.startsWith('op://'+route.vaultId+'/'))throw new Error('Reference is outside the configured vault');env[key]=ref;}
  await runProcess('op',['run','--',...op.argv],env,undefined,ctx.signal);
  return {completed:true as const};
 }
}});
