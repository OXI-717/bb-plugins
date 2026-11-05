import { defineCli,cliCommand,type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { contract,resolveRoute } from './contract.js';
export default function plugin(bb:BbPluginApi){
 const settings=bb.settings.define({routes:{type:'string',label:'Project vault routes (JSON)',default:'[]',experimental_multiline:true}});
 const host=bb.hosts.experimental_client({contract});
 const routeFor=async(projectId:string)=>resolveRoute(JSON.parse((await settings.get()).routes),projectId);
 async function store(title:string,username:string,ctx:{threadId:string;projectId:string;signal?:AbortSignal}){
  const route=await routeFor(ctx.projectId);
  const result=await bb.ui.requestInput({threadId:ctx.threadId,rendererId:'credential',title:'Save credential to 1Password',payload:{mode:'store',title,username,hostId:route.hostId,vaultId:route.vaultId},describeSubmission:()=>({title:'Credential submitted (value omitted)'})},{signal:ctx.signal});
  if(result.outcome!=='submitted')return 'Cancelled; no credential stored';
  const value=z.object({password:z.string().min(1).max(16000)}).strict().parse(result.value);
  return JSON.stringify(await host.call('store',{route,title,username,password:value.password},{hostId:route.hostId,signal:ctx.signal}));
 }
 bb.agents.registerTool({name:'oxi_op_store',description:'Request a credential in a private BB form and save it to the current project vault. Passwords must never be supplied in tool arguments.',parameters:z.object({title:z.string().min(1).max(160),username:z.string().max(200).default('')}),execute:({title,username},ctx)=>store(title,username,ctx)});
 bb.agents.registerTool({name:'oxi_op_run',description:'Run an owner-configured operation using current project secrets. Only a completion result is returned; command output and secret values are suppressed.',parameters:z.object({operation:z.string().min(1)}),async execute({operation},ctx){
  const route=await routeFor(ctx.projectId);if(!route.operations.some(x=>x.name===operation))throw new Error('Operation is not configured');
  if(route.requireApproval){const result=await bb.ui.requestInput({threadId:ctx.threadId,rendererId:'credential',title:'Approve credential use',payload:{mode:'approve',title:operation,hostId:route.hostId,vaultId:route.vaultId},describeSubmission:()=>({title:'Credential use approved'})},{signal:ctx.signal});if(result.outcome!=='submitted'||z.object({approved:z.literal(true)}).safeParse(result.value).success===false)return 'Cancelled';}
  return JSON.stringify(await host.call('run',{route,operation},{hostId:route.hostId,signal:ctx.signal}));
 }});
 bb.cli.register(defineCli({name:'oxi-op',summary:'Project-scoped 1Password operations',commands:{
  status:cliCommand({summary:'Check the current project route without reading credentials',async run(_input,ctx){if(!ctx.projectId)throw new Error('Run in a BB project');const route=await routeFor(ctx.projectId);return {exitCode:0,stdout:JSON.stringify({configured:true,hostId:route.hostId,vaultId:route.vaultId,requireApproval:route.requireApproval,operations:route.operations.map(x=>x.name)})};}}),
  store:cliCommand({summary:'Open a private credential form',positionals:[{name:'title',description:'Item title',required:true}],options:{username:{type:'string',description:'Account name',default:''}},async run(input,ctx){if(!ctx.threadId||!ctx.projectId)throw new Error('Run from a BB thread');return {exitCode:0,stdout:await store(input.positionals.title,input.options.username,{threadId:ctx.threadId,projectId:ctx.projectId,signal:ctx.signal})};}})
 }}));
}
