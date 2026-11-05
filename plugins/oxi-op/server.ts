import { defineCli, cliCommand, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { contract, resolveRoute, type Route } from './contract.js';
import {createJournal} from './journal.js';
type OperationContext = {threadId: string; projectId: string; signal?: AbortSignal; interactionTimeoutMs?: number};
export default function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({ routes: { type: 'string', label: 'Project vault routes (JSON)', default: '[]', experimental_multiline: true }, serviceAccountToken: { type: 'string', label: 'Legacy scoped service account token', secret: true, default: '' }, projectServiceAccounts: {type: 'string', label: 'Project and profile service accounts (encrypted JSON)', secret: true, default: '{}'} });
    const host = bb.hosts.experimental_client({ contract });
    const credentialHost = (route: Route) => route.credentialHostId ?? route.hostId;
    const journal = createJournal(bb.storage.kv);
    // BB resumes an idle agent for a fulfilled tool result, including a reported failure.
    const toolOutcome = async (work: () => Promise<string>) => {
        try {return await work();}
        catch {return JSON.stringify({completed: false, message: 'Operation failed. Inspect oxi_op_history before retrying; no secret values are included.'});}
    };
    const accessFor = async (projectId: string, profile: string) => {
        const values = await settings.get();
        const route = resolveRoute(JSON.parse(values.routes), projectId, profile);
        if (route.tokenSetting === 'projectServiceAccounts') {
            let tokens: Record<string, Record<string, string>>;
            try {tokens = z.record(z.string(), z.record(z.string(), z.string().min(1))).parse(JSON.parse(values.projectServiceAccounts));}
            catch {throw new Error('Project service-account settings are invalid');}
            const serviceAccountToken = Object.hasOwn(tokens, projectId) && Object.hasOwn(tokens[projectId], profile) ? tokens[projectId][profile] : undefined;
            if (!serviceAccountToken) throw new Error('A service account is not configured for this project and profile; no shared or desktop fallback is allowed');
            return {route, serviceAccountToken};
        }
        return {route, ...(route.tokenSetting ? {serviceAccountToken: values.serviceAccountToken} : {})};
    };
    async function displayContext(route: Route, ctx: {projectId: string; threadId: string; signal?: AbortSignal}) {
        const [project, thread, machine] = await Promise.allSettled([
            bb.sdk.projects.get({projectId: ctx.projectId, signal: ctx.signal}),
            bb.sdk.threads.get({threadId: ctx.threadId, signal: ctx.signal}),
            bb.sdk.hosts.get({hostId: route.hostId, signal: ctx.signal}),
        ]);
        return {
            projectName: project.status === 'fulfilled' && project.value.id === ctx.projectId ? project.value.name : 'Название проекта недоступно',
            threadName: thread.status === 'fulfilled' && thread.value.id === ctx.threadId && thread.value.projectId === ctx.projectId ? thread.value.title || 'Сессия без названия' : 'Название сессии недоступно',
            hostLabel: machine.status === 'fulfilled' && machine.value.id === route.hostId ? machine.value.name : route.hostLabel ?? 'Название машины недоступно',
        };
    }
    async function store(title: string, username: string, profile: string, ctx: OperationContext) {
        const access = await accessFor(ctx.projectId, profile);
        const { route } = access;
        const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
        return journal.run('store', profile, ctx, async progress => {
        await progress('awaiting-approval');
        const result = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'credential', timeoutMs: ctx.interactionTimeoutMs, title: 'Сохранить пароль: ' + title, payload: { mode: 'store', title, username, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: route.hostId, ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', purpose: 'Создать запись и проверить сохранённый пароль', secrets: [{field: 'password', item: title}] }, describeSubmission: () => ({ title: 'Credential submitted (value omitted)' }) }, { signal: ctx.signal });
        if (result.outcome !== 'submitted')
            return 'Cancelled; no credential stored';
        const value = z.object({ password: z.string().min(1).max(16000) }).strict().parse(result.value);
        await progress('running', true);
        return JSON.stringify(await host.call('store', { ...access, title, username, password: value.password }, { hostId: credentialHost(route), signal: ctx.signal }));
        }, title);
    }
    const profileParameter = z.string().min(1).max(80).default('default');
    bb.agents.registerTool({ name: 'oxi_op_store', description: 'Request a credential in a private BB form and save it to the current project vault and configured access profile. Passwords must never be supplied in tool arguments. Missing routing requires project setup; never fall back to Keychain, chat or shell password commands.', parameters: z.object({ title: z.string().min(1).max(160), username: z.string().max(200).default(''), profile: profileParameter }).strict(), execute: ({ title, username, profile }, ctx) => toolOutcome(() => store(title, username, profile, ctx)) });
    async function runConfigured(operation: string, profile: string, ctx: OperationContext) {
            const access = await accessFor(ctx.projectId, profile);
            const { route } = access;
            const matches = route.operations.filter(x => x.name === operation);
            if (matches.length !== 1)
                throw new Error('Operation is not configured');
            const configured = matches[0];
            const authorization = route.credentialHostId ? await displayContext({...route, hostId: route.credentialHostId}, ctx) : undefined;
            const purpose = (configured.purpose ?? configured.name) + (authorization ? '\nАвторизация 1Password: ' + authorization.hostLabel + '. Значение передаётся только настроенной команде на указанной машине.' : '');
            return journal.run('run', profile, ctx, async progress => {
            if (route.requireApproval) {
                const display = await displayContext(route, ctx);
                await progress('awaiting-approval');
                const result = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'credential', timeoutMs: ctx.interactionTimeoutMs, title: 'Использовать секрет: ' + (configured.label ?? configured.purpose ?? operation), payload: { mode: 'approve', title: configured.label ?? configured.purpose ?? operation, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: route.hostId, ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', purpose, secrets: Object.entries(configured.references).map(([variable, reference]) => ({variable, reference, item: configured.referenceLabels?.[variable]?.item ?? 'Название записи не настроено', field: configured.referenceLabels?.[variable]?.field ?? reference.split('/').at(-1) ?? 'Поле не указано'})) }, describeSubmission: () => ({ title: 'Credential use approved' }) }, { signal: ctx.signal });
                if (result.outcome !== 'submitted' || z.object({ approved: z.literal(true) }).strict().safeParse(result.value).success === false)
                    return 'Cancelled';
            }
            await progress('running', route.requireApproval);
            if (route.credentialHostId) {
                const {bindings} = await host.call('resolve', {route, operation}, {hostId: route.credentialHostId, signal: ctx.signal});
                try {return JSON.stringify(await host.call('execute', {route, operation, bindings}, {hostId: route.hostId, signal: ctx.signal}));}
                finally {for (const key of Object.keys(bindings)) delete bindings[key];}
            }
            return JSON.stringify(await host.call('run', { ...access, operation }, { hostId: route.hostId, signal: ctx.signal }));
            }, configured.label ?? configured.name);
    }
    bb.agents.registerTool({ name: 'oxi_op_run', description: 'Run an owner-configured operation using current project secrets. Only a completion result is returned; command output and secret values are suppressed. Missing routing requires project setup; never fall back to Keychain, chat or shell password commands.', parameters: z.object({ operation: z.string().min(1), profile: profileParameter }).strict(), execute: ({operation, profile}, ctx) => toolOutcome(() => runConfigured(operation, profile, ctx)) });
    async function inspectVault(kind: 'inventory' | 'check' | 'verify', profile: string, registryTitle: string | undefined, ctx: OperationContext) {
        const access = await accessFor(ctx.projectId, profile);
        const {route} = access;
        if (kind === 'inventory' && route.authentication !== 'desktop') throw new Error('Registry inventory requires owner desktop access');
        const title = kind === 'inventory' ? 'Сверка служебных сейфов' : kind === 'verify' ? 'Проверка записи и чтения в сейфе' : 'Проверка доступа к сейфу';
        const purpose = kind === 'inventory'
            ? 'Прочитать только служебный реестр и сопоставить названия и ID указанных в нём сейфов. Содержимое проектных и личных записей не читается; права не меняются.'
            : kind === 'verify' ? 'Создать одну случайную тестовую запись, независимо сравнить её поля и удалить только эту запись.' : 'Проверить доступ к настроенному сейфу без чтения его записей.';
        return journal.run(kind, profile, ctx, async progress => {
            const approval = route.requireApproval || route.authentication === 'desktop';
            if (approval) {
                const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
                await progress('awaiting-approval');
                const decision = await bb.ui.requestInput({threadId: ctx.threadId, rendererId: 'credential', timeoutMs: ctx.interactionTimeoutMs, title: 'Настройка 1Password: ' + title.toLowerCase(), payload: {mode: 'approve', title, purpose, profile: route.profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: route.hostId, ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', secrets: registryTitle ? [{item: registryTitle, field: 'Служебная заметка'}] : []}, describeSubmission: () => ({title: 'Vault operation approved (no credential values)'})}, {signal: ctx.signal});
                if (decision.outcome !== 'submitted' || !z.object({approved: z.literal(true)}).strict().safeParse(decision.value).success) return 'Cancelled';
            }
            await progress('running', approval);
            if (kind === 'inventory') return JSON.stringify(await host.call('inventory', {route, registryTitle: registryTitle!}, {hostId: credentialHost(route), signal: ctx.signal}));
            if (kind === 'check') return JSON.stringify(await host.call('check', access, {hostId: credentialHost(route), signal: ctx.signal}));
            const result = await host.call('verify', access, {hostId: credentialHost(route), signal: ctx.signal});
            const verification = {...result, at: new Date().toISOString()};
            await bb.storage.kv.set('verification:' + ctx.projectId + ':' + profile, verification);
            return JSON.stringify(verification);
        }, title);
    }
    bb.agents.registerTool({name: 'oxi_op_inventory', description: 'Ask the owner to approve reading the configured service registry before desktop CLI authorization. Returns only vault metadata. Completion resumes this session through the native BB tool lifecycle.', parameters: z.object({profile: profileParameter, title: z.string().min(1).max(160)}).strict(), execute: ({profile, title}, ctx) => toolOutcome(() => inspectVault('inventory', profile, title, ctx))});
    bb.agents.registerTool({name: 'oxi_op_history', description: 'Recover this project and session operation states after confirmation, interruption or restart. Contains no credential values. Running or needs-review does not prove that a write was undone; inspect before retrying.', parameters: z.object({}).strict(), execute: async (_, ctx) => JSON.stringify(await journal.list(ctx))});
    const notifyOption = {type: 'boolean' as const, description: 'Return a completion notice to this same BB session, including after it becomes idle', default: false};
    async function interactiveCli(ctx: OperationContext, notify: boolean, work: () => Promise<string>) {
        if (notify) ctx.interactionTimeoutMs = 60 * 60 * 1000;
        let result: {exitCode: number; stdout: string; stderr?: string};
        try {result = {exitCode: 0, stdout: await work()};}
        catch (error) {
            if (!notify) throw error;
            result = {exitCode: 1, stdout: JSON.stringify({completed: false, message: 'Operation failed; inspect oxi-op history before retrying.'})};
        }
        if (notify && !ctx.signal?.aborted) {
            try {
                const thread = await bb.sdk.threads.get({threadId: ctx.threadId, signal: ctx.signal});
                if (thread.id !== ctx.threadId || thread.projectId !== ctx.projectId || thread.archivedAt != null || thread.deletedAt != null || ctx.signal?.aborted) return result;
                await bb.sdk.threads.send({threadId: ctx.threadId, mode: 'queue-if-active', input: [{type: 'text', text: 'Oxi Op: the requested interactive CLI operation has finished. Inspect oxi_op_history or bb oxi-op history for its confirmed outcome before continuing. Completion can mean success, cancellation or failure. Do not repeat the request or an uncertain write automatically. No credential values are included in this notice.', mentions: []}]});
            } catch {result.stderr = 'Completion notice could not be delivered; inspect oxi-op history. The credential operation was not retried.';}
        }
        return result;
    }
    bb.cli.register(defineCli({ name: 'oxi-op', summary: 'Project-scoped 1Password operations', commands: {
            history: cliCommand({summary: 'Recover operation states and safe results for this project and session without contacting op', async run(_, ctx) {if (!ctx.threadId || !ctx.projectId) throw new Error('Run from a BB thread'); return {exitCode: 0, stdout: JSON.stringify(await journal.list({threadId: ctx.threadId, projectId: ctx.projectId}))};}}),
            inventory: cliCommand({summary: 'Approve reading a service vault registry before invoking desktop op', options: {notify: notifyOption, profile: {type: 'string', description: 'Owner-configured registry profile', default: 'default'}, title: {type: 'string', description: 'Registry item title', required: true}}, async run(input, ctx) {
                if (!ctx.threadId || !ctx.projectId) throw new Error('Run from a BB thread');
                const context = {projectId: ctx.projectId, threadId: ctx.threadId, signal: ctx.signal};
                return interactiveCli(context, input.options.notify, () => inspectVault('inventory', input.options.profile, input.options.title, context));
            }}),
            run: cliCommand({summary: 'Use a configured secret operation with the same BB approval as the agent tool', positionals: [{name: 'operation', description: 'Configured operation name', required: true}], options: {notify: notifyOption, profile: {type: 'string', description: 'Configured access profile', default: 'default'}}, async run(input, ctx) {if (!ctx.threadId || !ctx.projectId) throw new Error('Run from a BB thread'); const context = {threadId: ctx.threadId, projectId: ctx.projectId, signal: ctx.signal}; return interactiveCli(context, input.options.notify, () => runConfigured(input.positionals.operation, input.options.profile, context));}}),
            verify: cliCommand({summary: 'Approve creating, comparing and removing one synthetic test item', options: {notify: notifyOption, profile: {type: 'string', description: 'Configured access profile', default: 'default'}}, async run(input, ctx) {if (!ctx.projectId || !ctx.threadId) throw new Error('Run from a BB thread'); const context = {projectId: ctx.projectId, threadId: ctx.threadId, signal: ctx.signal}; return interactiveCli(context, input.options.notify, () => inspectVault('verify', input.options.profile, undefined, context));}}),
            check: cliCommand({summary: 'Approve checking the configured vault without reading records', options: {notify: notifyOption, profile: {type: 'string', description: 'Configured access profile', default: 'default'}}, async run(input, ctx) {if (!ctx.projectId || !ctx.threadId) throw new Error('Run from a BB thread'); const context = {projectId: ctx.projectId, threadId: ctx.threadId, signal: ctx.signal}; return interactiveCli(context, input.options.notify, () => inspectVault('check', input.options.profile, undefined, context));}}),
            status: cliCommand({ summary: 'Check the current project route without reading credentials', options: { profile: { type: 'string', description: 'Configured access profile', default: 'default' } }, async run(input, ctx) { if (!ctx.projectId)
                    throw new Error('Run in a BB project'); const { route } = await accessFor(ctx.projectId, input.options.profile); return { exitCode: 0, stdout: JSON.stringify({ configured: true, ...(ctx.threadId ? await displayContext(route, {projectId: ctx.projectId, threadId: ctx.threadId, signal: ctx.signal}) : {}), profile: route.profile, hostId: route.hostId, vaultId: route.vaultId, authentication: route.authentication, requireApproval: route.requireApproval, operations: route.operations.map(x => x.name), lastVerification: await bb.storage.kv.get('verification:'+ctx.projectId+':'+input.options.profile) ?? null }) }; } }),
            store: cliCommand({ summary: 'Open a private credential form', positionals: [{ name: 'title', description: 'Item title', required: true }], options: { notify: notifyOption, username: { type: 'string', description: 'Account name', default: '' }, profile: { type: 'string', description: 'Configured access profile', default: 'default' } }, async run(input, ctx) { if (!ctx.threadId || !ctx.projectId)
                    throw new Error('Run from a BB thread'); const context = {threadId: ctx.threadId, projectId: ctx.projectId, signal: ctx.signal}; return interactiveCli(context, input.options.notify, () => store(input.positionals.title, input.options.username, input.options.profile, context)); } })
        } }));
}
