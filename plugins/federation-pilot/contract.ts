import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {IMAGE_MAX_BYTES, IMAGE_MAX_BASE64, IMAGE_MIMES, isImagePath} from './image-format.ts';
import {handoffUploadSchema} from './handoff-contract.ts';

export const imageUploadSchema = z.object({
  projectId: z.string().regex(/^proj_[a-z0-9]+$/),
  filename: z.string().min(1).max(255),
  mimeType: z.enum(IMAGE_MIMES),
  // Avoid repeated capture groups: multi-megabyte input can exhaust V8's stack.
  // Canonical padding bits are checked by decode/re-encode before transmission.
  bytesBase64: z.string().min(4).max(IMAGE_MAX_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0),
}).strict();
export const uploadedImageSchema = z.object({
  type: z.literal('localImage'), path: z.string().refine(isImagePath),
  sourceProjectId: z.string().regex(/^proj_[a-z0-9]+$/).optional(),
  name: z.string().min(1).max(255), mimeType: z.enum(IMAGE_MIMES),
  sizeBytes: z.number().int().min(1).max(IMAGE_MAX_BYTES),
}).strict();

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
  handoffUpload: {
    input: handoffUploadSchema.extend(destination),
    output: z.object({status:z.number().int(), contentType:z.string(), bodyBase64:z.string()}),
  },
  imageUpload: {
    input: imageUploadSchema.extend(destination),
    output: z.object({status:z.number().int(), contentType:z.string(), bodyBase64:z.string()}),
  },
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
