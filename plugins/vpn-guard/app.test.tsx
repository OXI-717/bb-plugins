// @vitest-environment jsdom
import {cleanup,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {guardFixture} from './ui-fixture.js';
import {configurationSchema,rpcContract} from './contract.js';

const app=await loadPluginApp(()=>import('./app.js'));
afterEach(()=>{cleanup();localStorage.clear();});

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
  fail=true;fireEvent.click(slot.getByRole('button',{name:'Обновить'}));
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
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status}});
 await slot.findByText('Ранее остановлено Guard');
 expect(slot.getByText(/не число заблокированных сейчас/)).toBeTruthy();
 fireEvent.click(slot.getByText('Ранее остановлено Guard'));
 const button=slot.getByRole('button',{name:'Открыть тред demo-thread-a'});fireEvent.click(button);
 expect(slot.navigateCalls).toContainEqual(expect.objectContaining({method:'toThread',threadId:'demo-thread-a'}));
 expect(slot.rpcCalls.every(c=>c.method==='status')).toBe(true);
});
it('explains historical stops in English',async()=>{
 localStorage.setItem('vpn-guard-language','en');const status=guardFixture();status.stoppedThreadIds=['demo-thread-a'];
 const slot=renderSlot(app.navPanels[0]!,{subPath:''},{rpc:{status:()=>status}});
 await slot.findByText('Previously stopped by Guard');expect(slot.getByText(/not a count of threads currently blocked/)).toBeTruthy();
});
