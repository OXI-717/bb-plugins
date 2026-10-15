import {expect,it} from 'vitest';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {setupIntegrations} from './integrations-server';
it('starts independently with optional integrations off and makes no plugin lookup',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'oxi-projects'});
 try {
  const service=setupIntegrations(bb);
  expect(await service.enabled('memory')).toBe(false);
  expect(await harness.behavior.callRpc('integrationStatus',null)).toEqual({memory:false,autopilot:false,tasknotes:false});
  expect(harness.inspection.sdk.calls).toHaveLength(0);
  await expect(service.require('autopilot')).rejects.toThrow('выключено');
 } finally {await harness.lifecycle.dispose();}
});
it('preserves opt-in settings across reload and validates boolean changes',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'oxi-projects',settings:{enableMemory:true}});
 try {
  const service=setupIntegrations(bb);
  expect(await service.enabled('memory')).toBe(true);
  await harness.behavior.callRpc('saveIntegrations',{memory:true,autopilot:false,tasknotes:true});
  expect(await service.enabled('tasknotes')).toBe(true);
  await expect(harness.behavior.callRpc('saveIntegrations',{memory:'true',autopilot:false,tasknotes:true})).rejects.toThrow();
  const reloaded=await harness.lifecycle.reload(next=>{setupIntegrations(next);});
  expect(await reloaded.harness.behavior.callRpc('integrationStatus',null)).toEqual({memory:true,autopilot:false,tasknotes:true});
 } finally {await harness.lifecycle.dispose();}
});
it('disabled memory is refused before invoking the optional plugin',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'oxi-projects'});
 try {
  const service=setupIntegrations(bb);
  const {setupMemory}=await import('./memory-server');
  setupMemory(bb,()=>service.require('memory'));
  await expect(harness.behavior.callRpc('memoryInspect',{projectId:'proj_example'})).rejects.toThrow('выключено');
  expect(harness.inspection.sdk.calls).toHaveLength(0);
 } finally {await harness.lifecycle.dispose();}
});
