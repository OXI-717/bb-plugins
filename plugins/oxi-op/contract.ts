import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const operationSchema = z.object({ name: z.string().min(1), argv: z.array(z.string()).min(1).max(100), references: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().startsWith('op://')) }).strict();
export const routeSchema = z.object({
    projectId: z.string().min(1),
    profile: z.string().min(1).max(80).default('default'),
    label: z.string().min(1).max(160).optional(),
    hostId: z.string().min(1),
    vaultId: z.string().min(1),
    opBinary: z.string().min(1).default('op'),
    authentication: z.enum(['desktop', 'service-account']).default('service-account'),
    accountId: z.string().min(1).optional(),
    tokenEnvironment: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    tokenSetting: z.literal('serviceAccountToken').optional(),
    requireApproval: z.boolean().default(true),
    operations: z.array(operationSchema).default([]),
}).strict().refine(x => x.authentication === 'desktop'
    ? !!x.accountId && !x.tokenEnvironment && !x.tokenSetting
    : (!!x.tokenEnvironment !== !!x.tokenSetting) && !x.accountId,
    'Configure one explicit op authentication mode');
export type Route = z.infer<typeof routeSchema>;
export function resolveRoute(routes: unknown, projectId: string, profile = 'default') {
    const matches = z.array(routeSchema).parse(routes).filter(x => x.projectId === projectId && x.profile === profile);
    if (matches.length !== 1) throw new Error('Configure exactly one route for this BB project and access profile');
    return matches[0];
}
export const contract = defineRpcContract({
    verify: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional() }).strict(), output: z.object({ verified: z.literal(true), cleaned: z.literal(true) }) },
    check: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional() }).strict(), output: z.object({ authorized: z.literal(true) }) },
    store: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional(), title: z.string().min(1).max(160), username: z.string().max(200), password: z.string().min(1).max(16000) }).strict(), output: z.object({ itemId: z.string(), verified: z.literal(true) }) },
    run: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional(), operation: z.string() }).strict(), output: z.object({ completed: z.literal(true) }) },
});
