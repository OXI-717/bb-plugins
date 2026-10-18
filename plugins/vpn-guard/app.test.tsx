// @vitest-environment jsdom
import {cleanup,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {guardFixture} from './ui-fixture.js';
import {configurationSchema,rpcContract} from './contract.js';

const app=await loadPluginApp(()=>import('./app.js'));
afterEach(()=>{cleanup();localStorage.clear();});

it('shows manual refresh progress while joining an existing status read',async()=>{
 let finish!:(value:ReturnType<typeof guardFixture>)=>void;
 const pending=new Promise<ReturnType<typeof guardFixture>>(resolve=>{finish=resolve;});
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>pending}});
 fireEvent.click(slot.getByRole('button',{name:'Обновить статус'}));
 expect((slot.getByRole('button',{name:'Обновляем…'}) as HTMLButtonElement).disabled).toBe(true);
 expect(slot.rpcCalls.filter(call=>call.method==='status')).toHaveLength(1);
 finish(guardFixture());
 await slot.findByRole('button',{name:'Обновить статус'});
 await slot.findByText(/Данные получены/);
});

it('reports a failed manual refresh instead of confirming old data',async()=>{
 let fail!:(reason:Error)=>void;let calls=0;
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>++calls===1?guardFixture():new Promise((_,reject)=>{fail=reject;})}});
 await slot.findAllByText('Demo machine');
 fireEvent.click(slot.getByRole('button',{name:'Обновить статус'}));
 await waitFor(()=>expect(fail).toBeTypeOf('function'));
 fail(Error('Synthetic status failure'));
 await slot.findByText('Последние данные не подтверждены. Обновите состояние перед изменениями.');
 expect((slot.getByRole('button',{name:'Обновить статус'}) as HTMLButtonElement).disabled).toBe(false);
});

it('preserves saved enforcement and automation binding while discarding the retired switch',()=>{
 const config=configurationSchema.parse({mode:'enforce',manualBlock:false,hostIds:['demo-server'],suspendNativePluginsGlobally:false,requireVerifiedVpn:false,coordinateAutomations:true,automationControllerPath:'/controller/oxi-auto'});
 expect(config).not.toHaveProperty('requireVerifiedVpn');
 expect(config).toMatchObject({mode:'enforce',hostIds:['demo-server'],coordinateAutomations:true,automationControllerPath:'/controller/oxi-auto'});
 expect(rpcContract).not.toHaveProperty('setVerifiedVpn');
});

it('has no optional VPN verification checkbox',async()=>{
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>guardFixture()}});
 await slot.findAllByText('Demo machine');
 expect(slot.queryByRole('checkbox',{name:'Требовать подтверждённый VPN /2'})).toBeNull();
});

it('resumes automations without a review checkbox or client-supplied revision',async()=>{
 const status=guardFixture();status.coordinateAutomations=true;
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status,automationAction:()=>status}});
 const resume=await slot.findByRole('button',{name:'Возобновить'});
 expect(slot.queryByRole('checkbox',{name:/Проверил/})).toBeNull();
 fireEvent.click(resume);
 await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'automationAction',input:{action:'resume'}}));
});

it('keeps manual Block available while automation Resume waits and ignores its stale response',async()=>{
 let status=guardFixture();status.coordinateAutomations=true;
 let finish!:(value:typeof status)=>void;
 const resume=new Promise<typeof status>(resolve=>{finish=resolve;});
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status,automationAction:()=>resume,setManualBlock:()=>{status={...status,manualBlock:true};return status;}}});
 fireEvent.click(await slot.findByRole('button',{name:'Возобновить'}));
 const block=slot.getByRole('button',{name:'Заблокировать'}) as HTMLButtonElement;
 expect(block.disabled).toBe(false);fireEvent.click(block);
 await slot.findByText('Ручной блок включён');
 const reads=slot.rpcCalls.filter(c=>c.method==='status').length;
 finish({...status,manualBlock:false});
 await waitFor(()=>expect(slot.rpcCalls.filter(c=>c.method==='status').length).toBeGreaterThan(reads));
 await waitFor(()=>expect(slot.getByRole('button',{name:'Снять блок'})).toBeTruthy());
 expect(slot.queryByRole('button',{name:'Заблокировать'})).toBeNull();
});

it('renders event causes and controller progress in Russian',async()=>{
 const status=guardFixture();status.coordinateAutomations=true;status.automations.busy=true;status.automations.needsReconcile=true;
 status.events=[{at:1,kind:'vpn_blocked',hostId:'demo-server',reason:'host_rpc_failed'}];
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status}});
 await slot.findByText('Применяется');
 expect(slot.getByText(/машина не ответила на запрос статуса/)).toBeTruthy();
 expect((slot.getByRole('button',{name:'Заблокировать'}) as HTMLButtonElement).disabled).toBe(false);
});

it('shows unavailable state instead of indefinite loading after the first status failure',async()=>{
  const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>{throw new Error('synthetic status unavailable');}}});
  await slot.findByText('Статус недоступен');
  expect(slot.queryByText('Загрузка')).toBeNull();
  expect((slot.getByRole('checkbox',{name:'Защита по VPN'}) as HTMLInputElement).disabled).toBe(true);
});

it('does not expose pause or resume for an unconnected automation controller',async()=>{
  const slot=renderSlot(app.navPanels[0]!,{subPath: ""},{rpc:{status:()=>guardFixture()}});
  await slot.findAllByText('Demo machine');
  expect(slot.queryByRole('button',{name:'Приостановить'})).toBeNull();
  expect(slot.queryByRole('button',{name:'Возобновить'})).toBeNull();
});

it('uses one setting control for VPN enforcement and sends the selected mode',async()=>{
  const status=guardFixture();
  const slot=renderSlot(app.navPanels[0]!,{subPath: ""},{rpc:{status:()=>status,setMode:()=>({...status,mode:'observe'})}});
  const setting=await slot.findByRole('checkbox',{name:'Защита по VPN'});
  fireEvent.click(setting);
  await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'setMode',input:{mode:'observe'}}));
  expect((setting as HTMLInputElement).checked).toBe(false);
});

it('keeps restoration separate from disabling automatic suspension',async()=>{
  const status=guardFixture();status.suspendNativePluginsGlobally=true;status.ownedDisabledPlugins=['provider-codex'];
  const slot=renderSlot(app.navPanels[0]!,{subPath: ""},{rpc:{status:()=>status,setGlobalSuspension:()=>({...status,suspendNativePluginsGlobally:false})}});
  const setting=await slot.findByRole('checkbox',{name:'Приостанавливать встроенные Codex и Claude без VPN'});
  fireEvent.click(setting);
  await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'setGlobalSuspension',input:{enabled:false,acknowledgeGlobalImpact:false}}));
  expect(slot.rpcCalls.some(call=>call.method==='restoreOwned')).toBe(false);
  expect(slot.getByRole('button',{name:'Восстановить плагины'})).toBeTruthy();
});

it('does not offer native restoration while selected VPN evidence is unknown',async()=>{
  const status=guardFixture();status.ownedDisabledPlugins=['provider-codex'];status.hosts[0]!.vpn='unknown';
  const slot=renderSlot(app.navPanels[0]!,{subPath: ""},{rpc:{status:()=>status}});
  await slot.findAllByText(/VPN неизвестен/);
  expect((slot.getByRole('button',{name:'Восстановить плагины'}) as HTMLButtonElement).disabled).toBe(true);
});

it('allows explicit restoration after leaving enforcement and clearing machine scope',async()=>{
  const status=guardFixture();status.mode='observe';status.hostIds=[];status.hosts=[];status.ownedDisabledPlugins=['provider-codex'];
  const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status,restoreOwned:()=>({...status,ownedDisabledPlugins:[]})}});
  const restore=await slot.findByRole('button',{name:'Восстановить плагины'});
  expect((restore as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(restore);
  await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'restoreOwned',input:null}));
});

it('does not treat cached connected evidence as fresh after a status failure',async()=>{
  const status=guardFixture();status.ownedDisabledPlugins=['provider-codex'];let fail=false;
  const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>{if(fail)throw new Error('synthetic status unavailable');return status;}}});
  await slot.findByRole('button',{name:'Восстановить плагины'});
  fail=true;fireEvent.click(slot.getByRole('button',{name:'Обновить статус'}));
  await slot.findByText('Последние данные не подтверждены. Обновите состояние перед изменениями.');
  expect((slot.getByRole('button',{name:'Восстановить плагины'}) as HTMLButtonElement).disabled).toBe(true);
});

it('releases a manual block without restoring native plugins or changing VPN policy',async()=>{
  const status=guardFixture();status.manualBlock=true;status.ownedDisabledPlugins=['provider-codex'];
  const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status,setManualBlock:()=>({...status,manualBlock:false})}});
  fireEvent.click(await slot.findByRole('button',{name:'Снять блок'}));
  await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'setManualBlock',input:{blocked:false}}));
  expect(slot.rpcCalls.some(call=>['restoreOwned','setMode'].includes(call.method))).toBe(false);
  expect((slot.getByRole('checkbox',{name:'Защита по VPN'}) as HTMLInputElement).checked).toBe(true);
  expect(slot.getByRole('button',{name:'Восстановить плагины'})).toBeTruthy();
});

it('distinguishes a routine controller check from applying changes',async()=>{
 const status=guardFixture();status.coordinateAutomations=true;status.automations.busy=true;status.automations.needsReconcile=false;
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status}});
 await slot.findByText('Проверяется');expect(slot.queryByText('Применяется')).toBeNull();
});

it('shows not linked after disconnecting a failed controller with no remaining hold',async()=>{
 const status=guardFixture();status.coordinateAutomations=false;status.automations.error='Controller unavailable';status.automations.needsReconcile=false;
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status}});
 await slot.findByText('Не подключено');expect(slot.queryByText('Частично')).toBeNull();
});

it('labels historical stops without claiming they still wait and only navigates on click',async()=>{
 const status=guardFixture();status.stoppedThreadIds=['demo-thread-a','demo-thread-b'];
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status},sdk:{threads:{get:async({threadId})=>({id:threadId,title:'Example '+threadId}) as never}}});
 await slot.findByText('Ранее остановлено Guard');
 expect(slot.getByText(/не число заблокированных сейчас/)).toBeTruthy();
 fireEvent.click(slot.getByText('Ранее остановлено Guard'));
 const button=await slot.findByRole('button',{name:'Example demo-thread-a'});fireEvent.click(button);
 expect(slot.navigateCalls).toContainEqual(expect.objectContaining({method:'toThread',threadId:'demo-thread-a'}));
 expect(slot.rpcCalls.every(c=>c.method==='status')).toBe(true);
});
it('explains historical stops in English',async()=>{
 localStorage.setItem('vpn-guard-language','en');const status=guardFixture();status.stoppedThreadIds=['demo-thread-a'];
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status}});
 await slot.findByText('Previously stopped by Guard');expect(slot.getByText(/not a count of threads currently blocked/)).toBeTruthy();
});

it('loads titles only when history is expanded and labels missing and untitled threads',async()=>{
 const status=guardFixture();status.stoppedThreadIds=['demo-named','demo-empty','demo-missing'];let reads=0;
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status},sdk:{threads:{get:async({threadId})=>{reads++;if(threadId==='demo-missing')throw new Error('unavailable');return {id:threadId,title:threadId==='demo-empty'?null:'Planning next release'} as never;}}}});
 await slot.findByText('Ранее остановлено Guard');expect(reads).toBe(0);fireEvent.click(slot.getByText('Ранее остановлено Guard'));
 await slot.findByRole('button',{name:'Planning next release'});expect(slot.getByRole('button',{name:'Без названия'})).toBeTruthy();
 expect(slot.getByText('Тред недоступен')).toBeTruthy();expect(slot.queryByRole('button',{name:/demo-/})).toBeNull();
});
it('bounds title lookups and stops queued reads when history closes',async()=>{
 const status=guardFixture();status.stoppedThreadIds=Array.from({length:12},(_,i)=>`demo-thread-${i}`);
 let reads=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status},sdk:{threads:{get:async({threadId})=>{reads++;await gate;return {id:threadId,title:'Late title'} as never;}}}});
 await slot.findByText('Ранее остановлено Guard');fireEvent.click(slot.getByText('Ранее остановлено Guard'));
 await waitFor(()=>expect(reads).toBe(4));fireEvent.click(slot.getByText('Ранее остановлено Guard'));
 await waitFor(()=>expect(slot.queryByText('Загружаем названия тредов…')).toBeNull());release();
 await new Promise(r=>setTimeout(r,10));expect(reads).toBe(4);expect(slot.queryByText('Late title')).toBeNull();
});
it('keeps the shared four-read limit after closing and reopening history',async()=>{
 const status=guardFixture();status.stoppedThreadIds=Array.from({length:8},(_,i)=>`demo-thread-${i}`);
 let reads=0;let running=0;let peak=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status},sdk:{threads:{get:async({threadId})=>{reads++;running++;peak=Math.max(peak,running);await gate;running--;return {id:threadId,title:'Named '+threadId} as never;}}}});
 await slot.findByText('Ранее остановлено Guard');fireEvent.click(slot.getByText('Ранее остановлено Guard'));await waitFor(()=>expect(reads).toBe(4));
 fireEvent.click(slot.getByText('Ранее остановлено Guard'));await waitFor(()=>expect(slot.queryByText('Загружаем названия тредов…')).toBeNull());
 fireEvent.click(slot.getByText('Ранее остановлено Guard'));await slot.findByText('Загружаем названия тредов…');expect(reads).toBe(4);
 release();await slot.findByRole('button',{name:'Named demo-thread-0'});expect(peak).toBe(4);
});

it('shows Continue for an unchanged owned stop and hides technical identifiers',async()=>{
 const status=guardFixture();status.stoppedThreadIds=['demo-stopped'];status.stopHistory=[{threadId:'demo-stopped',hostId:'demo-server',at:1000,reason:'manual_block'}];
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status,resumeThread:()=>({accepted:true})},sdk:{threads:{get:async()=>({title:'Interrupted work',status:'idle',updatedAt:999,queuedMessageCount:0}) as never}}});
 const history=await slot.findByText('Ранее остановлено Guard');fireEvent.click(history.closest('summary')!);fireEvent(history.closest('details')!,new Event('toggle'));
 fireEvent.click(await slot.findByRole('button',{name:'Продолжить'}));
 await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'resumeThread',input:{threadId:'demo-stopped',stoppedAt:1000}}));
 expect(slot.queryByText('demo-stopped')).toBeNull();
 await slot.findByRole('button',{name:'Запуск запрошен'});
});

it('allows Continue on its healthy host despite another host and unrelated native pause',async()=>{
 const status=guardFixture();status.hostIds.push('offline-host');status.hosts.push({id:'offline-host',name:'Offline',selected:true,available:false,vpn:'unknown',evidence:null});
 status.ownedDisabledPlugins=['provider-codex'];status.stoppedThreadIds=['demo-devin'];status.stopHistory=[{threadId:'demo-devin',hostId:'demo-server',at:1000,reason:'manual_block'}];
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status,resumeThread:()=>({accepted:true})},sdk:{threads:{get:async()=>({title:'Devin work',providerId:'acp-oxi-devin-pool',status:'idle',updatedAt:999,queuedMessageCount:0}) as never}}});
 fireEvent.click(await slot.findByText('Ранее остановлено Guard'));
 const resume=await slot.findByRole('button',{name:'Продолжить'}) as HTMLButtonElement;expect(resume.disabled).toBe(false);
 fireEvent.click(resume);await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'resumeThread',input:{threadId:'demo-devin',stoppedAt:1000}}));
});

it.each(['host','owned','ambiguous','manual'])('keeps Continue disabled for its own %s fence',async fence=>{
 const status=guardFixture();status.stoppedThreadIds=['demo-codex'];status.stopHistory=[{threadId:'demo-codex',hostId:'demo-server',at:1000,reason:'manual_block'}];
 if(fence==='host')status.hosts[0]!.vpn='unknown';if(fence==='owned')status.ownedDisabledPlugins=['provider-codex'];if(fence==='ambiguous')status.ambiguousPluginChanges=['provider-codex'];if(fence==='manual')status.manualBlock=true;
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status},sdk:{threads:{get:async()=>({title:'Codex work',providerId:'codex',status:'idle',updatedAt:999,queuedMessageCount:0}) as never}}});
 fireEvent.click(await slot.findByText('Ранее остановлено Guard'));
 expect((await slot.findByRole('button',{name:'Продолжить'}) as HTMLButtonElement).disabled).toBe(true);
});

it('offers Continue again for a new stop of the same thread',async()=>{
 let updatedAt=999;let title='Repeated work';let status=guardFixture();status.stoppedThreadIds=['demo-repeat'];status.stopHistory=[{threadId:'demo-repeat',hostId:'demo-server',at:1000,reason:'manual_block'}];
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status,resumeThread:()=>({accepted:true})},sdk:{threads:{get:async()=>({title,providerId:'codex',status:'idle',updatedAt,queuedMessageCount:0}) as never}}});
 fireEvent.click(await slot.findByText('Ранее остановлено Guard'));fireEvent.click(await slot.findByRole('button',{name:'Продолжить'}));
 await slot.findByRole('button',{name:'Запуск запрошен'});
 updatedAt=1999;title='Repeated work after second stop';
 status={...status,stopHistory:[...status.stopHistory!,{threadId:'demo-repeat',hostId:'demo-server',at:2000,reason:'manual_block'}]};
 fireEvent.click(slot.getByRole('button',{name:'Обновить статус'}));
 await slot.findByRole('button',{name:'Repeated work after second stop'});
 const resume=await slot.findByRole('button',{name:'Продолжить'}) as HTMLButtonElement;expect(resume.disabled).toBe(false);fireEvent.click(resume);
 await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'resumeThread',input:{threadId:'demo-repeat',stoppedAt:2000}}));
});
