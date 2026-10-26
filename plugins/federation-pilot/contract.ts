import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const destination = {
  sshTarget: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,160}$/),
  port: z.number().int().min(1).max(65535),
};
const id = z.string().uuid();
export const requestSchema = z.object({
  method: z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE']),
  path: z.string().min(1).max(8192),
  body: z.string().max(3 * 1024 * 1024).nullable().default(null),
}).strict();
export const hostContract = defineRpcContract({
  request: {
    input: requestSchema.extend(destination),
    output: z.object({status:z.number().int(), contentType:z.string(), bodyBase64:z.string()}),
  },
  connect: {input:z.object({...destination,id}),output:z.object({id})},
  send: {input:z.object({id,data:z.string().max(65536)}),output:z.object({ok:z.boolean()})},
  disconnect: {input:z.object({id}),output:z.object({ok:z.boolean()})},
});
export const hostSignals = {
  frame: {payload:z.object({id,data:z.string().max(65536)})},
  closed: {payload:z.object({id})},
};
