import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {automationInputSchema,automationStatusSchema} from './automation-contract.js';

export const evidenceSchema=z.object({state:z.enum(['connected','disconnected','unknown']),assurance:z.enum(['verified_ipv4','unverified','invalid']),reason:z.string(),updatedAt:z.number().nullable(),probeAt:z.number().nullable()});
export const hostContract = defineRpcContract({
  automation: {input:automationInputSchema,output:automationStatusSchema},
  readState: { input: z.null(), output: z.object({ state: z.enum(['connected','disconnected','unknown']),evidence:evidenceSchema.optional() }) },
});
export const modeSchema = z.enum(['observe','enforce']);
export const stopReasonSchema=z.enum(['manual_block','host_rpc_failed','host_catalog_unavailable','no_route','no_core','probe_failed','probe_stale','healing','invalid_evidence','file_stale_or_schema','probe_unverified']);
export const stopObservationSchema=z.object({threadId:z.string().max(160),hostId:z.string().max(160),at:z.number().int().nonnegative(),reason:stopReasonSchema});
export const configurationSchema = z.object({
  mode: modeSchema,
  manualBlock: z.boolean().default(false),
  hostIds: z.array(z.string().min(1)).max(256),
  suspendNativePluginsGlobally: z.boolean(),
  coordinateAutomations:z.boolean().default(false),
  automationControllerPath:z.string().max(1024).nullable().default(null),
}).strip();
export const statusSchema = z.object({
  mode: modeSchema,
  manualBlock: z.boolean(),
  serverHostId:z.string().nullable(),
  hostIds: z.array(z.string()),
  suspendNativePluginsGlobally: z.boolean(),
  coordinateAutomations:z.boolean().default(false),
  automationControllerPath:z.string().max(1024).nullable().default(null),
  hosts: z.array(z.object({
    id:z.string(), name:z.string(), selected:z.boolean(), available:z.boolean(),
    vpn:z.enum(['connected','disconnected','unknown']).nullable(),evidence:evidenceSchema.nullable().optional(),
  })),
  protectedProviders: z.array(z.string()),
  ownedDisabledPlugins: z.array(z.string()),
  ambiguousPluginChanges: z.array(z.string()),
  stoppedThreadIds: z.array(z.string()),
  stopHistory:z.array(stopObservationSchema).max(100).optional(),
  limitations: z.array(z.string()),
  automations:z.object({status:automationStatusSchema.nullable(),error:z.string().nullable(),held:z.boolean(),needsReconcile:z.boolean()}),
  pool:z.object({linked:z.boolean().nullable(),vpnPolicyVersion:z.literal(2).nullable(),error:z.string().nullable()}),
});
export const rpcContract = defineRpcContract({
  automationIdentity:{input:z.null(),output:z.object({instanceId:z.string()})},
  setAutomationCoordination:{input:z.object({enabled:z.boolean(),executable:z.string().nullable()}),output:statusSchema},
  automationAction:{input:z.object({action:z.enum(["pause","resume"]),reviewed:z.boolean().default(false),restoreRevision:z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null)}),output:statusSchema},
  networkDecision: {input:z.object({hostId:z.string().min(1),provider:z.enum(['codex','claude','cursor','devin'])}).strict(),output:z.object({schema:z.literal('bb-vpn-guard/network-decision/1'),allowed:z.boolean(),reason:z.enum(['manual_block','vpn_unavailable','outside_scope','observe','connected','restore_required'])}).strict()},
  status: {input:z.null(),output:statusSchema},
  setManualBlock: {input:z.object({blocked:z.boolean()}),output:statusSchema},
  setMode: {input:z.object({mode:modeSchema}),output:statusSchema},
  setHosts: {input:z.object({hostIds:z.array(z.string().min(1)).max(256)}),output:statusSchema},
  setGlobalSuspension: {input:z.object({enabled:z.boolean(),acknowledgeGlobalImpact:z.boolean()}),output:statusSchema},
  restoreOwned: {input:z.null(),output:statusSchema},
  acknowledgeAmbiguous: {input:z.object({pluginId:z.string(),acknowledgeReviewed:z.boolean()}),output:statusSchema},
});
