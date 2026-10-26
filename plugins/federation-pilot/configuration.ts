import {z} from 'zod';
export const serverSchema=z.object({
 serverId:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),label:z.string().min(1).max(80),
 projectId:z.string().regex(/^proj_[a-z0-9]+$/).refine(v=>v!=='proj_personal'),
 bridgeHostId:z.string().regex(/^host_[a-z0-9]+$/),sshTarget:z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,160}$/),
 remotePort:z.number().int().min(1).max(65535).default(38886),allowWrites:z.boolean().default(false),enabled:z.boolean().default(true),
}).strict();
export type RemoteConfig=z.infer<typeof serverSchema>;
export function parseServers(raw:string,legacy:any):RemoteConfig[]{
 const input=raw.trim()?JSON.parse(raw):legacy.projectId?[{serverId:'default',label:legacy.label,projectId:legacy.projectId,bridgeHostId:legacy.bridgeHostId,sshTarget:legacy.sshTarget,remotePort:legacy.remotePort,allowWrites:legacy.allowWrites}]:[];
 const rows=z.array(serverSchema).max(8).parse(input);const ids=new Set(),projects=new Set();
 for(const row of rows){if(ids.has(row.serverId)||projects.has(row.projectId))throw Error('Duplicate server or project ID');ids.add(row.serverId);projects.add(row.projectId);}
 return rows.filter(r=>r.enabled);
}
export const publicServer=(c:RemoteConfig)=>({serverId:c.serverId,label:c.label,projectId:c.projectId,allowWrites:c.allowWrites});
