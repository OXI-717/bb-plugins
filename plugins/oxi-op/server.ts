import { defineCli, cliCommand, defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {taskContract,assignmentSchema} from './task-contract.js';
import { contract, routeSchema, resolveRoute, type Route } from './contract.js';
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
        await requireCredentialHost(route,ctx);
        await progress('awaiting-approval');
        const result = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'credential', timeoutMs: approvalTimeoutMs, title: 'Сохранить пароль: ' + title, payload: { mode: 'store', title, username, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: credentialHost(route), ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', purpose: 'Создать запись и проверить сохранённый пароль', secrets: [{field: 'password', item: title}] }, describeSubmission: () => ({ title: 'Credential submitted (value omitted)' }) }, { signal: ctx.signal });
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
            const {route} = await accessFor(ctx.projectId, profile);
            if (route.authentication !== 'desktop' || !route.requireApproval) throw new Error('Project setup requires approved desktop access');
            const project = await bb.sdk.projects.get({projectId, signal: ctx.signal});
            if (project.id !== projectId || !project.name?.trim()) throw new Error('Target project could not be verified');
            const routes = z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
            if (routes.some(r => r.projectId === projectId && r.profile === 'default')) throw new Error('Project already has a default route; no changes made');
            const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
            return await journal.run('connect', profile, ctx, async progress => {
                await progress('awaiting-approval');
                const decision = await bb.ui.requestInput({threadId:ctx.threadId,rendererId:'credential',timeoutMs:approvalTimeoutMs,title:'Подключить хранилище: '+project.name,payload:{mode:'approve',title:'Подключить проект '+project.name,profile,projectId:ctx.projectId,threadId:ctx.threadId,label:project.name+' — защищённое хранилище',hostId:credentialHost(route),...display,vaultId:'new-project-vault',vaultLabel:project.name,purpose:'Создать отдельный сейф «'+project.name+'» и сохранить привязку проекта в Oxi Op. Существующий одноимённый сейф используется только при точном совпадении метки этого BB-проекта. Пароли не читаются, автоматический доступ не выдаётся.',secrets:[]},describeSubmission:()=>({title:'Project vault setup approved (no credential values)'})},{signal:ctx.signal});
                if (decision.outcome !== 'submitted' || !z.object({approved:z.literal(true)}).strict().safeParse(decision.value).success) return cancelledOutcome(decision);
                await progress('running', true);
                const vault = await host.call('provisionVault',{route,projectId,name:project.name},{hostId:credentialHost(route),signal:ctx.signal});
                const latest = z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
                if (latest.some(r=>r.projectId===projectId && r.profile==='default')) throw new Error('Routing changed during setup; vault preserved for recovery');
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
            const {route}=await accessFor(ctx.projectId,profile);
            if(route.authentication!=='desktop'||!route.requireApproval)throw new Error('Project setup requires approved desktop access');
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
                const decision=await bb.ui.requestInput({threadId:ctx.threadId,rendererId:'credential',timeoutMs:approvalTimeoutMs,title:'Подключить хранилища проектов',payload:{mode:'approve',title:'Подключить '+pending.length+' проектов',profile,projectId:ctx.projectId,threadId:ctx.threadId,label:pending.map(p=>p.name).join(', '),hostId:credentialHost(route),...display,vaultId:'project-vaults',vaultLabel:'Отдельный сейф каждого проекта',purpose:pending.map(p=>p.name+': '+(p.existingVaultId?'подключить существующий сейф по точному ID':'создать или восстановить сейф с меткой проекта')).join('\n')+'\nСохранить привязки по умолчанию. Пароли не читаются; автоматический доступ не выдаётся. Уже настроенные проекты пропускаются.',secrets:[]},describeSubmission:()=>({title:'Project vault connections approved (no credential values)'})},{signal:ctx.signal});
                if(decision.outcome!=='submitted'||!z.object({approved:z.literal(true)}).strict().safeParse(decision.value).success)return cancelledOutcome(decision);
                await progress('running',true);
                for(const project of pending){
                    if(ctx.signal?.aborted)throw new Error('Project setup interrupted');
                    try{
                        const vault=await host.call('provisionVault',{route,projectId:project.projectId,name:project.name,...(project.existingVaultId?{existingVaultId:project.existingVaultId}:{})},{hostId:credentialHost(route),signal:ctx.signal});
                        const latest=z.array(routeSchema).parse(JSON.parse((await settings.get()).routes));
                        if(latest.some(r=>r.projectId===project.projectId&&r.profile==='default'))throw new Error('Routing changed during setup');
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
            await requireCredentialHost(route,ctx);
            await requireHost(route.hostId,'execution',ctx);
            if (route.requireApproval) {
                const display = await displayContext(route, ctx);
                await progress('awaiting-approval');
                const result = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'credential', timeoutMs: approvalTimeoutMs, title: 'Использовать секрет: ' + (configured.label ?? configured.purpose ?? operation), payload: { mode: 'approve', title: configured.label ?? configured.purpose ?? operation, profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: route.hostId, ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', purpose, secrets: Object.entries(configured.references).map(([variable, reference]) => ({variable, reference, item: configured.referenceLabels?.[variable]?.item ?? 'Название записи не настроено', field: configured.referenceLabels?.[variable]?.field ?? reference.split('/').at(-1) ?? 'Поле не указано'})) }, describeSubmission: () => ({ title: 'Credential use approved' }) }, { signal: ctx.signal });
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
            await requireCredentialHost(route,ctx);
            const approval = route.requireApproval || route.authentication === 'desktop';
            if (approval) {
                const display = await displayContext({...route, hostId: credentialHost(route)}, ctx);
                await progress('awaiting-approval');
                const decision = await bb.ui.requestInput({threadId: ctx.threadId, rendererId: 'credential', timeoutMs: approvalTimeoutMs, title: 'Настройка 1Password: ' + title.toLowerCase(), payload: {mode: 'approve', title, purpose, profile: route.profile, projectId: ctx.projectId, threadId: ctx.threadId, label: route.label ?? 'Доступ проекта', hostId: credentialHost(route), ...display, vaultId: route.vaultId, vaultLabel: route.vaultLabel ?? 'Название сейфа не настроено', secrets: registryTitle ? [{item: registryTitle, field: 'Служебная заметка'}] : []}, describeSubmission: () => ({title: 'Vault operation approved (no credential values)'})}, {signal: ctx.signal});
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
        const source=await bb.sdk.hosts.get({hostId:credentialHost(route)});
        const target=await bb.sdk.hosts.get({hostId:route.hostId});
        let tokenConfigured:boolean|null=null;
        if(route.tokenSetting==='serviceAccountToken')tokenConfigured=!!values.serviceAccountToken;
        if(route.tokenSetting==='projectServiceAccounts'){
            try {const tokens=z.record(z.string(),z.record(z.string(),z.string().min(1))).parse(JSON.parse(values.projectServiceAccounts));tokenConfigured=Object.hasOwn(tokens,projectId)&&Object.hasOwn(tokens[projectId],profile);}
            catch {tokenConfigured=false;}
        }
        return {authentication:route.authentication,credentialHost:{name:source.name,status:source.status},executionHost:{name:target.name,status:target.status},requiresApproval:route.requireApproval,operationCount:route.operations.length,serviceTokenConfigured:route.authentication==='service-account'?tokenConfigured:false,credentialCalls:0};
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
