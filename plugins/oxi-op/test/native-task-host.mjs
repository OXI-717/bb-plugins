/** Auth-free integration driver: actual RPC handlers; only transport/host config are synthetic. */
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import ts from 'typescript';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import plugin from '../dist/test/server.js';
import hostEntry from '../dist/test/host.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function poolModules(){
 const temp=await mkdtemp(join(root,'dist','task-harness-'));
 for(const name of ['native-sessions','native-probe-wire','native-accounts','native-unlock-rpc','contracts','project-policy']){
  const directory=name!=='native-unlock-rpc'?(process.env.OXI_TEST_POOL_SOURCE??join(root,'../account-pool-balanced/src')):join(root,'../account-pool-balanced/src');
  const source=await readFile(join(directory,name+'.ts'),'utf8');
  await writeFile(join(temp,name+'.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 }
 return {...await import(pathToFileURL(join(temp,'native-sessions.js'))),...await import(pathToFileURL(join(temp,'native-unlock-rpc.js'))),cleanup:()=>rm(temp,{recursive:true})};
}
export async function system(route,token,options={}){
 const modules=await poolModules();let op;
 const pool=createFakePluginHost({pluginId:'account-pool-balanced'});
 const sessions=new modules.NativeSessions(pool.bb.storage.kv,Date.now,options.admit??(async()=>{}),()=>{},async(requestId,signal)=>{
  const value=await op.harness.behavior.callRpc('runPreparedTask',{requestId},{experimental_caller:{kind:'plugin',pluginId:'account-pool-balanced'},signal});
  if(value.completed!==true)throw Error('Unconfirmed operation');
 });
 await sessions.initialize();modules.registerNativeUnlockRpc(pool.bb,sessions);
 op=createFakePluginHost({pluginId:'oxi-op',settings:{routes:JSON.stringify([route]),projectServiceAccounts:JSON.stringify({[route.projectId]:{[route.profile]:token}})},
  sdk:{plugins:{callRpc:async({method,input,outputSchema,signal})=>outputSchema.parse(await pool.harness.behavior.callRpc(method,input,{experimental_caller:{kind:'plugin',pluginId:'oxi-op'},signal}))}},
  experimental_callHostRpc:async({method,input,hostId,signal})=>{
   if(hostId!==route.hostId)throw Error('Wrong host');
   if(options.host)return options.host(method,input,signal);
   return hostEntry.handlers[method](input,{signal});
  }});
 plugin(op.bb);
 return {sessions,pool,op,modules,async close(){await sessions.close();await op.harness.lifecycle.dispose();await pool.harness.lifecycle.dispose();await modules.cleanup();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const config=JSON.parse(await readFile(process.argv[2],'utf8'));
 const state=await system(config.route,'synthetic-operation-context');
 await state.sessions.configure(config.executor);await state.sessions.setManaged(true);
 const handler=async(req,res)=>{
  try{
   const body=[];for await(const part of req)body.push(part);
   const request=new Request('http://127.0.0.1'+req.url,{method:'POST',headers:req.headers,body:Buffer.concat(body)});
   const result=await state.modules.nativeHttp(request,state.sessions,async token=>token===config.bearer?config.caller:null);
   res.writeHead(result.status,{'content-type':'application/json'});res.end(await result.text());
  }catch{res.writeHead(400);res.end('{}');}
 };
 const server=config.tls?httpsServer({key:await readFile(config.tls.key),cert:await readFile(config.tls.cert)},handler):httpServer(handler);
 server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
 let closing=false;
 async function close(){if(closing)return;closing=true;await state.close();server.close();process.exit(0);}
 process.stdin.resume();process.stdin.on('end',close);process.on('SIGTERM',close);process.on('SIGINT',close);
}
