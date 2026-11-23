import {spawn} from 'node:child_process';
import {readFile,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir,platform} from 'node:os';
import path from 'node:path';
import {nativeProbeLaunchSchema,nativeProbeResultSchema,type NativeProbeLaunch,type NativeProbeResult} from './native-probe-wire.js';
/** Read launch metadata references only, never provider auth or Pooler clients. */
async function target(executorId:string){
 if(platform()!=='linux')throw Error('native-diagnostic-runtime-unavailable');
 const primary=path.join(homedir(),'.config/oxi-bb/agy-native.json');
 const metadata=async(file:string)=>{
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await fd.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)||stat.size>16384)throw Error('native-diagnostic-metadata');
   return JSON.parse(await fd.readFile('utf8'));
  }finally{await fd.close();}
 };
 const first=await metadata(primary);
 const files=[primary,...(Array.isArray(first.accountProfiles)?first.accountProfiles:[])];
 if(files.length>9)throw Error('native-diagnostic-metadata');
 for(const file of files){
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error('native-diagnostic-metadata');
  const config=file===primary?first:await metadata(file);
  if(config.executorId!==executorId)continue;
  if(config.hostProcess!==true||!path.isAbsolute(config.catalogCwd??''))throw Error('native-diagnostic-runtime-unavailable');
  const instance=config.hostInstance;
  if(instance!==undefined&&(!/^[A-Za-z0-9_-]{1,80}$/.test(instance)||instance!==executorId))throw Error('native-diagnostic-metadata');
  const root=instance?`/opt/oxi-agy-native/accounts/${instance}`:'/opt/oxi-agy-native';
  return {entry:root+'/agy_host_process.py',module:root+'/agy_native_probe.py',cwd:config.catalogCwd,hostId:config.hostId};
 }
 throw Error('native-diagnostic-runtime-unavailable');
}
export async function nativeProbeCapabilities(executorId:string){
 try{const t=await target(executorId);const st=await lstat(t.module);if(!st.isFile()||st.uid!==0||(st.mode&0o022)||st.size>32768)return {protocol:0 as const};
  return {protocol:(await readFile(t.module,'utf8')).includes('DIAGNOSTIC_PROTOCOL = 1')?1 as const:0 as const};
 }catch{return {protocol:0 as const};}
}
export async function runNativeProbe(raw:NativeProbeLaunch,signal:AbortSignal):Promise<NativeProbeResult>{
 const input=nativeProbeLaunchSchema.parse(raw),t=await target(input.executorId);
 if(t.hostId!==input.hostId||input.deadline<=Date.now()||input.deadline>Date.now()+120_000)throw Error('native-diagnostic-binding');
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  // The one-use token travels only over stdin. No shell and no client credentials.
  const child=spawn('/usr/bin/sudo',['-n','/usr/bin/python3','-I',t.entry],{cwd:t.cwd,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  let output='',overflow=false;
  const stop=()=>child.kill('SIGTERM');
  const timer=setTimeout(stop,Math.max(1,input.deadline-Date.now()));signal.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',data=>{if(output.length+data.length>32768){overflow=true;stop();}else output+=data.toString('utf8');});
  child.stderr.on('data',()=>{}); // Never expose raw official/native logs.
  child.stdin.on('error',()=>{});
  child.once('error',()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(Error('native-diagnostic-launch'));});
  child.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',stop);
   try{if(code!==0||overflow||signal.aborted)throw Error();resolve(nativeProbeResultSchema.parse(JSON.parse(output)));}catch{reject(Error('native-diagnostic-unconfirmed'));}
  });
  child.stdin.end(JSON.stringify({mode:'diagnostic',...input,pid:process.pid})+'\n');
 });
}
