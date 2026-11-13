import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const managementScopeSchema = z.enum(['read', 'manage']);
export const managementGrantSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scope: managementScopeSchema,
  expiresAt: z.number().int().positive(),
}).strict();
export type ManagementGrant = z.infer<typeof managementGrantSchema>;
export type ManagementScope = z.infer<typeof managementScopeSchema>;
export const managementUnlockSchema = z.object({
  key: z.string().min(1).max(256),
  scope: managementScopeSchema.default('manage'),
  ttlSeconds: z.number().int().min(1).max(900).default(900),
}).strict();
export const publicPoolStatusSchema = z.object({
  management: z.literal('locked'),
}).strict();
export const managementRpcContract = defineRpcContract({
  'management.unlock': { input: managementUnlockSchema, output: managementGrantSchema },
  'management.call': {
    input: z.object({ token: z.string().max(256), method: z.string().min(1).max(80), input: z.unknown() }).strict(),
    output: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ ok: z.literal(false), code: z.literal('pool-management-locked') }).strict(),
    ]),
  },
  'management.lock': { input: z.object({ token: z.string().max(256) }).strict(), output: z.null() },
  'public.status': { input: z.null(), output: publicPoolStatusSchema },
  'vpnPolicy.get': {
    input: z.null(),
    output: z.object({
      vpnGuardEnabled: z.boolean(),
      vpnPolicyVersion: z.number().int(),
      vpnOnlyProviders: z.array(z.string()),
    }).strict(),
  },
});
