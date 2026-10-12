import {defineRpcContract,type PluginRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import {contract as github} from './github/contract';
import {rpcContract as autopilot} from './autopilot/contract';
export function prefix<T extends PluginRpcContract,P extends string>(contract:T,prefix:P):{[K in keyof T as `${P}${K & string}`]:T[K]} {
 return Object.fromEntries(Object.entries(contract).map(([key,value])=>[prefix+key,value])) as any;
}
export const workspaceContract=defineRpcContract({workspaceHosts:{input:z.null(),output:z.array(z.object({id:z.string(),name:z.string()}))},...prefix(github,'github_'),...prefix(autopilot,'autopilot_')});
