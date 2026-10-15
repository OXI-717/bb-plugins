import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';
export const notesConnection=z.object({id:z.string().min(1),label:z.string().min(1),kind:z.literal('tasknotes'),hostId:z.string().min(1),vaultPath:z.string().min(1),executable:z.string().startsWith('/'),projectName:z.string().regex(/^[^/\\]+$/).refine(s=>!s.includes('..')),folders:z.array(z.string()).default([]),tags:z.array(z.string()).default([])});
export const note=z.object({path:z.string().min(1),title:z.string(),status:z.string(),priority:z.string().nullable().optional(),tags:z.array(z.string()).default([]),archived:z.boolean().default(false),details:z.string().default(''),dateModified:z.string().default('')});
export const notesHostContract=defineRpcContract({list:{input:notesConnection,output:z.array(note)},read:{input:z.object({connection:notesConnection,path:z.string().min(1)}),output:note}});
export const notesContract=defineRpcContract({notesList:{input:z.object({projectId:z.string(),connectionId:z.string()}),output:z.array(note)},notesRead:{input:z.object({projectId:z.string(),connectionId:z.string(),path:z.string().min(1)}),output:note}});
