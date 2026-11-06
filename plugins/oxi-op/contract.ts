import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const operationSchema = z.object({ name: z.string().min(1), label: z.string().min(1).max(160).optional(), purpose: z.string().min(1).max(500).optional(), argv: z.array(z.string()).min(1).max(100), references: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().startsWith('op://')), referenceLabels: z.record(z.string(), z.object({item: z.string().min(1).max(160), field: z.string().min(1).max(160)}).strict()).optional() }).strict();
export const routeSchema = z.object({
    projectId: z.string().min(1),
    profile: z.string().min(1).max(80).default('default'),
    label: z.string().min(1).max(160).optional(),
    hostId: z.string().min(1),
    credentialHostId: z.string().min(1).optional(),
    hostLabel: z.string().min(1).max(160).optional(),
    vaultId: z.string().min(1),
    vaultLabel: z.string().min(1).max(160).optional(),
    opBinary: z.string().min(1).default('op'),
    authentication: z.enum(['desktop', 'service-account']).default('service-account'),
    accountId: z.string().min(1).optional(),
    tokenEnvironment: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    tokenSetting: z.enum(['serviceAccountToken', 'projectServiceAccounts']).optional(),
    requireApproval: z.boolean().default(true),
    operations: z.array(operationSchema).default([]),
}).strict().refine(x => x.authentication === 'desktop'
    ? !!x.accountId && !x.tokenEnvironment && !x.tokenSetting && (!x.credentialHostId || x.requireApproval)
    : (!!x.tokenEnvironment !== !!x.tokenSetting) && !x.accountId && !x.credentialHostId,
    'Configure one explicit op authentication mode');
export type Route = z.infer<typeof routeSchema>;
export function resolveRoute(routes: unknown, projectId: string, profile = 'default') {
    const matches = z.array(routeSchema).parse(routes).filter(x => x.projectId === projectId && x.profile === profile);
    if (matches.length !== 1) {
        const profiles = [...new Set(z.array(routeSchema).parse(routes).filter(x => x.projectId === projectId).map(x => x.profile))].slice(0, 12);
        throw new Error('1Password access needs exactly one route for this BB project and profile. Configured profiles for this project: ' + JSON.stringify(profiles) + '. Select an existing profile explicitly, or ask the owner to connect this project in Oxi Op settings. No credential was requested or read. Do not use macOS Keychain, another project route, chat, or command arguments as a fallback for passwords.');
    }
    return matches[0];
}
export const contract = defineRpcContract({
    provisionVault: {input: z.object({route: routeSchema, projectId: z.string().min(1), name: z.string().min(1).max(160)}).strict(), output: z.object({vaultId: z.string(), name: z.string()}).strict()},
    resolve: {input: z.object({route: routeSchema, operation: z.string()}).strict(), output: z.object({bindings: z.record(z.string(), z.string())}).strict()},
    execute: {input: z.object({route: routeSchema, operation: z.string(), bindings: z.record(z.string(), z.string())}).strict(), output: z.object({completed: z.literal(true)}).strict()},
    inventory: { input: z.object({route: routeSchema, registryTitle: z.string().min(1)}).strict(), output: z.object({vaults: z.array(z.object({id: z.string(), name: z.string()}))}) },
    verify: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional() }).strict(), output: z.object({ verified: z.literal(true), cleaned: z.literal(true) }) },
    check: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional() }).strict(), output: z.object({ authorized: z.literal(true) }) },
    store: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional(), title: z.string().min(1).max(160), username: z.string().max(200), password: z.string().min(1).max(16000) }).strict(), output: z.object({ itemId: z.string(), verified: z.literal(true) }) },
    run: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional(), operation: z.string() }).strict(), output: z.object({ completed: z.literal(true) }) },
});
