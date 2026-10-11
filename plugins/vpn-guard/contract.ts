import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const hostContract = defineRpcContract({
  readState: { input: z.null(), output: z.object({ state: z.enum(['connected','disconnected','unknown']) }) },
});
export const modeSchema = z.enum(['observe','enforce']);
export const configurationSchema = z.object({
  mode: modeSchema,
  hostIds: z.array(z.string().min(1)).max(256),
  suspendNativePluginsGlobally: z.boolean(),
}).strict();
export const statusSchema = z.object({
  mode: modeSchema,
  hostIds: z.array(z.string()),
  suspendNativePluginsGlobally: z.boolean(),
  hosts: z.array(z.object({
    id:z.string(), name:z.string(), selected:z.boolean(), available:z.boolean(),
    vpn:z.enum(['connected','disconnected','unknown']).nullable(),
  })),
  protectedProviders: z.array(z.string()),
  ownedDisabledPlugins: z.array(z.string()),
  ambiguousPluginChanges: z.array(z.string()),
  stoppedThreadIds: z.array(z.string()),
  limitations: z.array(z.string()),
});
export const rpcContract = defineRpcContract({
  status: {input:z.null(),output:statusSchema},
  setMode: {input:z.object({mode:modeSchema}),output:statusSchema},
  setHosts: {input:z.object({hostIds:z.array(z.string().min(1)).max(256)}),output:statusSchema},
  setGlobalSuspension: {input:z.object({enabled:z.boolean(),acknowledgeGlobalImpact:z.boolean()}),output:statusSchema},
  restoreOwned: {input:z.null(),output:statusSchema},
  acknowledgeAmbiguous: {input:z.object({pluginId:z.string(),acknowledgeReviewed:z.boolean()}),output:statusSchema},
});
