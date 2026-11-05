import { spawn } from 'node:child_process';
export type Runner = (binary:string,args:string[],env:NodeJS.ProcessEnv,input?:string,signal?:AbortSignal)=>Promise<string>;
export const runProcess:Runner=(binary,args,env,input,signal)=>new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(new Error('Operation cancelled'));return;}
 const child=spawn(binary,args,{env,stdio:['pipe','pipe','pipe']});let output='';let exceeded=false;
 const kill=()=>child.kill('SIGKILL');const timer=setTimeout(kill,90000);signal?.addEventListener('abort',kill,{once:true});
 const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',kill);};
 child.stdout.on('data',chunk=>{if(output.length+chunk.length>1048576){exceeded=true;kill();}else output+=chunk;});child.stderr.resume();
 child.on('error',()=>{finish();reject(new Error('Credential process could not start'));});
 child.on('close',code=>{finish();if(code!==0||exceeded||signal?.aborted)reject(new Error('Credential operation failed or cancelled; output suppressed'));else resolve(output);});
 child.stdin.on('error',()=>{});child.stdin.end(input);
});
export async function storeCredential(run:Runner,env:NodeJS.ProcessEnv,vault:string,title:string,username:string,password:string,signal?:AbortSignal){
 const op=async(args:string[],input?:unknown)=>{try{return JSON.parse(await run('op',args,env,input===undefined?undefined:JSON.stringify(input),signal));}catch{throw new Error('1Password operation failed; retry the same title to recover an uncertain write');}};
 const items=await op(['item','list','--vault',vault,'--format=json']);
 if(!Array.isArray(items))throw new Error('Invalid item list');
 const matches=items.filter((x:{title:string})=>x.title===title);if(matches.length>1)throw new Error('Duplicate titles need owner review');
 let itemId=matches[0]?.id;
 if(!itemId){const item=await op(['item','create','-','--vault',vault,'--format=json'],{category:'LOGIN',title,fields:[{label:'username',type:'STRING',value:username},{label:'password',type:'CONCEALED',value:password}]});itemId=item.id;}
 if(typeof itemId!=='string'||!itemId)throw new Error('No item identifier returned');
 const stored=await op(['item','get',itemId,'--vault',vault,'--reveal','--format=json']);
 if(!Array.isArray(stored.fields))throw new Error('Invalid read-back response');
 const fields=new Map(stored.fields.map((x:{label:string;value:string})=>[x.label,x.value]));
 if(fields.get('password')!==password||fields.get('username')!==username)throw new Error('Existing or created item differs; no overwrite performed');
 return {itemId,verified:true as const};
}
export function serviceEnvironment(token:string){
 if(!token.trim())throw new Error('Scoped service account is missing');
 const env:NodeJS.ProcessEnv={...process.env,OP_SERVICE_ACCOUNT_TOKEN:token.trim(),OP_BIOMETRIC_UNLOCK_ENABLED:'false'};
 delete env.OP_RUN_NO_MASKING;return env;
}
