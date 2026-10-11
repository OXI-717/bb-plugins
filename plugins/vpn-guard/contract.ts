import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const hostContract = defineRpcContract({
  readState: { input: z.null(), output: z.object({ state: z.enum(['connected','disconnected','unknown']) }) },
});
export const modeSchema = z.enum(['observe','enforce']);
export const statusSchema = z.object({
  mode: modeSchema,
  hosts: z.array(z.object({ id:z.string(), name:z.string(), vpn:z.enum(['connected','disconnected','unknown']) })),
  protectedProviders: z.array(z.string()),
  ownedDisabledProviders: z.array(z.string()),
  stoppedThreadIds: z.array(z.string()),
  limitations: z.array(z.string()),
});
export const rpcContract = defineRpcContract({
  status: {input:z.null(),output:statusSchema},
  setMode: {input:z.object({mode:modeSchema}),output:statusSchema},
});
