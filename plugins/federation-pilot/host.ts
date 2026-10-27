import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer, connect as connectTcp } from 'node:net';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { promisify } from 'node:util';
import { assertSafeSshConfig, SSH_OPTIONS } from './ssh-policy.ts';
import { hostContract, hostSignals } from './contract.ts';
import {uploadImage} from './image-upload.ts';
import {uploadHandoffFile,handoffHostPayload} from './handoff-upload.ts';

// The SSH child belongs to this host worker. No shell, enrollment or agent runs.
type Tunnel={child:ChildProcess|null,pending:Promise<number>};
const tunnels=new Map<string,Tunnel>();
const socketDestinations=new Map<string,string>();
const runFile=promisify(execFile);
const sockets = new Map<string, WebSocket>();
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  if (!address || typeof address==='string') throw Error('No local tunnel port');
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  return address.port;
}
async function listening(port:number): Promise<boolean> {
  return new Promise(resolve=>{
    const socket=connectTcp(port,'127.0.0.1');
    const done=(ok:boolean)=>{socket.destroy();resolve(ok);};
    socket.setTimeout(150,()=>done(false));socket.once('error',()=>done(false));socket.once('connect',()=>done(true));
  });
}
async function ensureTunnel(target:string,port:number):Promise<number> {
  const key=`${target}:${port}`;
  const previous=tunnels.get(key);if(previous)return previous.pending;
  const entry:Tunnel={child:null,pending:Promise.resolve(0)};
  tunnels.set(key,entry);
  entry.pending=(async()=>{
    const result=await runFile('ssh',['-G',target],{timeout:5000,maxBuffer:256*1024});
    assertSafeSshConfig(result.stdout);
    const localPort=await freePort();
    const process=spawn('ssh',['-N','-T',...SSH_OPTIONS,'-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8',
      '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','ControlMaster=no','-o','ControlPath=none',
      '-L',`127.0.0.1:${localPort}:127.0.0.1:${port}`,target],{stdio:['ignore','ignore','pipe']});
    entry.child=process;
    let failed=false;
    process.once('error',()=>{failed=true;});
    process.once('exit',()=>{failed=true;if(tunnels.get(key)===entry){tunnels.delete(key);for(const [id,s]of sockets)if(socketDestinations.get(id)===key)s.close(4001,'SSH disconnected');}});
    // Drain SSH diagnostics; never include command output or credentials in browser errors.
    process.stderr?.resume();
    const deadline=Date.now()+10000;
    while(Date.now()<deadline && !failed){
      if(await listening(localPort)) return localPort;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    process.kill('SIGTERM');throw Error('SSH connection unavailable; check the selected bridge machine');
  })().catch(e=>{if(tunnels.get(key)===entry)tunnels.delete(key);throw e;});
  return entry.pending;
}
function validPath(path:string):boolean {
  return path.startsWith('/api/v1/') && !/[\\\r\n#]/.test(path) && !/%2f|%5c|%2e/i.test(path)
    && !path.split('?')[0].split('/').some(s=>s==='.'||s==='..');
}

export default experimental_defineHostEntry({
  contract:hostContract,
  experimental_signals:hostSignals,
  handlers:{
    async handoffUpload(input,context){
      const payload=handoffHostPayload(input);
      const port=await ensureTunnel(input.sshTarget,input.port);
      return uploadHandoffFile(port,payload,AbortSignal.any([context.signal,context.lifecycle.signal,AbortSignal.timeout(20000)]));
    },
    async imageUpload(input,context){
      const port=await ensureTunnel(input.sshTarget,input.port);
      return uploadImage(port,input,AbortSignal.any([context.signal,context.lifecycle.signal,AbortSignal.timeout(20000)]));
    },
    async request(input,context){
      if(!validPath(input.path)) throw Error('Invalid upstream path');
      const port=await ensureTunnel(input.sshTarget,input.port);
      const response=await fetch(`http://127.0.0.1:${port}${input.path}`,{
        method:input.method,redirect:'error',
        headers:input.body===null?{}:{'content-type':'application/json'},
        body:input.body??undefined,
        signal:AbortSignal.any([context.signal,context.lifecycle.signal,AbortSignal.timeout(20000)]),
      });
      const chunks:Uint8Array[]=[];let size=0;
      if(response.body){
        const reader=response.body.getReader();
        for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;
          if(size>4*1024*1024){await reader.cancel();throw Error('Pilot response limit is 4 MiB');}chunks.push(part.value);}
      }
      return {status:response.status,contentType:response.headers.get('content-type')??'application/octet-stream',bodyBase64:Buffer.concat(chunks).toString('base64')};
    },
    async connect(input,context){
      if(sockets.has(input.id)) throw Error('Duplicate connection');
      const port=await ensureTunnel(input.sshTarget,input.port);
      const lease=context.experimental_retainWorker();
      const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);
      sockets.set(input.id,ws);socketDestinations.set(input.id,`${input.sshTarget}:${input.port}`);
      const close=()=>{try{ws.close(1000,'Plugin lifecycle ended');}catch{}};
      context.lifecycle.signal.addEventListener('abort',close,{once:true});
      ws.addEventListener('message',e=>{
        const data=String(e.data);
        if(data.length<=65536) void context.experimental_emitSignal('frame',{id:input.id,data}).catch(()=>{});
      });
      ws.addEventListener('close',()=>{
        sockets.delete(input.id);socketDestinations.delete(input.id);lease.dispose();context.lifecycle.signal.removeEventListener('abort',close);
        void context.experimental_emitSignal('closed',{id:input.id}).catch(()=>{});
      },{once:true});
      try{
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>{close();reject(Error('Upstream socket timed out'));},10000);
          ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
          ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Upstream socket unavailable'));},{once:true});
          ws.addEventListener('close',()=>{clearTimeout(timer);reject(Error('Upstream socket closed'));},{once:true});
        });
        return {id:input.id};
      }catch(e){close();throw e;}
    },
    async send({id,data}){const ws=sockets.get(id);if(!ws||ws.readyState!==1)return {ok:false};ws.send(data);return {ok:true};},
    async disconnect({id}){sockets.get(id)?.close(1000,'Client closed');return {ok:true};},
  },
  async dispose(){for(const socket of sockets.values())socket.close();sockets.clear();for(const entry of tunnels.values())entry.child?.kill('SIGTERM');tunnels.clear();socketDestinations.clear();},
});
