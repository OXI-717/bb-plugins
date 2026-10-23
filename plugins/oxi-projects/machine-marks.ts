import {z} from 'zod';

export const MACHINE_MARKS_SETTING='threadMachineMarks';
export const machineIcons={laptop:'Ноутбук',server:'Сервер',cloud:'Облако',desktop:'Монитор',terminal:'Терминал',globe:'Глобус',chip:'Процессор',database:'Хранилище'} as const;
export const machineKinds={local:'Локальный компьютер',primary:'Основной сервер',other:'Другая машина'} as const;
export const machineIconSchema=z.enum(['laptop','server','cloud','desktop','terminal','globe','chip','database']);
export const machineRoleSchema=z.object({kind:z.enum(['local','primary','other']),icon:machineIconSchema.optional()}).strict();
export const machineMarksConfigSchema=z.object({
 enabled:z.boolean(),
 hosts:z.record(z.string().regex(/^host_[A-Za-z0-9_-]+$/).max(100),machineRoleSchema).refine(value=>Object.keys(value).length<=200,'Слишком много машин (максимум 200)')
}).strict();
export type MachineMarksConfig=z.infer<typeof machineMarksConfigSchema>;
export type MachineRole=z.infer<typeof machineRoleSchema>;
export type MachineHost={id:string;name:string};
export type MachineMark={icon:keyof typeof machineIcons;label:string;kind:MachineRole['kind']};
export function machineMarkStyle(kind:MachineRole['kind']) {
 return {color:{local:'#6b93ac',primary:'#9a82a6',other:'#78998b'}[kind],backgroundColor:'transparent'};
}
export const defaultMachineMarksConfig:MachineMarksConfig={enabled:false,hosts:{}};
export function parseMachineMarksConfig(value:unknown):MachineMarksConfig|null {
 if(typeof value!=='string'||value.length>65536)return null;
 try {const result=machineMarksConfigSchema.safeParse(JSON.parse(value));return result.success?result.data:null;}catch{return null;}
}
export function resolveMachineMark(host:MachineHost|null|undefined,config:MachineMarksConfig|null):MachineMark|null {
 if(!host||!config?.enabled)return null;
 const role=Object.hasOwn(config.hosts,host.id)?config.hosts[host.id]:undefined;
 const kind=role?.kind??'other';
 const icon=role?.icon??({local:'laptop',primary:'server',other:'cloud'} as const)[kind];
 return {kind,icon,label:`${machineKinds[kind]} · ${host.name.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,160)}`};
}
