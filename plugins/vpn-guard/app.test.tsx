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
  const setting=await slot.findByRole('checkbox',{name:'Автоматически отключать встроенные плагины'});
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
