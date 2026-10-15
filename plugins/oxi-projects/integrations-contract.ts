import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';
export const integrationSchema=z.object({memory:z.boolean(),autopilot:z.boolean(),tasknotes:z.boolean()}).strict();
export const integrationContract=defineRpcContract({
 integrationStatus:{input:z.null(),output:integrationSchema},
 saveIntegrations:{input:integrationSchema,output:integrationSchema}
});
export type IntegrationName='memory'|'autopilot'|'tasknotes';
