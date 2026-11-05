import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const operationSchema=z.object({name:z.string().min(1),argv:z.array(z.string()).min(1).max(100),references:z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/),z.string().startsWith('op://'))}).strict();
export const routeSchema=z.object({projectId:z.string().min(1),hostId:z.string().min(1),vaultId:z.string().min(1),keychainAccount:z.string().min(1).optional(),tokenEnvironment:z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),requireApproval:z.boolean().default(true),operations:z.array(operationSchema).default([])}).strict().refine(x=>Number(!!x.keychainAccount)+Number(!!x.tokenEnvironment)===1,'Choose exactly one host credential source');
export type Route=z.infer<typeof routeSchema>;
export function resolveRoute(routes:unknown,projectId:string){const matches=z.array(routeSchema).parse(routes).filter(x=>x.projectId===projectId);if(matches.length!==1)throw new Error('Configure exactly one route for this BB project');return matches[0];}
export const contract=defineRpcContract({
 store:{input:z.object({route:routeSchema,title:z.string().min(1).max(160),username:z.string().max(200),password:z.string().min(1).max(16000)}).strict(),output:z.object({itemId:z.string(),verified:z.literal(true)})},
 run:{input:z.object({route:routeSchema,operation:z.string()}).strict(),output:z.object({completed:z.literal(true)})},
});
