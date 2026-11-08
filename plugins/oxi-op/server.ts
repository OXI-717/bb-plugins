import { defineCli, cliCommand, defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {taskContract,assignmentSchema} from './task-contract.js';
import { createHash, randomUUID } from 'node:crypto';
import { CodedError, errorCode } from './errors.js';
import { contract, routeSchema, resolveRoute, keyReferenceSchema, type Route } from './contract.js';
import {createJournal, cancelledOutcome, OperationFailure} from './journal.js';
type OperationContext = {threadId: string; projectId: string; signal?: AbortSignal};
const approvalTimeoutMs = 60_000;
export const deliveryContract = defineRpcContract({formReceipt: {input: z.object({threadId:z.string().min(1).max(100),interactionId:z.string().min(1).max(100),visible:z.boolean()}).strict(),output:z.object({recorded:z.literal(true)})}});
export default function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({ routes: { type: 'string', label: 'Project vault routes (JSON)', default: '[]', experimental_multiline: true }, serviceAccountToken: { type: 'string', label: 'Legacy scoped service account token', secret: true, default: '' }, projectServiceAccounts: {type: 'string', label: 'Project and profile service accounts (encrypted JSON)', secret: true, default: '{}'} });
    const host = bb.hosts.experimental_client({ contract });
    const credentialHost = (route: Route) => route.credentialHostId ?? route.hostId;
    const journal = createJournal(bb.storage.kv);
    type Receipt = {interactionId:string;mountedAt:string;lastSeenAt:string;visibleEver:boolean};
    const receiptPrefix = (projectId:string,threadId:string) => 'display:'+encodeURIComponent(projectId)+':'+encodeURIComponent(threadId)+':';
    bb.rpc.register(deliveryContract,{async formReceipt({threadId,interactionId,visible}) {
        const requests = await bb.sdk.threads.interactions.list({threadId});
        if (!requests.some(r => r.id===interactionId && r.origin?.kind==='plugin' && r.origin.pluginId===bb.pluginId)) throw new Error('This form is not pending for this plugin');
        const thread=await bb.sdk.threads.get({threadId});
        const key=receiptPrefix(thread.projectId,threadId)+interactionId;
        const previous=await bb.storage.kv.get<Receipt>(key);
        const now=new Date().toISOString();
        await bb.storage.kv.set(key,{interactionId,mountedAt:previous?.mountedAt??now,lastSeenAt:now,visibleEver:visible||previous?.visibleEver===true});
        return {recorded:true as const};
    }});
    // A one-minute card is easy to miss when the owner looks at another session. Every approval
    // card is announced on the owner's notification channels with a link to its session. The card
    // opens first; the notice runs alongside it, bounded to 10 seconds, and its failure never
    // blocks or repeats the request. The notice carries no item, vault or project names, since it
    // can reach lock screens and external push providers. A card the owner is already looking at
    // still gets a notice: a duplicate is cheaper than a missed approval.
    const requestApproval: typeof bb.ui.requestInput = (request, options) => {
        const card = bb.ui.requestInput(request, options);
        setImmediate(() => {
            const seconds = Math.round((request.timeoutMs ?? approvalTimeoutMs) / 1000);
            void Promise.resolve().then(() => bb.sdk.plugins.callRpc({pluginId: 'push-notifications', method: 'notifications.send', input: {title: 'Oxi Op: нужно подтверждение', body: 'Откройте сессию: карточка подтверждения действует ' + seconds + ' секунд.', threadId: request.threadId}, outputSchema: z.object({ok: z.literal(true), channels: z.array(z.string())}).passthrough(), signal: AbortSignal.timeout(10_000)})).catch(() => {});
        });
        return card;
    };
    // BB resumes an idle agent for a fulfilled tool result, including a reported failure.
    const toolOutcome = async (work: () => Promise<string>) => {
        try {return await work();}
        catch (error) {if(error instanceof OperationFailure)return JSON.stringify({completed:false,code:error.code,message:error.message});return JSON.stringify({completed: false, message: 'Operation failed. Inspect oxi_op_history before retrying; no secret values are included.'});}
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
    bb.rpc.register(taskContract,{async runPreparedTask({requestId},ctx){
        if(ctx.experimental_signal.aborted)throw new Error('Prepared task cancelled');
        if(ctx.experimental_caller.kind!=='plugin'||ctx.experimental_caller.pluginId!=='account-pool-balanced')
            throw new Error('Only Account Pooler may start a prepared native task');
        const assignment=await bb.sdk.plugins.callRpc({pluginId:'account-pool-balanced',method:'claimNativeUnlock',
            input:{requestId},outputSchema:assignmentSchema,signal:ctx.experimental_signal});
        if(assignment.deadline<=Date.now()||ctx.experimental_signal.aborted)throw new Error('Prepared task expired or cancelled');
        const access=await accessFor(assignment.binding.caller.projectId,assignment.profile);
        const {route}=access;
        if(route.hostId!==assignment.binding.hostId||route.authentication!=='service-account'||route.requireApproval||
           route.tokenSetting!=='projectServiceAccounts'||!access.serviceAccountToken||route.credentialHostId)
            throw new Error('Prepared task requires its explicit unattended project route');
        const configured=route.operations.filter(op=>op.name===assignment.operation);
        if(configured.length!==1||Object.keys(configured[0].references).length!==0)
            throw new Error('Prepared task requires one fixed operation without caller references');
        return host.call('runPrepared',{...access,serviceAccountToken:access.serviceAccountToken,assignment},
            {hostId:assignment.binding.hostId,signal:ctx.experimental_signal});
    }});
    async function requireHost(hostId: string, kind: 'credential' | 'execution', ctx: OperationContext) {
        let machine;
        try {machine = await bb.sdk.hosts.get({hostId, signal: ctx.signal});}
        catch {throw new OperationFailure('host_status_unavailable');}
        if (machine.id !== hostId) throw new OperationFailure('host_status_unavailable');
        if (machine.status !== 'connected') throw new OperationFailure(kind === 'credential' ? 'credential_host_offline' : 'execution_host_offline');
    }
    const requireCredentialHost = (route: Route, ctx: OperationContext) => requireHost(credentialHost(route), 'credential', ctx);
    // Owner approval goes to the first listed owner machine that is online.
    async function credentialTarget(route: Route, ctx: OperationContext): Promise<Route> {
        if (route.authentication !== 'desktop' || !route.desktopHosts) return route;
        const {desktopHosts, ...rest} = route;
        for (const candidate of desktopHosts) {
            try {
                const machine = await bb.sdk.hosts.get({hostId: candidate.hostId, signal: ctx.signal});
                if (machine.id === candidate.hostId && machine.status === 'connected') return {...rest, credentialHostId: candidate.hostId, opBinary: candidate.opBinary};
            } catch {}
        }
        throw new OperationFailure('credential_host_offline');
    }
    // Scoped service-account work runs where the requesting session runs, if that machine is allowed.
    async function sessionTarget(route: Route, ctx: OperationContext): Promise<{route: Route; cwd?: string}> {
        if (route.authentication !== 'service-account' || !route.sessionHosts) return {route};
        let environment;
        try {
            const thread = await bb.sdk.threads.get({threadId: ctx.threadId, signal: ctx.signal});
            if (thread.id !== ctx.threadId || thread.projectId !== ctx.projectId || !thread.environmentId) throw new Error();
            environment = await bb.sdk.environments.get({environmentId: thread.environmentId, signal: ctx.signal});
            if (environment.id !== thread.environmentId) throw new Error();
        } catch {throw new OperationFailure('session_host_not_allowed');}
        const opBinary = Object.hasOwn(route.sessionHosts, environment.hostId) ? route.sessionHosts[environment.hostId] : undefined;
        if (!opBinary) throw new OperationFailure('session_host_not_allowed');
        return {route: {...route, hostId: environment.hostId, opBinary}, cwd: environment.path ?? undefined};
    }
    const target = async (route: Route, ctx: OperationContext) => route.authentication === 'desktop' ? credentialTarget(route, ctx) : (await sessionTarget(route, ctx)).route;
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
        const configured = await accessFor(ctx.projectId, profile);
        return journal.run('store', profile, ctx, async progress => {
        const route = await target(configured.route, ctx);
        const access = {...configured, route};
        await requireCredentialHost(route,ctx);
        const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
        await progress('awaiting-approval');
        const result = await requestApproval({ threadId: ctx.threadId, rendererId: 'credential', timeoutMs: approvalTimeoutMs, title: 'Сохранить пароль: ' + title, payload: { mode: 'store', title, username, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: credentialHost(route), ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', purpose: 'Создать запись и проверить сохранённый пароль', secrets: [{field: 'password', item: title}] }, describeSubmission: () => ({ title: 'Credential submitted (value omitted)' }) }, { signal: ctx.signal });
        if (result.outcome !== 'submitted')
            return cancelledOutcome(result);
        const value = z.object({ password: z.string().min(1).max(16000) }).strict().parse(result.value);
        await progress('awaiting-approval',true);
        await requireCredentialHost(route,ctx);
        await progress('running', true);
        return JSON.stringify(await host.call('store', { ...access, title, username, password: value.password }, { hostId: credentialHost(route), signal: ctx.signal }));
        }, title);
    }
    let connecting = false;
    async function connectProject(projectId: string, profile: string, ctx: OperationContext) {
        if (connecting) throw new Error('Project setup is already pending');
        connecting = true;
        try {
            const {route: configured} = await accessFor(ctx.projectId, profile);
            if (configured.authentication !== 'desktop' || !configured.requireApproval) throw new Error('Project setup requires approved desktop access');
            const route = await credentialTarget(configured, ctx);
            const project = await bb.sdk.projects.get({projectId, signal: ctx.signal});
            if (project.id !== projectId || !project.name?.trim()) throw new Error('Target project could not be verified');
            const routes = z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
            if (routes.some(r => r.projectId === projectId && r.profile === 'default')) throw new Error('Project already has a default route; no changes made');
            const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
            return await journal.run('connect', profile, ctx, async progress => {
                await progress('awaiting-approval');
                const decision = await requestApproval({threadId:ctx.threadId,rendererId:'credential',timeoutMs:approvalTimeoutMs,title:'Подключить хранилище: '+project.name,payload:{mode:'approve',title:'Подключить проект '+project.name,profile,projectId:ctx.projectId,threadId:ctx.threadId,label:project.name+' — защищённое хранилище',hostId:credentialHost(route),...display,vaultId:'new-project-vault',vaultLabel:project.name,purpose:'Создать отдельный сейф «'+project.name+'» и сохранить привязку проекта в Oxi Op. Существующий одноимённый сейф используется только при точном совпадении метки этого BB-проекта. Пароли не читаются, автоматический доступ не выдаётся.',secrets:[]},describeSubmission:()=>({title:'Project vault setup approved (no credential values)'})},{signal:ctx.signal});
                if (decision.outcome !== 'submitted' || !z.object({approved:z.literal(true)}).strict().safeParse(decision.value).success) return cancelledOutcome(decision);
                await progress('running', true);
                const vault = await host.call('provisionVault',{route,projectId,name:project.name},{hostId:credentialHost(route),signal:ctx.signal});
                const latest = z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
                if (latest.some(r=>r.projectId===projectId && r.profile==='default')) throw new CodedError('routes-changed', 'Routing changed during setup; vault preserved for recovery');
                const target = routeSchema.parse({projectId,profile:'default',label:project.name,hostId:route.hostId,credentialHostId:credentialHost(route),vaultId:vault.vaultId,vaultLabel:vault.name,opBinary:route.opBinary,authentication:'desktop',accountId:route.accountId,requireApproval:true,operations:[]});
                await settings.experimental_set({routes:JSON.stringify([...latest,target])});
                const saved=resolveRoute(JSON.parse((await settings.get()).routes),projectId);
                if (saved.vaultId!==vault.vaultId) throw new Error('Saved route differs');
                return JSON.stringify({configured:true,projectId,vaultId:vault.vaultId});
            }, 'Подключить проект '+project.name);
        } finally {connecting=false;}
    }
    const targetsSchema = z.array(z.object({projectId:z.string().min(1),existingVaultId:z.string().min(1).optional()}).strict()).min(1).max(50).refine(xs=>new Set(xs.map(x=>x.projectId)).size===xs.length,'Duplicate target projects');
    async function connectMany(raw: string, profile: string, ctx: OperationContext) {
        if (connecting) throw new Error('Project setup is already pending');
        connecting=true;
        try {
            const targets=targetsSchema.parse(JSON.parse(raw));
            const {route:configured}=await accessFor(ctx.projectId,profile);
            if(configured.authentication!=='desktop'||!configured.requireApproval)throw new Error('Project setup requires approved desktop access');
            const route=await credentialTarget(configured,ctx);
            const projects=await Promise.all(targets.map(async target=>{
                const project=await bb.sdk.projects.get({projectId:target.projectId,signal:ctx.signal});
                if(project.id!==target.projectId||!project.name?.trim())throw new Error('Target identity differs');
                return {...target,name:project.name};
            }));
            const routes=z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
            const pending=projects.filter(p=>!routes.some(r=>r.projectId===p.projectId&&r.profile==='default'));
            const rows:{projectId:string;state:'configured'|'already-configured'|'needs-review';vaultId?:string}[]=projects.filter(p=>!pending.includes(p)).map(p=>({projectId:p.projectId,state:'already-configured'}));
            if(!pending.length)return JSON.stringify({projects:rows});
            const display=await displayContext({...route,hostId:credentialHost(route)},ctx);
            return await journal.run('connect-many',profile,ctx,async progress=>{
                await progress('awaiting-approval');
                const decision=await requestApproval({threadId:ctx.threadId,rendererId:'credential',timeoutMs:approvalTimeoutMs,title:'Подключить хранилища проектов',payload:{mode:'approve',title:'Подключить '+pending.length+' проектов',profile,projectId:ctx.projectId,threadId:ctx.threadId,label:pending.map(p=>p.name).join(', '),hostId:credentialHost(route),...display,vaultId:'project-vaults',vaultLabel:'Отдельный сейф каждого проекта',purpose:pending.map(p=>p.name+': '+(p.existingVaultId?'подключить существующий сейф по точному ID':'создать или восстановить сейф с меткой проекта')).join('\n')+'\nСохранить привязки по умолчанию. Пароли не читаются; автоматический доступ не выдаётся. Уже настроенные проекты пропускаются.',secrets:[]},describeSubmission:()=>({title:'Project vault connections approved (no credential values)'})},{signal:ctx.signal});
                if(decision.outcome!=='submitted'||!z.object({approved:z.literal(true)}).strict().safeParse(decision.value).success)return cancelledOutcome(decision);
                await progress('running',true);
                for(const project of pending){
                    if(ctx.signal?.aborted)throw new Error('Project setup interrupted');
                    try{
                        const vault=await host.call('provisionVault',{route,projectId:project.projectId,name:project.name,...(project.existingVaultId?{existingVaultId:project.existingVaultId}:{})},{hostId:credentialHost(route),signal:ctx.signal});
                        const latest=z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
                        if(latest.some(r=>r.projectId===project.projectId&&r.profile==='default'))throw new CodedError('routes-changed', 'Routing changed during setup');
                        if(ctx.signal?.aborted)throw new Error('Project setup interrupted');
                        const target=routeSchema.parse({projectId:project.projectId,profile:'default',label:project.name,hostId:route.hostId,credentialHostId:credentialHost(route),vaultId:vault.vaultId,vaultLabel:vault.name,opBinary:route.opBinary,authentication:'desktop',accountId:route.accountId,requireApproval:true,operations:[]});
                        await settings.experimental_set({routes:JSON.stringify([...latest,target])});
                        if(resolveRoute(JSON.parse((await settings.get()).routes),project.projectId).vaultId!==vault.vaultId)throw new Error('Saved route differs');
                        rows.push({projectId:project.projectId,state:'configured',vaultId:vault.vaultId});
                    }catch{rows.push({projectId:project.projectId,state:'needs-review'});}
                }
                return JSON.stringify({projects:rows});
            },'Подключение хранилищ проектов');
        }finally{connecting=false;}
    }
    const tokenMapSchema = z.record(z.string(), z.record(z.string(), z.string().min(1)));
    // One owner approval issues, for each listed project, a read-only agent account and a
    // write-capable intake account for a dedicated automation vault. A project's routes become
    // active only after both scopes are proven from the default execution machine; tokens live
    // only in encrypted settings and in the project's owner-approved backup item.
    // Only fixed codes are recorded: raw errors can quote provider output, including tokens.
    type AutomationStage = 'resume-scope' | 'issue' | 'save-tokens' | 'probe-reader' | 'probe-intake' | 'verify-intake' | 'save-routes';
    class ProbeFailure extends Error {constructor(readonly code: string) {super('probe');}}
    const failureReason = (error: unknown) => {
        if (error instanceof ProbeFailure && /^[a-z0-9-]{1,40}$/.test(error.code)) return error.code;
        if (error instanceof OperationFailure) return error.code;
        return errorCode(error) ?? 'unclassified';
    };
    const sessionHostsSchema = z.record(z.string().min(1), z.string().regex(/^\/[^\0]*$/)).refine(x => Object.keys(x).length > 0 && Object.keys(x).length <= 6, 'List one to six machines');
    async function automate(projectIds: string[], profile: string, executionHostId: string, sessionHosts: Record<string, string>, ctx: OperationContext, resumeOnly = false) {
        if (connecting) throw new Error('Project setup is already pending');
        connecting = true;
        try {
            if (!projectIds.length || projectIds.length > 20 || new Set(projectIds).size !== projectIds.length) throw new Error('List distinct target projects');
            if (!Object.hasOwn(sessionHosts, executionHostId)) throw new Error('The default execution machine must be one of the session machines');
            const {route: configured} = await accessFor(ctx.projectId, profile);
            if (configured.authentication !== 'desktop' || !configured.requireApproval) throw new Error('Automatic access setup requires approved owner desktop access');
            const routes = z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
            const projects = await Promise.all(projectIds.map(async projectId => {
                const project = await bb.sdk.projects.get({projectId, signal: ctx.signal});
                if (project.id !== projectId || !project.name?.trim()) throw new Error('Target project could not be verified');
                const backup = resolveRoute(routes, projectId);
                if (backup.authentication !== 'desktop' || !backup.requireApproval) throw new Error('Target project needs an owner-approved desktop vault for token backups');
                if (routes.some(r => r.projectId === projectId && (r.profile === 'routine' || r.profile === 'intake'))) throw new Error('Automatic access is already configured for ' + project.name + '; no changes made');
                return {projectId, name: project.name, backup, accounts: [
                    {profile: 'routine', name: project.name + ' agent reader', permissions: ['read_items'] as ['read_items']},
                    {profile: 'intake', name: project.name + ' key intake', permissions: ['read_items', 'write_items'] as ['read_items', 'write_items']},
                ]};
            }));
            await requireHost(executionHostId, 'execution', ctx);
            const execution = await displayContext({...configured, hostId: executionHostId}, ctx);
            const machineNames = await Promise.all(Object.entries(sessionHosts).map(async ([hostId, opPath]) => (await displayContext({...configured, hostId}, ctx)).hostLabel + ' (' + opPath + ')'));
            type Project = (typeof projects)[number];
            // Shared by fresh issuance and by resuming tokens an earlier approval already produced.
            const activate = async (project: Project, tokens: Map<string, string>, vault: {vaultId: string; vaultName: string}, setStage: (stage: AutomationStage) => void) => {
                const targets = project.accounts.map(a => routeSchema.parse({projectId: project.projectId, profile: a.profile, label: project.name + (a.profile === 'routine' ? ' — ключи агентов' : ' — приём ключей'), hostId: executionHostId, vaultId: vault.vaultId, vaultLabel: vault.vaultName, opBinary: sessionHosts[executionHostId], authentication: 'service-account', tokenSetting: 'projectServiceAccounts', requireApproval: a.profile !== 'routine', allowAgentCommands: a.profile === 'routine', sessionHosts, operations: []}));
                setStage('save-tokens');
                const stored = tokenMapSchema.parse(JSON.parse((await settings.get()).projectServiceAccounts));
                await settings.experimental_set({projectServiceAccounts: JSON.stringify({...stored, [project.projectId]: {...(stored[project.projectId] ?? {}), ...Object.fromEntries(tokens)}})});
                const saved = tokenMapSchema.parse(JSON.parse((await settings.get()).projectServiceAccounts))[project.projectId] ?? {};
                if (project.accounts.some(a => saved[a.profile] !== tokens.get(a.profile))) throw new CodedError('tokens-not-saved', 'Saved service tokens differ');
                const [reader, intake] = targets;
                setStage('probe-reader');
                const readerScope = await host.call('probeScope', {route: reader, serviceAccountToken: tokens.get('routine')!}, {hostId: executionHostId, signal: ctx.signal});
                setStage('probe-intake');
                const intakeScope = await host.call('probeScope', {route: intake, serviceAccountToken: tokens.get('intake')!}, {hostId: executionHostId, signal: ctx.signal});
                if (readerScope.writable) throw new CodedError('reader-can-write', 'Issued permissions differ from the approved scope: reader can write');
                if (!intakeScope.writable) throw new ProbeFailure('intake-' + (intakeScope.writeFailure ?? 'unknown'));
                setStage('verify-intake');
                await host.call('verify', {route: intake, serviceAccountToken: tokens.get('intake')!}, {hostId: executionHostId, signal: ctx.signal});
                setStage('save-routes');
                const latest = z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
                if (latest.some(r => r.projectId === project.projectId && (r.profile === 'routine' || r.profile === 'intake'))) throw new CodedError('routes-changed', 'Routing changed during setup');
                await settings.experimental_set({routes: JSON.stringify([...latest, ...targets])});
                const current = JSON.parse((await settings.get()).routes);
                if (targets.some(t => resolveRoute(current, project.projectId, t.profile).vaultId !== vault.vaultId)) throw new CodedError('routes-not-saved', 'Saved routes differ');
            };
            // An earlier approval may already have produced and saved tokens before a later step failed.
            // Continue from them on the execution machine without a new card or desktop authorization.
            // Resuming may use only the machines and op paths the owner saw and approved on the card.
            const planKey = (projectId: string) => 'automation-plan:' + encodeURIComponent(projectId);
            const plan = JSON.stringify({executionHostId, sessionHosts: Object.fromEntries(Object.entries(sessionHosts).sort(([a], [b]) => a.localeCompare(b)))});
            const saved = tokenMapSchema.parse(JSON.parse((await settings.get()).projectServiceAccounts));
            // Saved tokens without a matching approved plan go through the card again; issuance
            // then recovers the backed-up tokens instead of creating new accounts.
            const plans = new Map(await Promise.all(projects.map(async p => [p.projectId, (await bb.storage.kv.get<{plan: string}>(planKey(p.projectId)))?.plan] as const)));
            const resumable = projects.filter(p => p.accounts.every(a => !!saved[p.projectId]?.[a.profile]) && plans.get(p.projectId) === plan);
            const fresh = projects.filter(p => !resumable.includes(p));
            const resumedRows: {projectId: string; state: 'configured' | 'needs-review'; vaultId?: string; resumed?: boolean; stage?: AutomationStage; reason?: string}[] = [];
            if (resumable.length) {
                const resumed = await journal.run('automate', profile, ctx, async progress => {
                    await progress('running');
                    for (const project of resumable) {
                        let stage: AutomationStage = 'resume-scope';
                        try {
                            const tokens = new Map(project.accounts.map(a => [a.profile, saved[project.projectId][a.profile]]));
                            const scopes = await Promise.all(project.accounts.map(a => host.call('describeScope', {opBinary: sessionHosts[executionHostId], serviceAccountToken: tokens.get(a.profile)!}, {hostId: executionHostId, signal: ctx.signal})));
                            const vault = scopes[0].vaults[0];
                            if (!vault || scopes.some(x => x.vaults.length !== 1 || x.vaults[0].id !== vault.id) || vault.name !== project.name + ' — Automation') throw new CodedError('scope-differs', 'Service account scope differs from the automation vault');
                            await activate(project, tokens, {vaultId: vault.id, vaultName: vault.name}, next => {stage = next;});
                            resumedRows.push({projectId: project.projectId, state: 'configured', vaultId: vault.id, resumed: true});
                        } catch (error) {resumedRows.push({projectId: project.projectId, state: 'needs-review', resumed: true, stage, reason: failureReason(error)});}
                    }
                    return JSON.stringify({projects: resumedRows});
                }, 'Продолжение автоматического доступа: ' + resumable.map(p => p.name).join(', '));
                if (!fresh.length) return resumed;
            }
            if (resumeOnly) return JSON.stringify({projects: [...resumedRows, ...fresh.map(p => ({projectId: p.projectId, state: 'not-issued' as const}))]});
            const title = fresh.length === 1 ? fresh[0].name : fresh.length + ' проектов';
            return await journal.run('automate', profile, ctx, async progress => {
                const route = await credentialTarget(configured, ctx);
                await requireCredentialHost(route, ctx);
                const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
                await progress('awaiting-approval');
                const decision = await requestApproval({threadId: ctx.threadId, rendererId: 'credential', timeoutMs: approvalTimeoutMs, title: 'Автоматический доступ агентов: ' + title, payload: {mode: 'approve', title: 'Выпустить автоматический доступ агентов: ' + title, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: fresh.map(x => x.name).join(', '), hostId: credentialHost(route), ...display, vaultId: 'automation-vaults', vaultLabel: 'Отдельный сейф «<Проект> — Automation» у каждого проекта', purpose: ['Для каждого проекта: сейф только для ключей агентов и два доступа к нему на 90 дней.', 'Чтение (read_items) — агенты используют ключи без подтверждений на машинах: ' + machineNames.join(', ') + '.', 'Чтение и запись (read_items, write_items) — приём новых ключей через закрытую форму.', 'Без других сейфов, share_items и создания сейфов. Критические пароли в основном сейфе проекта по-прежнему требуют вашего подтверждения.', 'Токены — только в зашифрованных настройках Oxi Op и резервной записи в основном сейфе проекта.', 'Права проверяются с ' + execution.hostLabel + ' до включения.'].join('\n'), secrets: []}, describeSubmission: () => ({title: 'Automatic agent access approved (no credential values)'})}, {signal: ctx.signal});
                if (decision.outcome !== 'submitted' || !z.object({approved: z.literal(true)}).strict().safeParse(decision.value).success) return cancelledOutcome(decision);
                await progress('awaiting-approval', true);
                for (const project of fresh) await bb.storage.kv.set(planKey(project.projectId), {plan, approvedAt: new Date().toISOString()});
                await requireCredentialHost(route, ctx);
                await requireHost(executionHostId, 'execution', ctx);
                await progress('running', true);
                const rows: {projectId: string; state: 'configured' | 'needs-review'; vaultId?: string; recoveredTokens?: number; stage?: AutomationStage; reason?: string}[] = [];
                for (const project of fresh) {
                    if (ctx.signal?.aborted) throw new Error('Automatic access setup interrupted');
                    let stage: AutomationStage = 'issue';
                    try {
                        const vaultName = project.name + ' — Automation';
                        const issued = await host.call('issueServiceAccounts', {route, projectId: project.projectId, vaultName, backupVaultId: project.backup.vaultId, expiresIn: '90d', accounts: project.accounts}, {hostId: credentialHost(route), signal: ctx.signal});
                        const tokens = new Map(issued.accounts.map(a => [a.profile, a.token]));
                        if (project.accounts.some(a => !tokens.get(a.profile)) || tokens.size !== project.accounts.length) throw new CodedError('accounts-differ', 'Issued accounts differ from the request');
                        await activate(project, tokens, {vaultId: issued.vaultId, vaultName: issued.vaultName}, next => {stage = next;});
                        rows.push({projectId: project.projectId, state: 'configured', vaultId: issued.vaultId, recoveredTokens: issued.accounts.filter(a => a.recovered).length});
                    } catch (error) {rows.push({projectId: project.projectId, state: 'needs-review', stage, reason: failureReason(error)});}
                }
                return JSON.stringify({projects: [...resumedRows, ...rows]});
            }, 'Автоматический доступ агентов: ' + title);
        } finally {connecting = false;}
    }
    const profileParameter = z.string().min(1).max(80).default('default');
    bb.agents.registerTool({ name: 'oxi_op_store', description: 'Request a credential in a private BB form and save it to the current project vault and configured access profile. Passwords must never be supplied in tool arguments. Missing routing requires project setup; never fall back to Keychain, chat or shell password commands.', parameters: z.object({ title: z.string().min(1).max(160), username: z.string().max(200).default(''), profile: profileParameter }).strict(), execute: ({ title, username, profile }, ctx) => toolOutcome(() => store(title, username, profile, ctx)) });
    async function runConfigured(operation: string, profile: string, ctx: OperationContext) {
            const configuredAccess = await accessFor(ctx.projectId, profile);
            const route = await target(configuredAccess.route, ctx);
            const access = {...configuredAccess, route};
            const matches = route.operations.filter(x => x.name === operation);
            if (matches.length !== 1)
                throw new Error('Operation is not configured');
            const configured = matches[0];
            const authorization = route.credentialHostId ? await displayContext({...route, hostId: route.credentialHostId}, ctx) : undefined;
            const purpose = (configured.purpose ?? configured.name) + (authorization ? '\nАвторизация 1Password: ' + authorization.hostLabel + '. Значение передаётся только настроенной команде на указанной машине.' : '');
            return journal.run('run', profile, ctx, async progress => {
            await requireCredentialHost(route,ctx);
            await requireHost(route.hostId,'execution',ctx);
            if (route.requireApproval) {
                const display = await displayContext(route, ctx);
                await progress('awaiting-approval');
                const result = await requestApproval({ threadId: ctx.threadId, rendererId: 'credential', timeoutMs: approvalTimeoutMs, title: 'Использовать секрет: ' + (configured.label ?? configured.purpose ?? operation), payload: { mode: 'approve', title: configured.label ?? configured.purpose ?? operation, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: route.hostId, ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', purpose, secrets: Object.entries(configured.references).map(([variable, reference]) => ({variable, reference, item: configured.referenceLabels?.[variable]?.item ?? 'Название записи не настроено', field: configured.referenceLabels?.[variable]?.field ?? reference.split('/').at(-1) ?? 'Поле не указано'})) }, describeSubmission: () => ({ title: 'Credential use approved' }) }, { signal: ctx.signal });
                if (result.outcome !== 'submitted' || z.object({ approved: z.literal(true) }).strict().safeParse(result.value).success === false)
                    return cancelledOutcome(result);
            }
            if(route.requireApproval)await progress('awaiting-approval',true);
            await requireCredentialHost(route,ctx);
            await requireHost(route.hostId,'execution',ctx);
            await progress('running', route.requireApproval);
            if (route.credentialHostId) {
                const {bindings} = await host.call('resolve', {route, operation}, {hostId: route.credentialHostId, signal: ctx.signal});
                try {return JSON.stringify(await host.call('execute', {route, operation, bindings}, {hostId: route.hostId, signal: ctx.signal}));}
                finally {for (const key of Object.keys(bindings)) delete bindings[key];}
            }
            return JSON.stringify(await host.call('run', { ...access, operation }, { hostId: route.hostId, signal: ctx.signal }));
            }, configured.label ?? configured.name);
    }
    async function agentAccess(profile: string, ctx: OperationContext) {
        const access = await accessFor(ctx.projectId, profile);
        if (access.route.authentication !== 'service-account' || access.route.requireApproval || !access.route.allowAgentCommands || !access.serviceAccountToken) throw new Error('This access profile does not give agents keys automatically. Critical passwords need oxi_op_run with owner approval.');
        const {route, cwd} = await sessionTarget(access.route, ctx);
        await requireHost(route.hostId, 'execution', ctx);
        return {route, cwd, serviceAccountToken: access.serviceAccountToken};
    }
    async function listAgentKeys(profile: string, ctx: OperationContext) {
        const {route, serviceAccountToken} = await agentAccess(profile, ctx);
        return JSON.stringify(await host.call('listKeys', {route, serviceAccountToken}, {hostId: route.hostId, signal: ctx.signal}));
    }
    const keysSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/).refine(x => !x.startsWith('OP_'), 'OP_ variables are reserved'), keyReferenceSchema).refine(x => Object.keys(x).length >= 1 && Object.keys(x).length <= 20, 'Request one to twenty keys');
    async function execAgentCommand(argv: string[], keys: Record<string, {item: string; field: string}>, profile: string, timeoutSeconds: number, ctx: OperationContext) {
        const {route, cwd, serviceAccountToken} = await agentAccess(profile, ctx);
        const label = 'Команда агента: ' + (argv[0].split('/').at(-1) ?? 'command').slice(0, 60) + ' (' + Object.keys(keys).join(', ') + ')';
        return journal.run('exec', profile, ctx, async progress => {
            await progress('running');
            const result = await host.call('exec', {route, serviceAccountToken, argv, keys, ...(cwd ? {cwd} : {}), timeoutSeconds}, {hostId: route.hostId, signal: ctx.signal});
            return JSON.stringify({completed: true, ...result});
        }, label);
    }
    bb.agents.registerTool({name: 'oxi_op_keys', description: 'List the agent keys of the current project (item titles and field names only, never values). Works on the machine of this session without owner approval when the project has automatic agent access.', parameters: z.object({profile: z.string().min(1).max(80).default('routine')}).strict(), execute: ({profile}, ctx) => toolOutcome(() => listAgentKeys(profile, ctx))});
    bb.agents.registerTool({name: 'oxi_op_exec', description: 'Run a command on this session machine with project agent keys in environment variables, without owner approval. Map each variable to an item title and field from oxi_op_keys. Key values are removed from the returned output; never print, save or commit them. Critical passwords are not available here.', parameters: z.object({argv: z.array(z.string()).min(1).max(200), keys: keysSchema, timeoutSeconds: z.number().int().min(1).max(600).default(120), profile: z.string().min(1).max(80).default('routine')}).strict(), execute: ({argv, keys, timeoutSeconds, profile}, ctx) => toolOutcome(() => execAgentCommand(argv, keys, profile, timeoutSeconds, ctx))});
    bb.agents.registerTool({ name: 'oxi_op_run', description: 'Run an owner-configured operation using current project secrets. Only a completion result is returned; command output and secret values are suppressed. Missing routing requires project setup; never fall back to Keychain, chat or shell password commands.', parameters: z.object({ operation: z.string().min(1), profile: profileParameter }).strict(), execute: ({operation, profile}, ctx) => toolOutcome(() => runConfigured(operation, profile, ctx)) });
    async function inspectVault(kind: 'inventory' | 'check' | 'verify', profile: string, registryTitle: string | undefined, ctx: OperationContext) {
        const configuredAccess = await accessFor(ctx.projectId, profile);
        const route = await target(configuredAccess.route, ctx);
        const access = {...configuredAccess, route};
        if (kind === 'inventory' && route.authentication !== 'desktop') throw new Error('Registry inventory requires owner desktop access');
        const title = kind === 'inventory' ? 'Сверка служебных сейфов' : kind === 'verify' ? 'Проверка записи и чтения в сейфе' : 'Проверка доступа к сейфу';
        const purpose = kind === 'inventory'
            ? 'Прочитать только служебный реестр и сопоставить названия и ID указанных в нём сейфов. Содержимое проектных и личных записей не читается; права не меняются.'
            : kind === 'verify' ? 'Создать одну случайную тестовую запись, независимо сравнить её поля и удалить только эту запись.' : 'Проверить доступ к настроенному сейфу без чтения его записей.';
        return journal.run(kind, profile, ctx, async progress => {
            await requireCredentialHost(route,ctx);
            const approval = route.requireApproval || route.authentication === 'desktop';
            if (approval) {
                const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
                await progress('awaiting-approval');
                const decision = await requestApproval({threadId: ctx.threadId, rendererId: 'credential', timeoutMs: approvalTimeoutMs, title: 'Настройка 1Password: ' + title.toLowerCase(), payload: {mode: 'approve', title, purpose, profile: route.profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: credentialHost(route), ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', secrets: registryTitle ? [{item: registryTitle, field: 'Служебная заметка'}] : []}, describeSubmission: () => ({title: 'Vault operation approved (no credential values)'})}, {signal: ctx.signal});
                if (decision.outcome !== 'submitted' || !z.object({approved: z.literal(true)}).strict().safeParse(decision.value).success) return cancelledOutcome(decision);
            }
            if(approval)await progress('awaiting-approval',true);
            await requireCredentialHost(route,ctx);
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
    async function diagnose(projectId:string,profile:string) {
        const values=await settings.get();
        const route=resolveRoute(JSON.parse(values.routes),projectId,profile);
        const candidates=route.desktopHosts?.map(x=>x.hostId)??[credentialHost(route)];
        const sources=await Promise.all(candidates.map(hostId=>bb.sdk.hosts.get({hostId})));
        const source=sources.find(x=>x.status==='connected')??sources[0];
        const target=await bb.sdk.hosts.get({hostId:route.hostId});
        let tokenConfigured:boolean|null=null;
        if(route.tokenSetting==='serviceAccountToken')tokenConfigured=!!values.serviceAccountToken;
        if(route.tokenSetting==='projectServiceAccounts'){
            try {const tokens=z.record(z.string(),z.record(z.string(),z.string().min(1))).parse(JSON.parse(values.projectServiceAccounts));tokenConfigured=Object.hasOwn(tokens,projectId)&&Object.hasOwn(tokens[projectId],profile);}
            catch {tokenConfigured=false;}
        }
        return {authentication:route.authentication,credentialHost:{name:source.name,status:source.status},ownerMachines:route.authentication==='desktop'?sources.map(x=>({name:x.name,status:x.status})):[],agentCommands:route.allowAgentCommands,sessionMachines:Object.keys(route.sessionHosts??{}).length,executionHost:{name:target.name,status:target.status},requiresApproval:route.requireApproval,operationCount:route.operations.length,serviceTokenConfigured:route.authentication==='service-account'?tokenConfigured:false,credentialCalls:0};
    }
    bb.agents.registerTool({name: 'oxi_op_history', description: 'Recover this project and session operation states after confirmation, interruption or restart. Contains no credential values. Running or needs-review does not prove that a write was undone; inspect before retrying.', parameters: z.object({}).strict(), execute: async (_, ctx) => JSON.stringify(await journal.list(ctx))});
    const notifyOption = {type: 'boolean' as const, description: 'Return a completion notice to this same BB session, including after it becomes idle', default: false};
    async function interactiveCli(ctx: OperationContext, notify: boolean, work: () => Promise<string>) {
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
                await bb.sdk.threads.send({threadId: ctx.threadId, mode: 'queue-if-active', input: [{type: 'text', text: result.stdout === 'Cancelled: timeout' ? 'Oxi Op: запрос отменён по истечении 60 секунд. Это не отказ пользователя и не подтверждение показа формы. Проверьте журнал; не открывайте запрос повторно автоматически. Значения секретов не передавались в уведомлении.' : result.stdout.startsWith('Cancelled') ? 'Oxi Op: запрос отменён. Причина сохранена в журнале. Проверьте oxi_op_history или bb oxi-op history перед продолжением; автоматически не повторяйте запрос. Значений секретов в уведомлении нет.' : 'Oxi Op: обработка интерактивной операции завершена. Проверьте oxi_op_history или bb oxi-op history: завершение обработки не означает успех всех действий. Не повторяйте неопределённую запись автоматически. Значений секретов в уведомлении нет.', mentions: []}]});
            } catch {result.stderr = 'Completion notice could not be delivered; inspect oxi-op history. The credential operation was not retried.';}
        }
        return result;
    }
    bb.cli.register(defineCli({ name: 'oxi-op', summary: 'Project-scoped 1Password operations', commands: {
            diagnose:cliCommand({summary:'Inspect routing and machine availability without contacting 1Password',options:{profile:{type:'string',description:'Configured access profile',default:'default'}},async run(input,ctx){if(!ctx.projectId)throw new Error('Run in a BB project');return {exitCode:0,stdout:JSON.stringify(await diagnose(ctx.projectId,input.options.profile))};}}),
            automate:cliCommand({summary:'Approve issuing agent-reader and key-intake service accounts for project automation vaults',options:{notify:notifyOption,projects:{type:'string',description:'Comma-separated exact target BB project IDs',required:true},profile:{type:'string',description:'Existing owner desktop setup profile in this session project',required:true},host:{type:'string',description:'Default execution machine ID used for scope proofs',required:true},'session-hosts':{type:'string',description:'JSON object of allowed machine IDs to absolute op paths',required:true},'resume-only':{type:'boolean',description:'Only continue from tokens an earlier approval saved; never open a new approval',default:false}},async run(input,ctx){if(!ctx.projectId||!ctx.threadId)throw new Error('Run from a BB thread');const hosts=sessionHostsSchema.parse(JSON.parse(input.options['session-hosts']));const context={projectId:ctx.projectId,threadId:ctx.threadId,signal:ctx.signal};return interactiveCli(context,input.options.notify,()=>automate(input.options.projects.split(',').map(x=>x.trim()).filter(Boolean),input.options.profile,input.options.host,hosts,context,input.options['resume-only']));}}),
            keys:cliCommand({summary:'List agent key titles and field names for this project; never values',options:{profile:{type:'string',description:'Agent access profile',default:'routine'}},async run(input,ctx){if(!ctx.projectId||!ctx.threadId)throw new Error('Run from a BB thread');return {exitCode:0,stdout:await listAgentKeys(input.options.profile,{projectId:ctx.projectId,threadId:ctx.threadId,signal:ctx.signal})};}}),
            exec:cliCommand({summary:'Run a command on this session machine with project agent keys; values are concealed in output',options:{argv:{type:'string',description:'JSON array: program and arguments',required:true},keys:{type:'string',description:'JSON object: VARIABLE to {item, field}',required:true},timeout:{type:'string',description:'Seconds, 1-600',default:'120'},profile:{type:'string',description:'Agent access profile',default:'routine'}},async run(input,ctx){if(!ctx.projectId||!ctx.threadId)throw new Error('Run from a BB thread');const argv=z.array(z.string()).min(1).max(200).parse(JSON.parse(input.options.argv));const keys=keysSchema.parse(JSON.parse(input.options.keys));const seconds=z.coerce.number().int().min(1).max(600).parse(input.options.timeout);const result=JSON.parse(await execAgentCommand(argv,keys,input.options.profile,seconds,{projectId:ctx.projectId,threadId:ctx.threadId,signal:ctx.signal}));return {exitCode:result.exitCode===0?0:1,stdout:JSON.stringify(result)};}}),
            selftest:cliCommand({summary:'Prove agent keys of this session project end to end on listed machines with one synthetic key; never opens a form',options:{hosts:{type:'string',description:'Comma-separated machine IDs from the agent route',required:true}},async run(input,ctx){
                if(!ctx.projectId)throw new Error('Run in a BB project');
                const projectId=ctx.projectId;
                const values=await settings.get();const routes=JSON.parse(values.routes);
                const reader=resolveRoute(routes,projectId,'routine');const intake=resolveRoute(routes,projectId,'intake');
                const tokens=tokenMapSchema.parse(JSON.parse(values.projectServiceAccounts))[projectId]??{};
                if(!tokens.routine||!tokens.intake||!reader.allowAgentCommands||!reader.sessionHosts)throw new Error('Agent access is not configured for this project');
                const hosts=input.options.hosts.split(',').map(x=>x.trim()).filter(Boolean);
                if(!hosts.length||hosts.some(h=>!Object.hasOwn(reader.sessionHosts!,h)))throw new Error('List machines from the agent route');
                const title='OXI OP selftest '+randomUUID();const value=randomUUID()+randomUUID();
                const expected=createHash('sha256').update(value).digest('hex');
                const rows:Record<string,unknown>[]=[];
                try{
                    await host.call('store',{route:intake,serviceAccountToken:tokens.intake,title,username:'synthetic-selftest',password:value},{hostId:intake.hostId,signal:ctx.signal});
                    for(const hostId of hosts){
                        const route={...reader,hostId,opBinary:reader.sessionHosts![hostId]};
                        try{
                            const listed=await host.call('listKeys',{route,serviceAccountToken:tokens.routine},{hostId,signal:ctx.signal});
                            const result=await host.call('exec',{route,serviceAccountToken:tokens.routine,argv:['/bin/sh','-c','test -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" || exit 7; if command -v sha256sum >/dev/null; then printf %s "$K" | sha256sum; else printf %s "$K" | shasum -a 256; fi; printf "%s\\n" "$K"'],keys:{K:{item:title,field:'password'}},timeoutSeconds:60},{hostId,signal:ctx.signal});
                            rows.push({hostId,keyListed:listed.items.some(x=>x.item===title&&x.fields.includes('password')),exitCode:result.exitCode,valueMatched:result.output.includes(expected),valueConcealed:!result.output.includes(value)&&result.output.includes('<concealed>')});
                        }catch(error){rows.push({hostId,failed:failureReason(error)});}
                    }
                }finally{
                    const cleanup=await host.call('deleteSelftest',{route:intake,serviceAccountToken:tokens.intake,title},{hostId:intake.hostId,signal:AbortSignal.timeout(120_000)}); // cleanup must outlive a cancelled run
                    rows.push({cleanedUp:cleanup.deleted});
                }
                const ok=rows.filter(r=>'hostId' in r).every(r=>r.keyListed===true&&r.exitCode===0&&r.valueMatched===true&&r.valueConcealed===true);
                return {exitCode:ok?0:1,stdout:JSON.stringify({passed:ok,machines:rows})};
            }}),
            'connect-many':cliCommand({summary:'Approve a bounded explicit list of project vault connections',options:{notify:notifyOption,projects:{type:'string',description:'JSON array of projectId and optional exact existingVaultId',required:true},profile:{type:'string',description:'Existing owner desktop setup profile',required:true}},async run(input,ctx){if(!ctx.projectId||!ctx.threadId)throw new Error('Run from a BB thread');const context={projectId:ctx.projectId,threadId:ctx.threadId,signal:ctx.signal};return interactiveCli(context,input.options.notify,()=>connectMany(input.options.projects,input.options.profile,context));}}),
            connect: cliCommand({summary:'Approve creating a dedicated vault and default project route',options:{notify:notifyOption,project:{type:'string',description:'Exact target BB project ID',required:true},profile:{type:'string',description:'Existing owner desktop setup profile in this session project',required:true}},async run(input,ctx){if(!ctx.projectId||!ctx.threadId)throw new Error('Run from a BB thread');const context={projectId:ctx.projectId,threadId:ctx.threadId,signal:ctx.signal};return interactiveCli(context,input.options.notify,()=>connectProject(input.options.project,input.options.profile,context));}}),
            'display-status':cliCommand({summary:'Read form rendering receipts for this session; never contacts 1Password',async run(_,ctx){if(!ctx.projectId||!ctx.threadId)throw new Error('Run from a BB thread');const keys=await bb.storage.kv.list(receiptPrefix(ctx.projectId,ctx.threadId));const rows=await Promise.all(keys.map(k=>bb.storage.kv.get<Receipt>(k)));return {exitCode:0,stdout:JSON.stringify(rows.filter(Boolean).sort((a,b)=>b!.mountedAt.localeCompare(a!.mountedAt)).slice(0,20))};}}),
            'display-test':cliCommand({summary:'Show a diagnostic form without reading or using any credentials',options:{profile:{type:'string',description:'Configured profile used for display names only',default:'default'}},async run(input,ctx){
                if(!ctx.projectId||!ctx.threadId)throw new Error('Run from a BB thread');
                const {route}=await accessFor(ctx.projectId,input.options.profile);
                const display=await displayContext({...route,hostId:credentialHost(route)},{projectId:ctx.projectId,threadId:ctx.threadId,signal:ctx.signal});
                const decision=await bb.ui.requestInput({threadId:ctx.threadId,rendererId:'credential',timeoutMs:approvalTimeoutMs,title:'Проверка отображения формы — без доступа к секретам',payload:{mode:'approve',title:'Проверка отображения формы',purpose:'Только проверка интерфейса BB. 1Password не вызывается, пароли не читаются. Нажимать разрешение не требуется.',profile:route.profile,projectId:ctx.projectId,threadId:ctx.threadId,label:'Диагностика интерфейса',hostId:credentialHost(route),...display,vaultId:route.vaultId,vaultLabel:route.vaultLabel??'Не используется',secrets:[]},describeSubmission:()=>({title:'Display test submitted; no credentials accessed'})},{signal:ctx.signal});
                return {exitCode:0,stdout:JSON.stringify({submitted:decision.outcome==='submitted',credentialCalls:0})};
            }}),
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
