// Public wire contract shared with oxi-projects. No credentials or filesystem paths.
import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';
const projectId=z.string().min(1).max(200);
const code=z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
export const bindingSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('project'),code}),
 z.object({mode:z.enum(['unselected','not-applicable','ambiguous']),code:z.null()}),
]);
export const memoryStateSchema=z.object({
 projectId,
 binding:bindingSchema,
 mappingRevision:z.string(),catalogRevision:z.string(),
 catalog:z.array(z.object({code,label:z.string()})),
 catalogAvailable:z.boolean(),
 status:z.enum(['unselected','not-applicable','ambiguous','linked','missing-catalog','invalid-mapping','catalog-unavailable']),
 access:z.enum(['not-checked','available','denied','unavailable','timeout']),
 read:z.boolean(),add:z.boolean(),automatic:z.boolean(),
});
export const memoryContract=defineRpcContract({
 memoryInspect:{input:z.object({projectId}),output:memoryStateSchema},
 memorySave:{input:z.object({projectId,binding:bindingSchema,mappingRevision:z.string(),catalogRevision:z.string()}),output:z.object({ok:z.boolean(),reason:z.enum(['saved','conflict','catalog-unavailable','invalid-code','invalid-mapping','project-missing','save-failed'])})},
});
