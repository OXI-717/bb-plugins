import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {createHash} from 'node:crypto';
import {machineMarksContract} from './machine-marks-contract';
import {MACHINE_MARKS_SETTING,defaultMachineMarksConfig,parseMachineMarksConfig} from './machine-marks';

export function setupMachineMarks(bb:BbPluginApi){
 const settings=bb.settings.define({threadMachineMarks:{type:'string',label:'Значки машин у тредов',experimental_multiline:true,default:JSON.stringify(defaultMachineMarksConfig)}});
 const read=async()=>{const raw=(await settings.get())[MACHINE_MARKS_SETTING];return {config:parseMachineMarksConfig(raw),revision:createHash('sha256').update(raw).digest('hex')};};
 let queue:Promise<unknown>=Promise.resolve();
 bb.rpc.register(machineMarksContract,{
  machineMarksRead:async()=>{
   const value=await read();
   let hosts;try{hosts=await bb.sdk.hosts.list({signal:AbortSignal.timeout(5000)});}catch{throw Error('Не удалось получить список машин. Повторите загрузку.');}
   if(hosts.length>200)throw Error('Список содержит больше 200 машин. Настройки не изменены.');
   return {...value,hosts:hosts.map(h=>({id:h.id,name:h.name})),error:value.config?null:'Сохранённая настройка значков повреждена. Исправьте её перед включением.'};
  },
  machineMarksSave:async input=>{
   const task=queue.then(async()=>{
    if((await read()).revision!==input.revision)throw Error('Настройки изменились в другом окне. Загрузите их заново.');
    await settings.experimental_set({threadMachineMarks:JSON.stringify(input.config)});
    return {saved:true as const};
   });queue=task.catch(()=>{});return task;
  },
  machineMarkThread:async({threadId})=>{
   const signal=AbortSignal.timeout(5000);const thread=await bb.sdk.threads.get({threadId,signal});
   if(!thread.environmentId)return {host:null};
   const env=await bb.sdk.environments.get({environmentId:thread.environmentId,signal});
   const host=await bb.sdk.hosts.get({hostId:env.hostId,signal});return {host:{id:host.id,name:host.name}};
  }
 });
}
