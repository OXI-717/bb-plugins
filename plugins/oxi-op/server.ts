import { defineCli, cliCommand, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { contract, resolveRoute } from './contract.js';
export default function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({ routes: { type: 'string', label: 'Project vault routes (JSON)', default: '[]', experimental_multiline: true }, serviceAccountToken: { type: 'string', label: 'Scoped service account token', secret: true, default: '' } });
    const host = bb.hosts.experimental_client({ contract });
    const accessFor = async (projectId: string, profile: string) => { const values = await settings.get(); const route = resolveRoute(JSON.parse(values.routes), projectId, profile); return { route, ...(route.tokenSetting ? { serviceAccountToken: values.serviceAccountToken } : {}) }; };
    async function store(title: string, username: string, profile: string, ctx: {
        threadId: string;
        projectId: string;
        signal?: AbortSignal;
    }) {
        const access = await accessFor(ctx.projectId, profile);
        const { route } = access;
        const result = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'credential', title: 'Сохранить пароль: ' + title, payload: { mode: 'store', title, username, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? ctx.projectId, hostId: route.hostId, hostLabel: route.hostLabel ?? route.hostId, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? route.vaultId, purpose: 'Создать запись и проверить сохранённый пароль', secrets: [{field: 'password', item: title}] }, describeSubmission: () => ({ title: 'Credential submitted (value omitted)' }) }, { signal: ctx.signal });
        if (result.outcome !== 'submitted')
            return 'Cancelled; no credential stored';
        const value = z.object({ password: z.string().min(1).max(16000) }).strict().parse(result.value);
        return JSON.stringify(await host.call('store', { ...access, title, username, password: value.password }, { hostId: route.hostId, signal: ctx.signal }));
    }
    const profileParameter = z.string().min(1).max(80).default('default');
    bb.agents.registerTool({ name: 'oxi_op_store', description: 'Request a credential in a private BB form and save it to the current project vault and configured access profile. Passwords must never be supplied in tool arguments.', parameters: z.object({ title: z.string().min(1).max(160), username: z.string().max(200).default(''), profile: profileParameter }).strict(), execute: ({ title, username, profile }, ctx) => store(title, username, profile, ctx) });
    bb.agents.registerTool({ name: 'oxi_op_run', description: 'Run an owner-configured operation using current project secrets. Only a completion result is returned; command output and secret values are suppressed.', parameters: z.object({ operation: z.string().min(1), profile: profileParameter }).strict(), async execute({ operation, profile }, ctx) {
            const access = await accessFor(ctx.projectId, profile);
            const { route } = access;
            const matches = route.operations.filter(x => x.name === operation);
            if (matches.length !== 1)
                throw new Error('Operation is not configured');
            const configured = matches[0];
            if (route.requireApproval) {
                const result = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'credential', title: 'Использовать секрет: ' + operation, payload: { mode: 'approve', title: operation, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? ctx.projectId, hostId: route.hostId, hostLabel: route.hostLabel ?? route.hostId, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? route.vaultId, purpose: configured.purpose ?? configured.name, secrets: Object.entries(configured.references).map(([variable, reference]) => ({variable, reference})) }, describeSubmission: () => ({ title: 'Credential use approved' }) }, { signal: ctx.signal });
                if (result.outcome !== 'submitted' || z.object({ approved: z.literal(true) }).strict().safeParse(result.value).success === false)
                    return 'Cancelled';
            }
            return JSON.stringify(await host.call('run', { ...access, operation }, { hostId: route.hostId, signal: ctx.signal }));
        } });
    bb.cli.register(defineCli({ name: 'oxi-op', summary: 'Project-scoped 1Password operations', commands: {
            verify: cliCommand({summary: 'Create, compare and remove one synthetic test item', options: {profile: {type: 'string', description: 'Configured access profile', default: 'default'}}, async run(input, ctx) {if (!ctx.projectId) throw new Error('Run in a BB project'); const access = await accessFor(ctx.projectId, input.options.profile); const result=await host.call('verify', access, {hostId: access.route.hostId, signal: ctx.signal}); const verification={...result, at:new Date().toISOString()}; await bb.storage.kv.set('verification:'+ctx.projectId+':'+input.options.profile, verification); return {exitCode: 0, stdout: JSON.stringify(verification)};}}),
            check: cliCommand({ summary: 'Verify op access to the configured vault before requesting a credential', options: { profile: { type: 'string', description: 'Configured access profile', default: 'default' } }, async run(input, ctx) { if (!ctx.projectId)
                    throw new Error('Run in a BB project'); const access = await accessFor(ctx.projectId, input.options.profile); return { exitCode: 0, stdout: JSON.stringify(await host.call('check', access, { hostId: access.route.hostId, signal: ctx.signal })) }; } }),
            status: cliCommand({ summary: 'Check the current project route without reading credentials', options: { profile: { type: 'string', description: 'Configured access profile', default: 'default' } }, async run(input, ctx) { if (!ctx.projectId)
                    throw new Error('Run in a BB project'); const { route } = await accessFor(ctx.projectId, input.options.profile); return { exitCode: 0, stdout: JSON.stringify({ configured: true, profile: route.profile, hostId: route.hostId, vaultId: route.vaultId, authentication: route.authentication, requireApproval: route.requireApproval, operations: route.operations.map(x => x.name), lastVerification: await bb.storage.kv.get('verification:'+ctx.projectId+':'+input.options.profile) ?? null }) }; } }),
            store: cliCommand({ summary: 'Open a private credential form', positionals: [{ name: 'title', description: 'Item title', required: true }], options: { username: { type: 'string', description: 'Account name', default: '' }, profile: { type: 'string', description: 'Configured access profile', default: 'default' } }, async run(input, ctx) { if (!ctx.threadId || !ctx.projectId)
                    throw new Error('Run from a BB thread'); return { exitCode: 0, stdout: await store(input.positionals.title, input.options.username, input.options.profile, { threadId: ctx.threadId, projectId: ctx.projectId, signal: ctx.signal }) }; } })
        } }));
}
