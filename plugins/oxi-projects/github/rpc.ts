import {useMemo} from "react";
import {useRpc as useHostRpc,type PluginRpcClient,type PluginRpcContract} from "@get-bb/plugin-sdk/app";
export function useRpc<T extends PluginRpcContract>() {const rpc=useHostRpc();return useMemo(()=>({call:(method:string,input:unknown)=>rpc.call("github_"+method,input as any)}),[rpc]) as PluginRpcClient<T>;}
