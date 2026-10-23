import {describe,expect,it} from 'vitest';
import {machineMarksConfigSchema,parseMachineMarksConfig,resolveMachineMark} from './machine-marks';

const config={enabled:true,hosts:{host_local:{kind:'local' as const},host_primary:{kind:'primary' as const},host_custom:{kind:'other' as const,icon:'terminal' as const}}};
describe('machine marks',()=>{
 it('uses stable host identities, not names, cwd or the BB server',()=>{
  expect(resolveMachineMark({id:'host_local',name:'Renamed'},config)).toEqual({icon:'💻',label:'Локальный компьютер · Renamed'});
  expect(resolveMachineMark({id:'host_primary',name:'Main'},config)?.icon).toBe('🖥️');
  expect(resolveMachineMark({id:'host_new',name:'Renamed'},config)?.icon).toBe('☁️');
 });
 it('offers an explicit palette and updates with host renames',()=>{
  expect(resolveMachineMark({id:'host_custom',name:'Other'},config)).toEqual({icon:'⌨️',label:'Другой сервер · Other'});
 });
 it('does not misclassify an unassigned environment as local',()=>{
  expect(resolveMachineMark(null,config)).toBeNull();
  expect(resolveMachineMark({id:'host_local',name:'Mac'},{...config,enabled:false})).toBeNull();
 });
 it('rejects invalid configuration and never turns malformed storage into enabled defaults',()=>{
  expect(parseMachineMarksConfig('{broken')).toBeNull();
  expect(parseMachineMarksConfig(JSON.stringify({...config,enabled:'yes'}))).toBeNull();
  expect(machineMarksConfigSchema.safeParse({...config,hosts:{host_x:{kind:'local',icon:'<svg>'}}}).success).toBe(false);
  expect(machineMarksConfigSchema.safeParse({...config,hosts:{bad:{kind:'local'}}}).success).toBe(false);
  expect(machineMarksConfigSchema.safeParse({...config,hosts:Object.fromEntries(Array.from({length:201},(_,i)=>[`host_${i}`,{kind:'other'}]))}).success).toBe(false);
 });
 it('keeps hostile host labels as plain bounded text',()=>{
  expect(resolveMachineMark({id:'host_local',name:'<img src=x onerror=alert(1)>'},config)?.label).toContain('<img');
 });
});
