import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import {access} from 'node:fs/promises';
import {homedir,platform} from 'node:os';
import path from 'node:path';
import {providerSchema} from './contracts.js';
import {openAccountBrowser,listBrowserProfiles,resolveAccount,safeBrowserUrl,type BrowserProfileInfo} from './browser-profiles.js';
import {readVpnEvidence} from './vpn-policy.js';

const accountSchema=z.object({id:z.string().uuid(),provider:providerSchema,label:z.string().min(1).max(512),email:z.string().email().max(512).nullable()}).strict();
export type BrowserAccount=z.infer<typeof accountSchema>;
const accountsSchema=z.array(accountSchema).max(256).refine(a=>new Set(a.map(x=>x.id)).size===a.length);
const urlSchema=z.string().max(8192).refine(s=>{try{safeBrowserUrl(s);return true;}catch{return false;}});
const openInput=z.object({accounts:accountsSchema,accountId:z.string().uuid(),url:urlSchema.optional()}).strict();
const listInput=z.object({accounts:accountsSchema}).strict();
const rowSchema=z.object({accountId:z.string(),provider:z.string(),label:z.string(),email:z.string().nullable(),profileName:z.string(),profileDirectory:z.string(),profileDir:z.string(),exists:z.boolean(),updatedAt:z.number().nullable()}).strict();
export const browserHostContract=defineRpcContract({
 open:{input:openInput,output:z.object({opened:z.literal(true)}).strict()},
 list:{input:listInput,output:z.array(rowSchema).max(256)},
});
type OpenInput=z.infer<typeof openInput>;
export interface BrowserRouterOptions {
 getHostId:()=>string|null;
 listHosts:()=>Promise<readonly {id:string,status:string}[]>;
 accounts:()=>Promise<readonly BrowserAccount[]>;
 callHost:(method:'open'|'list',input:OpenInput|z.infer<typeof listInput>,hostId:string)=>Promise<unknown>;
 localOpen:(query:string,url?:string)=>Promise<unknown>;
 localList:()=>Promise<BrowserProfileInfo[]>;
}
export function createBrowserRouter(options:BrowserRouterOptions){
 const inventory=async()=>accountsSchema.parse((await options.accounts()).map(({id,provider,label,email})=>({id,provider,label,email})));
 async function target(id:string){
  if(!(await options.listHosts()).some(h=>h.id===id&&h.status==='connected'))throw Error('Account browser host is unavailable; no local fallback.');
  if(options.getHostId()!==id)throw Error('Account browser host changed; retry after checking configuration.');
 }
 return {
  async open(query:string,url?:string):Promise<{opened:true}>{
   const id=options.getHostId();
   if(id===null){await options.localOpen(query,url);return {opened:true};}
   const accounts=await inventory();const account=resolveAccount(accounts,query);
   const input=openInput.parse({accounts,accountId:account.id,...(url===undefined?{}:{url})});
   await target(id);
   try{return browserHostContract.open.output.parse(await options.callHost('open',input,id));}
   catch{throw Error('Remote account browser did not confirm launch. Check the Mac before retrying.');}
  },
  async list():Promise<BrowserProfileInfo[]>{
   const id=options.getHostId();if(id===null)return options.localList();
   const input={accounts:await inventory()};await target(id);
   try{return browserHostContract.list.output.parse(await options.callHost('list',input,id));}
   catch{throw Error('Remote account browser inventory is unavailable.');}
  },
 };
}
// Remote mode deliberately reuses the retained Mac registry. Never rebuild it from
// server-side rows: that could point existing accounts at new, empty profiles.
export function createMacBrowserHandlers(deps:{
 platform:()=>string;dataDir:()=>string;
 registryExists:(dir:string)=>Promise<boolean>;
 readEvidence:()=>Promise<{state:string,assurance:string}>;
 open:(options:Parameters<typeof openAccountBrowser>[0])=>Promise<unknown>;
 list:(options:Parameters<typeof listBrowserProfiles>[0])=>Promise<BrowserProfileInfo[]>;
}={
 platform,dataDir:()=>path.join(homedir(),'.bb'),
 registryExists:async dir=>{try{await access(path.join(dir,'plugins','account-pool-balanced','browser-profiles','registry.json'));return true;}catch{return false;}},
 readEvidence:()=>readVpnEvidence(path.join(homedir(),'.local','state','vpnks','vpn-state.json'),Date.now()),
 open:openAccountBrowser,list:listBrowserProfiles,
}){
 async function local(){
  if(deps.platform()!=='darwin')throw Error('Remote account browser requires the selected Mac host.');
  const dir=deps.dataDir();
  if(!await deps.registryExists(dir))throw Error('Retained Mac account browser registry is missing; prepare it before server migration.');
  return dir;
 }
 return {
  async open(raw:OpenInput,signal?:AbortSignal):Promise<{opened:true}>{
   signal?.throwIfAborted();
   const input=openInput.parse(raw);resolveAccount(input.accounts,input.accountId);
   const dataDir=await local();const evidence=await deps.readEvidence();
   if(evidence.state!=='connected'||evidence.assurance!=='verified_ipv4')throw Error('Verified Mac VPN is required for the shared account browser.');
   signal?.throwIfAborted();
   await deps.open({accounts:input.accounts,query:input.accountId,url:input.url,dataDir,pluginId:'account-pool-balanced'});
   return {opened:true};
  },
  async list(raw:z.infer<typeof listInput>){
   const input=listInput.parse(raw);const dataDir=await local();
   return deps.list({accounts:input.accounts,dataDir,pluginId:'account-pool-balanced'});
  },
 };
}
