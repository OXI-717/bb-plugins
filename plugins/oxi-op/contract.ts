import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {assignmentSchema} from './task-contract.js';
export const operationSchema = z.object({ name: z.string().min(1), label: z.string().min(1).max(160).optional(), purpose: z.string().min(1).max(500).optional(), argv: z.array(z.string()).min(1).max(100), references: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().startsWith('op://')), referenceLabels: z.record(z.string(), z.object({item: z.string().min(1).max(160), field: z.string().min(1).max(160)}).strict()).optional() }).strict();
const absolutePath = z.string().regex(/^\/[^\0]*$/);
export const keyReferenceSchema = z.object({item: z.string().min(1).max(160).regex(/^[^/\n]+$/), field: z.string().min(1).max(160).regex(/^[^/\n]+$/)}).strict();
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
    // Desktop approval may happen on whichever listed owner machine is connected, in this order.
    desktopHosts: z.array(z.object({hostId: z.string().min(1), opBinary: absolutePath}).strict()).min(1).max(4).optional(),
    // Service-account work runs on the requesting session's machine when it is listed here.
    sessionHosts: z.record(z.string().min(1), absolutePath).optional(),
    // Agents may run their own commands with keys from this vault, without a form.
    allowAgentCommands: z.boolean().default(false),
}).strict().refine(x => x.authentication === 'desktop'
    ? !!x.accountId && !x.tokenEnvironment && !x.tokenSetting && (!(x.credentialHostId || x.desktopHosts) || x.requireApproval) && !(x.credentialHostId && x.desktopHosts) && !x.sessionHosts && !x.allowAgentCommands
    : (!!x.tokenEnvironment !== !!x.tokenSetting) && !x.accountId && !x.credentialHostId && !x.desktopHosts && (!x.allowAgentCommands || !x.requireApproval),
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
    runPrepared: {input:z.object({route:routeSchema,serviceAccountToken:z.string(),assignment:assignmentSchema}).strict(),output:z.object({completed:z.literal(true)}).strict()},
    provisionVault: {input: z.object({route: routeSchema, projectId: z.string().min(1), name: z.string().min(1).max(160), existingVaultId: z.string().min(1).optional()}).strict(), output: z.object({vaultId: z.string(), name: z.string()}).strict()},
    issueServiceAccounts: {input: z.object({route: routeSchema, projectId: z.string().min(1), vaultName: z.string().min(1).max(160), backupVaultId: z.string().min(1), expiresIn: z.literal('90d'), accounts: z.array(z.object({profile: z.string().min(1).max(80), name: z.string().min(1).max(160), permissions: z.union([z.tuple([z.literal('read_items')]), z.tuple([z.literal('read_items'), z.literal('write_items')])])}).strict()).min(1).max(4)}).strict(), output: z.object({vaultId: z.string(), vaultName: z.string(), accounts: z.array(z.object({profile: z.string(), token: z.string().min(1), recovered: z.boolean()}).strict())}).strict()},
    describeScope: {input: z.object({opBinary: absolutePath, serviceAccountToken: z.string().min(1)}).strict(), output: z.object({vaults: z.array(z.object({id: z.string(), name: z.string()}).strict()).max(20)}).strict()},
    deleteSelftest: {input: z.object({route: routeSchema, serviceAccountToken: z.string().min(1), title: z.string().regex(/^OXI OP selftest [0-9a-f-]{36}$/)}).strict(), output: z.object({deleted: z.number().int()}).strict()},
    probeScope: {input: z.object({route: routeSchema, serviceAccountToken: z.string().min(1)}).strict(), output: z.object({vaultIds: z.array(z.string()), writable: z.boolean(), writeFailure: z.string().regex(/^[a-z0-9-]{1,40}$/).optional()}).strict()},
    listKeys: {input: z.object({route: routeSchema, serviceAccountToken: z.string().min(1)}).strict(), output: z.object({items: z.array(z.object({item: z.string(), fields: z.array(z.string())}).strict())}).strict()},
    exec: {input: z.object({route: routeSchema, serviceAccountToken: z.string().min(1), argv: z.array(z.string()).min(1).max(200), keys: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), keyReferenceSchema), cwd: absolutePath.optional(), timeoutSeconds: z.number().int().min(1).max(600)}).strict(), output: z.object({exitCode: z.number().int(), output: z.string(), truncated: z.boolean(), timedOut: z.boolean()}).strict()},
    resolve: {input: z.object({route: routeSchema, operation: z.string()}).strict(), output: z.object({bindings: z.record(z.string(), z.string())}).strict()},
    execute: {input: z.object({route: routeSchema, operation: z.string(), bindings: z.record(z.string(), z.string())}).strict(), output: z.object({completed: z.literal(true)}).strict()},
    inventory: { input: z.object({route: routeSchema, registryTitle: z.string().min(1)}).strict(), output: z.object({vaults: z.array(z.object({id: z.string(), name: z.string()}))}) },
    verify: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional() }).strict(), output: z.object({ verified: z.literal(true), cleaned: z.literal(true) }) },
    check: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional() }).strict(), output: z.object({ authorized: z.literal(true) }) },
    store: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional(), title: z.string().min(1).max(160), username: z.string().max(200), password: z.string().min(1).max(16000) }).strict(), output: z.object({ itemId: z.string(), verified: z.literal(true) }) },
    run: { input: z.object({ route: routeSchema, serviceAccountToken: z.string().optional(), operation: z.string() }).strict(), output: z.object({ completed: z.literal(true) }) },
});
